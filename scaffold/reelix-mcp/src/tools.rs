//! MCP 工具注册表与实现。
//!
//! 每个工具都作用于「本进程里的一份工程副本」：读它、改它、回一个 JSON。
//! 工具自身失败走 `Err(中文原因)`，由上层包成 `isError: true` 的 content——
//! 这样客户端仍能读到原因，而不是只看到一个 JSON-RPC 错误码。
//!
//! 这里的实现**只做编排**，重活全部复用 `reelix_lib`（`default-features = false`
//! 拿得到的那批纯逻辑）：解码、曲线求值、拓扑排序都不在这里重造。
//!
//! 底线：不联网、不开端口、不自动落盘。只有 `save_project` 会写文件，
//! 而且写的是调用方明确给的路径。

use std::path::Path;
use std::process::Command;

use serde_json::{json, Value};

use reelix_lib::graph::catalog::{create_node, node_catalog};
use reelix_lib::graph::engine::{topo_order, GraphEngine};
use reelix_lib::graph::evaluator::DirtyTracker;
use reelix_lib::graph::node::{Connection, Graph, ParamValue};
use reelix_lib::keyframe::model::EasingPreset;
use reelix_lib::keyframe::store::KeyframeStore;
use reelix_lib::media::probe::{file_name_of, probe_path};
use reelix_lib::project::model::{Asset, Project};
use reelix_lib::project::serialize::{self, new_id};
use reelix_lib::timeline::model::{Clip, TrackKind};

/// 一条工具的说明与入参 schema。
pub struct Tool {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: Value,
}

/// 会话：一份工程 + 关键帧仓库 + 图求值缓存。
///
/// 这三个东西是「同一个工程」的三面，必须一起活在会话里，否则关键帧烘不进求值。
#[derive(Default)]
pub struct Session {
    project: Option<Project>,
    keyframes: KeyframeStore,
    engine: GraphEngine,
}

// ---------------------------------------------------------------- schema 小工具

fn schema(props: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": props,
        "required": required,
        "additionalProperties": false,
    })
}

fn p_str(desc: &str) -> Value {
    json!({ "type": "string", "description": desc })
}

fn p_num(desc: &str) -> Value {
    json!({ "type": "number", "description": desc })
}

fn p_bool(desc: &str) -> Value {
    json!({ "type": "boolean", "description": desc })
}

/// 图 id 是可选参数，缺省落在主序列的根图上。
fn graph_id_prop() -> (&'static str, Value) {
    ("graphId", p_str("要操作的图 id；缺省落在主序列的根图上"))
}

// ---------------------------------------------------------------- 入参取值

fn need_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("缺少参数「{key}」，或者它不是字符串"))
}

fn need_f64(args: &Value, key: &str) -> Result<f64, String> {
    args.get(key)
        .and_then(|v| v.as_f64())
        .ok_or_else(|| format!("缺少参数「{key}」，或者它不是数字"))
}

fn opt_f64(args: &Value, key: &str, fallback: f64) -> f64 {
    args.get(key).and_then(|v| v.as_f64()).unwrap_or(fallback)
}

/// 取一个必须存在的数字参数（没有返回 None）。
fn opt_f64_required(args: &Value, key: &str) -> Option<f64> {
    args.get(key).and_then(Value::as_f64)
}

fn opt_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(Value::as_bool)
}

fn opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

/// JSON 值 → 参数值。只认布尔 / 数字 / 字符串，与前端 `ParamValue` 三种一致。
fn json_to_param(value: &Value) -> Result<ParamValue, String> {
    match value {
        Value::Bool(b) => Ok(ParamValue::Bool(*b)),
        Value::Number(n) => n
            .as_f64()
            .map(ParamValue::Number)
            .ok_or_else(|| "参数值数字超出可表示范围".to_string()),
        Value::String(s) => Ok(ParamValue::Text(s.clone())),
        _ => Err("参数值只能是布尔、数字或字符串".to_string()),
    }
}

fn parse_easing(s: &str) -> Option<EasingPreset> {
    match s {
        "linear" | "Linear" => Some(EasingPreset::Linear),
        "ease-in" | "easeIn" | "EaseIn" => Some(EasingPreset::EaseIn),
        "ease-out" | "easeOut" | "EaseOut" => Some(EasingPreset::EaseOut),
        "ease-in-out" | "easeInOut" | "EaseInOut" => Some(EasingPreset::EaseInOut),
        "bounce" | "Bounce" => Some(EasingPreset::Bounce),
        "elastic" | "Elastic" => Some(EasingPreset::Elastic),
        // 自定义贝塞尔：配合 outTangentX/Y、inTangentX/Y 四个控制柄
        "custom" | "Custom" | "bezier" => Some(EasingPreset::Custom),
        _ => None,
    }
}

// ---------------------------------------------------------------- 会话辅助

impl Session {
    fn project(&self) -> Result<&Project, String> {
        self.project
            .as_ref()
            .ok_or_else(|| "还没有工程，先调 new_project 或 open_project".to_string())
    }

    fn project_mut(&mut self) -> Result<&mut Project, String> {
        self.project
            .as_mut()
            .ok_or_else(|| "还没有工程，先调 new_project 或 open_project".to_string())
    }

    /// 主序列的根图 id。
    fn root_graph_id(&self) -> Result<String, String> {
        let project = self.project()?;
        let seq = project
            .sequences
            .first()
            .ok_or_else(|| "工程里没有序列".to_string())?;
        Ok(seq.root_graph_id.clone())
    }

    /// 取一张图；`graph_id` 为 None 时用根图。
    fn graph_mut(&mut self, graph_id: Option<String>) -> Result<&mut Graph, String> {
        let gid = match graph_id {
            Some(g) => g,
            None => self.root_graph_id()?,
        };
        self.project_mut()?
            .graphs
            .get_mut(&gid)
            .ok_or_else(|| format!("找不到图「{gid}」"))
    }

    /// 找某节点上某个静态参数值（没打关键帧时用它）。
    fn static_param(&self, target_id: &str, param: &str) -> Option<f64> {
        let project = self.project.as_ref()?;
        for graph in project.graphs.values() {
            if let Some(node) = graph.nodes.iter().find(|n| n.id == target_id) {
                return node.param(param).and_then(|v| v.as_f64());
            }
        }
        None
    }
}

// ---------------------------------------------------------------- 工具目录

/// 全部工具的定义，供 `tools/list` 返回。
pub fn catalog() -> Vec<Tool> {
    let (graph_key, graph_val) = graph_id_prop();
    vec![
        Tool {
            name: "get_project",
            description: "读当前工程的完整快照：项目 / 序列 / 轨道 / 片段 / 素材 / 图，外加全部关键帧曲线。",
            schema: schema(json!({}), &[]),
        },
        Tool {
            name: "list_assets",
            description: "列出工程里的素材（磁盘源文件的登记表）。",
            schema: schema(json!({}), &[]),
        },
        Tool {
            name: "get_timeline",
            description: "列出全部序列，含轨道与轨道上的片段。",
            schema: schema(json!({}), &[]),
        },
        Tool {
            name: "get_graph",
            description: "读一张合成图：节点、参数、连线。缺省读主序列的根图。",
            schema: schema(json!({ graph_key: graph_val.clone() }), &[]),
        },
        Tool {
            name: "list_node_types",
            description: "列出内置节点类型（效果清单）：类型键、中文名、分类、插槽、默认参数。",
            schema: schema(json!({}), &[]),
        },
        Tool {
            name: "add_node",
            description: "往图里加一个节点，返回它的 id。类型键见 list_node_types。",
            schema: schema(
                json!({
                    "nodeType": p_str("节点类型键，例如 blur / grade / keyer"),
                    "x": p_num("节点在画布上的横坐标，可选"),
                    "y": p_num("节点在画布上的纵坐标，可选"),
                    graph_key: graph_val.clone(),
                }),
                &["nodeType"],
            ),
        },
        Tool {
            name: "connect",
            description: "把源节点的某个输出插槽接到目标节点的某个输入插槽上。同一输入只保留一条入线。",
            schema: schema(
                json!({
                    "fromNode": p_str("源节点 id"),
                    "fromPlug": p_str("源节点的输出插槽 key"),
                    "toNode": p_str("目标节点 id"),
                    "toPlug": p_str("目标节点的输入插槽 key"),
                    graph_key: graph_val.clone(),
                }),
                &["fromNode", "fromPlug", "toNode", "toPlug"],
            ),
        },
        Tool {
            name: "set_node_param",
            description: "改某个节点的一个参数。值可以是数字、布尔或字符串。",
            schema: schema(
                json!({
                    "nodeId": p_str("节点 id"),
                    "param": p_str("参数名，例如 radius / color / opacity"),
                    "value": json!({ "description": "参数值：数字 / 布尔 / 字符串" }),
                    graph_key: graph_val.clone(),
                }),
                &["nodeId", "param", "value"],
            ),
        },
        Tool {
            name: "set_keyframe",
            description: "在某目标（节点 id 或片段 id）的某参数上，于某时刻打一个关键帧；同刻已存在则覆盖。",
            schema: schema(
                json!({
                    "targetId": p_str("目标 id：节点 id 或片段 id"),
                    "param": p_str("参数名"),
                    "timeMs": p_num("时刻，毫秒"),
                    "value": p_num("该时刻的取值"),
                    "easing": p_str("缓动：linear / ease-in / ease-out / ease-in-out / bounce / elastic / custom，缺省 linear"),
                    "outTangentX": p_num("贝塞尔出切线控制柄 x（0~1，easing=custom 时生效）"),
                    "outTangentY": p_num("贝塞尔出切线控制柄 y（0~1）"),
                    "inTangentX": p_num("贝塞尔入切线控制柄 x（0~1）"),
                    "inTangentY": p_num("贝塞尔入切线控制柄 y（0~1）"),
                }),
                &["targetId", "param", "timeMs", "value"],
            ),
        },
        Tool {
            name: "evaluate_param",
            description: "求某目标某参数在某时刻的值。有关键帧走曲线求值；没有则回落到节点上的静态参数。",
            schema: schema(
                json!({
                    "targetId": p_str("目标 id"),
                    "param": p_str("参数名"),
                    "timeMs": p_num("时刻，毫秒"),
                }),
                &["targetId", "param", "timeMs"],
            ),
        },
        Tool {
            name: "evaluate_frame",
            description: "把关键帧烘到图上，再按拓扑序求值一帧，返回求值顺序与命中缓存数。用于确认图没有环。",
            schema: schema(
                json!({
                    "timeMs": p_num("要烘入的时刻，毫秒"),
                    graph_key: graph_val.clone(),
                }),
                &["timeMs"],
            ),
        },
        Tool {
            name: "new_project",
            description: "新建一份空工程（1920×1080 / 25fps，一条视频轨、一条音频轨，根图预置序列与输出）。会清掉当前工程。",
            schema: schema(json!({ "name": p_str("工程名，可选") }), &[]),
        },
        Tool {
            name: "save_project",
            description: "把当前工程写到磁盘上的指定路径（会创建父目录）。这是唯一会写文件的工具。",
            schema: schema(json!({ "path": p_str("目标文件路径，通常是 .reelix") }), &["path"]),
        },
        Tool {
            name: "open_project",
            description: "从磁盘读一份工程，替换掉当前会话里的工程。",
            schema: schema(json!({ "path": p_str("工程文件路径") }), &["path"]),
        },
        Tool {
            name: "import_media",
            description: "探测一个媒体文件并登记为素材；默认同时把它作为片段铺到时间线上。",
            schema: schema(
                json!({
                    "path": p_str("媒体文件路径"),
                    "addToTimeline": p_bool("是否同时作为片段铺到时间线上，缺省 true"),
                }),
                &["path"],
            ),
        },
        Tool {
            name: "probe_media",
            description: "只探测一个媒体文件，不登记进工程：时长、分辨率、帧率、编码、有无音轨。",
            schema: schema(json!({ "path": p_str("媒体文件路径") }), &["path"]),
        },
        // ---- AI 剪辑工具组（片段 / 轨道 / 转场 / 编组 / 3D / 字幕） ----
        Tool {
            name: "add_clip",
            description: "把一个素材作为片段铺到时间线（自动落对轨：视频→V、音频→A）。",
            schema: schema(
                json!({
                    "assetId": p_str("素材 id（list_assets 拿）"),
                    "trackId": p_str("目标轨道 id；缺省自动选"),
                    "startMs": p_num("起始毫秒；缺省追加到该轨末尾"),
                    "durationMs": p_num("时长毫秒；缺省用素材全长"),
                }),
                &["assetId"],
            ),
        },
        Tool {
            name: "move_clip",
            description: "移动片段到新时刻 / 新轨道。",
            schema: schema(
                json!({
                    "clipId": p_str("片段 id"),
                    "startMs": p_num("新起始毫秒"),
                    "trackId": p_str("新轨道 id，可选"),
                }),
                &["clipId"],
            ),
        },
        Tool {
            name: "trim_clip",
            description: "裁剪片段：改入点 / 出点 / 起始时刻（会同步时长）。",
            schema: schema(
                json!({
                    "clipId": p_str("片段 id"),
                    "inMs": p_num("新入点（素材内毫秒）"),
                    "outMs": p_num("新出点（素材内毫秒）"),
                    "startMs": p_num("新起始毫秒，可选"),
                }),
                &["clipId"],
            ),
        },
        Tool {
            name: "split_clip",
            description: "在指定时刻把片段切成两段（时刻默认用播放头，但本工具是离线会话，必须显式给）。",
            schema: schema(
                json!({ "clipId": p_str("片段 id"), "atMs": p_num("切割时刻（毫秒）") }),
                &["clipId", "atMs"],
            ),
        },
        Tool {
            name: "delete_clip",
            description: "从时间线删除片段。",
            schema: schema(json!({ "clipId": p_str("片段 id") }), &["clipId"]),
        },
        Tool {
            name: "set_transition",
            description: "给片段加入场转场：crossDissolve / dipToBlack / dipToWhite / slidePush / slidePull / wipeLinear / wipeRadial / wipeBlinds / zoomCross；kind 传 none 清除。",
            schema: schema(
                json!({
                    "clipId": p_str("片段 id"),
                    "kind": p_str("转场类型，none = 清除"),
                    "durationMs": p_num("转场时长毫秒，缺省 500"),
                }),
                &["clipId", "kind"],
            ),
        },
        Tool {
            name: "add_track",
            description: "新增一条轨道（video / audio / subtitle / camera）。",
            schema: schema(json!({ "kind": p_str("轨道类型") }), &["kind"]),
        },
        Tool {
            name: "nest_clips",
            description: "把多个片段合并成一个编组（compound），整体移动与变换。",
            schema: schema(json!({ "clipIds": p_str("片段 id 数组，至少 2 个") }), &["clipIds"]),
        },
        Tool {
            name: "set_clip_3d",
            description: "启用 / 关闭片段 3D，或改其 XYZ 位置 / 缩放 / Z 旋转（度）。",
            schema: schema(
                json!({
                    "clipId": p_str("片段 id"),
                    "enabled": p_bool("是否启用 3D"),
                    "x": p_num("位置 X（像素）"),
                    "y": p_num("位置 Y（像素）"),
                    "z": p_num("位置 Z（景深用）"),
                    "scale": p_num("缩放，1 = 原大"),
                    "rotationZ": p_num("Z 轴旋转（度）"),
                }),
                &["clipId"],
            ),
        },
        Tool {
            name: "add_subtitle",
            description: "在字幕轨加一条字幕（没有字幕轨会自动建）。",
            schema: schema(
                json!({
                    "text": p_str("字幕文字"),
                    "startMs": p_num("起始毫秒"),
                    "durationMs": p_num("时长毫秒，缺省 3000"),
                }),
                &["text", "startMs"],
            ),
        },
        Tool {
            name: "set_sequence",
            description: "改主序列的画幅、帧率、时长（宣传片复刻要 1920×1080/30fps，而新建工程默认是 25fps）。",
            schema: schema(
                json!({
                    "width": p_num("画面宽，像素"),
                    "height": p_num("画面高，像素"),
                    "frameRate": p_num("帧率，例如 30"),
                    "durationMs": p_num("序列时长，毫秒"),
                }),
                &[],
            ),
        },
        Tool {
            name: "render_video",
            description: "把一份已保存的 .reelix 工程渲染成高清视频（走主程序同一条导出管线，含音频混音与字幕烧录）。",
            schema: schema(
                json!({
                    "projectPath": p_str("工程文件路径（先用 save_project 落盘）"),
                    "outputPath": p_str("输出视频路径，例如 D:/out.mp4"),
                    "preset": p_str("导出预设：h264-1080p / h265-4k / h264-720p-proxy，缺省 h264-1080p"),
                    "startMs": p_num("可选，导出起点毫秒（缺省 0）"),
                    "endMs": p_num("可选，导出终点毫秒（缺省到序列末尾）"),
                }),
                &["projectPath", "outputPath"],
            ),
        },
    ]
}

// ---------------------------------------------------------------- 分派

/// 执行一个工具调用。`Err` 是中文原因，上层包成 `isError: true`。
pub fn call(session: &mut Session, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "get_project" => get_project(session),
        "list_assets" => list_assets(session),
        "get_timeline" => get_timeline(session),
        "get_graph" => get_graph(session, args),
        "list_node_types" => list_node_types(),
        "add_node" => add_node(session, args),
        "connect" => connect(session, args),
        "set_node_param" => set_node_param(session, args),
        "set_keyframe" => set_keyframe(session, args),
        "evaluate_param" => evaluate_param(session, args),
        "evaluate_frame" => evaluate_frame(session, args),
        "new_project" => new_project(session, args),
        "save_project" => save_project(session, args),
        "open_project" => open_project(session, args),
        "import_media" => import_media(session, args),
        "probe_media" => probe_media(args),
        "add_clip" => add_clip(session, args),
        "move_clip" => move_clip(session, args),
        "trim_clip" => trim_clip(session, args),
        "split_clip" => split_clip(session, args),
        "delete_clip" => delete_clip(session, args),
        "set_transition" => mcp_set_transition(session, args),
        "add_track" => mcp_add_track(session, args),
        "nest_clips" => mcp_nest_clips(session, args),
        "set_clip_3d" => mcp_set_clip_3d(session, args),
        "add_subtitle" => mcp_add_subtitle(session, args),
        "set_sequence" => set_sequence(session, args),
        "render_video" => render_video(args),
        other => Err(format!("未知工具：{other}")),
    }
}

// ---------------------------------------------------------------- 工具实现

fn get_project(session: &Session) -> Result<Value, String> {
    let project = session.project()?;
    let project =
        serde_json::to_value(project).map_err(|e| format!("序列化工程失败：{e}"))?;
    let curves = serde_json::to_value(session.keyframes.curves())
        .map_err(|e| format!("序列化关键帧失败：{e}"))?;
    Ok(json!({ "project": project, "keyframes": curves }))
}

fn list_assets(session: &Session) -> Result<Value, String> {
    let project = session.project()?;
    serde_json::to_value(&project.assets).map_err(|e| format!("序列化素材失败：{e}"))
}

fn get_timeline(session: &Session) -> Result<Value, String> {
    let project = session.project()?;
    serde_json::to_value(&project.sequences).map_err(|e| format!("序列化时间线失败：{e}"))
}

fn get_graph(session: &Session, args: &Value) -> Result<Value, String> {
    let project = session.project()?;
    let gid = match opt_str(args, "graphId") {
        Some(g) => g,
        None => project
            .sequences
            .first()
            .ok_or_else(|| "工程里没有序列".to_string())?
            .root_graph_id
            .clone(),
    };
    let graph = project
        .graphs
        .get(&gid)
        .ok_or_else(|| format!("找不到图「{gid}」"))?;
    serde_json::to_value(graph).map_err(|e| format!("序列化图失败：{e}"))
}

fn list_node_types() -> Result<Value, String> {
    serde_json::to_value(node_catalog()).map_err(|e| format!("序列化节点目录失败：{e}"))
}

fn add_node(session: &mut Session, args: &Value) -> Result<Value, String> {
    let node_type = need_str(args, "nodeType")?;
    let x = opt_f64(args, "x", 0.0);
    let y = opt_f64(args, "y", 0.0);
    let node = create_node(&node_type, x, y).ok_or_else(|| {
        format!("没有「{node_type}」这种节点，先用 list_node_types 看看有哪些")
    })?;
    let snapshot = serde_json::to_value(&node).map_err(|e| format!("序列化节点失败：{e}"))?;
    session
        .graph_mut(opt_str(args, "graphId"))?
        .nodes
        .push(node);
    Ok(json!({ "node": snapshot }))
}

fn connect(session: &mut Session, args: &Value) -> Result<Value, String> {
    let from_node = need_str(args, "fromNode")?;
    let from_plug = need_str(args, "fromPlug")?;
    let to_node = need_str(args, "toNode")?;
    let to_plug = need_str(args, "toPlug")?;

    let graph = session.graph_mut(opt_str(args, "graphId"))?;
    if graph.node(&from_node).is_none() {
        return Err(format!("找不到源节点「{from_node}」"));
    }
    if graph.node(&to_node).is_none() {
        return Err(format!("找不到目标节点「{to_node}」"));
    }

    // 一个输入插槽只吃一条线，先清掉旧的，免得求值时歧义。
    graph
        .connections
        .retain(|c| !(c.to_node == to_node && c.to_plug == to_plug));

    let conn = Connection {
        id: new_id("conn"),
        from_node: from_node.clone(),
        from_plug: from_plug.clone(),
        to_node: to_node.clone(),
        to_plug: to_plug.clone(),
    };
    let snapshot =
        serde_json::to_value(&conn).map_err(|e| format!("序列化连线失败：{e}"))?;
    graph.connections.push(conn);

    // 顺手把两端的插槽标成「已连接」，让数据自洽。
    mark_plug_connected(graph, &from_node, &from_plug, false);
    mark_plug_connected(graph, &to_node, &to_plug, true);

    Ok(json!({ "connection": snapshot }))
}

fn mark_plug_connected(graph: &mut Graph, node_id: &str, plug_key: &str, is_input: bool) {
    let Some(node) = graph.node_mut(node_id) else {
        return;
    };
    let plugs = if is_input {
        &mut node.inputs
    } else {
        &mut node.outputs
    };
    if let Some(plug) = plugs.iter_mut().find(|p| p.key == plug_key) {
        plug.connected = true;
    }
}

fn set_node_param(session: &mut Session, args: &Value) -> Result<Value, String> {
    let node_id = need_str(args, "nodeId")?;
    let param = need_str(args, "param")?;
    let raw = args
        .get("value")
        .ok_or_else(|| "缺少参数「value」".to_string())?;
    let value = json_to_param(raw)?;

    let graph = session.graph_mut(opt_str(args, "graphId"))?;
    let node = graph
        .node_mut(&node_id)
        .ok_or_else(|| format!("找不到节点「{node_id}」"))?;
    node.set_param(&param, value);
    Ok(json!({ "nodeId": node_id, "param": param, "ok": true }))
}

fn set_keyframe(session: &mut Session, args: &Value) -> Result<Value, String> {
    let target_id = need_str(args, "targetId")?;
    let param = need_str(args, "param")?;
    let time_ms = need_f64(args, "timeMs")?;
    let value = need_f64(args, "value")?;
    let easing = match opt_str(args, "easing") {
        Some(s) => parse_easing(&s).ok_or_else(|| {
            format!(
                "认不出缓动「{s}」，可选：linear / ease-in / ease-out / ease-in-out / bounce / elastic"
            )
        })?,
        None => EasingPreset::Linear,
    };

    let keyframe = session
        .keyframes
        .set_keyframe(&target_id, &param, time_ms, value, easing);
    let kid = keyframe.id.clone();

    // 贝塞尔控制柄（可选）。easing=custom 时它们才是真正参与求值的 P1/P2。
    let tangent = |prefix: &str| -> Option<(f64, f64)> {
        let x = args.get(&format!("{prefix}X"))?.as_f64()?;
        let y = args.get(&format!("{prefix}Y"))?.as_f64()?;
        Some((x, y))
    };
    if let Some((x, y)) = tangent("outTangent") {
        session.keyframes.set_tangent(&kid, false, x, y);
    }
    if let Some((x, y)) = tangent("inTangent") {
        session.keyframes.set_tangent(&kid, true, x, y);
    }

    // 切线写完要重读，否则返回的还是旧值
    let stored = session
        .keyframes
        .curves()
        .into_iter()
        .find(|c| c.target_id == target_id && c.param == param)
        .and_then(|c| c.keyframes.into_iter().find(|k| k.id == kid))
        .unwrap_or(keyframe);
    serde_json::to_value(&stored).map_err(|e| format!("序列化关键帧失败：{e}"))
}

fn evaluate_param(session: &Session, args: &Value) -> Result<Value, String> {
    let target_id = need_str(args, "targetId")?;
    let param = need_str(args, "param")?;
    let time_ms = need_f64(args, "timeMs")?;

    if let Some(v) = session.keyframes.evaluate(&target_id, &param, time_ms) {
        return Ok(json!({ "value": v, "animated": true }));
    }
    Ok(json!({
        "value": session.static_param(&target_id, &param),
        "animated": false,
        "note": "该参数上没有关键帧，value 是节点上的静态值（可能为 null）"
    }))
}

fn evaluate_frame(session: &mut Session, args: &Value) -> Result<Value, String> {
    let time_ms = need_f64(args, "timeMs")?;
    let gid = match opt_str(args, "graphId") {
        Some(g) => g,
        None => session.root_graph_id()?,
    };

    // 拆开三个字段分别借用，才能「一边烘关键帧、一边握着图」。
    let Session {
        project,
        keyframes,
        engine,
    } = session;

    let project = project
        .as_mut()
        .ok_or_else(|| "还没有工程，先调 new_project 或 open_project".to_string())?;
    let graph = project
        .graphs
        .get_mut(&gid)
        .ok_or_else(|| format!("找不到图「{gid}」"))?;

    // 顺序不能反：先把曲线烘成参数，再算拓扑序与缓存指纹，否则旧画面会被误命中。
    let baked = keyframes.bake_graph(graph, time_ms);
    let order = topo_order(graph).map_err(|e| format!("{e}"))?;

    let mut dirty = DirtyTracker::new();
    dirty.mark_many(order.iter().map(String::as_str));
    let report = engine
        .evaluate(graph, &mut dirty)
        .map_err(|e| format!("{e}"))?;

    Ok(json!({
        "graphId": gid,
        "timeMs": time_ms,
        "baked": baked,
        "order": order,
        "evaluated": report.evaluated_count(),
        "reused": report.reused_count(),
    }))
}

fn new_project(session: &mut Session, args: &Value) -> Result<Value, String> {
    let name = opt_str(args, "name").unwrap_or_else(|| "未命名工程".to_string());
    let project = serialize::new_project(&name);
    let id = project.id.clone();
    let sequences = project.sequences.len();

    session.project = Some(project);
    session.keyframes.clear();
    session.engine.clear();

    Ok(json!({ "projectId": id, "name": name, "sequences": sequences }))
}

fn save_project(session: &mut Session, args: &Value) -> Result<Value, String> {
    let path = need_str(args, "path")?;
    // 关键帧必须随工程落盘：以前这里只存了 project，曲线留在会话内存里，
    // 一保存就丢——MCP 打的所有动画（刻度旋转、发光脉冲、文字淡入）
    // 到了导出端全都读不到，成片永远是静止的。
    let curves = session.keyframes.curves();
    let curve_count = curves.len();
    let project = session.project_mut()?;
    project.modified_at = serialize::now_ms();
    project.curves = curves;
    serialize::save(Path::new(&path), project)?;
    Ok(json!({ "saved": true, "path": path, "keyframes": curve_count }))
}

fn open_project(session: &mut Session, args: &Value) -> Result<Value, String> {
    let path = need_str(args, "path")?;
    let project = serialize::load(Path::new(&path))?;
    let id = project.id.clone();
    let name = project.name.clone();
    let sequences = project.sequences.len();
    let curves = project.curves.clone();

    session.project = Some(project);
    // 打开工程时把曲线读回会话，否则接着编辑会看不到原来的动画
    session.keyframes.clear();
    session.keyframes.load_curves(curves);
    session.engine.clear();

    Ok(json!({ "projectId": id, "name": name, "sequences": sequences }))
}

fn import_media(session: &mut Session, args: &Value) -> Result<Value, String> {
    let path = need_str(args, "path")?;
    let add_to_timeline = args
        .get("addToTimeline")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let info = probe_path(&path);
    let asset_id = new_id("asset");

    let project = session.project_mut()?;
    project.assets.push(Asset {
        id: asset_id.clone(),
        path: path.clone(),
        name: file_name_of(&path),
        kind: info.kind,
        duration_ms: info.duration_ms,
        width: info.width,
        height: info.height,
        frame_rate: info.frame_rate,
        codec: info.codec.clone(),
        has_audio: info.has_audio,
        missing: false,
        bin_id: None,
    });

    let mut clip_id: Option<String> = None;
    if add_to_timeline {
        let want = match info.kind {
            reelix_lib::project::model::AssetKind::Audio => TrackKind::Audio,
            _ => TrackKind::Video,
        };
        // 素材探不到时长时给一个保守的 5 秒，别造出零长片段。
        let duration = if info.duration_ms > 0.0 {
            info.duration_ms
        } else {
            5000.0
        };

        let seq = project
            .sequences
            .first_mut()
            .ok_or_else(|| "工程里没有序列".to_string())?;

        let start;
        {
            // 先定轨道下标，再取可变引用——两处同时借 `tracks` 会编译不过。
            let index = seq
                .tracks
                .iter()
                .position(|t| t.kind == want)
                .or_else(|| seq.tracks.first().map(|_| 0))
                .ok_or_else(|| "序列里没有轨道".to_string())?;
            let track = &mut seq.tracks[index];
            // 排在已有片段之后，不重叠。
            start = track
                .clips
                .iter()
                .map(Clip::end_ms)
                .fold(0.0_f64, f64::max);

            let clip = Clip {
                id: new_id("clip"),
                asset_id: asset_id.clone(),
                track_id: track.id.clone(),
                start_ms: start,
                duration_ms: duration,
                in_ms: 0.0,
                out_ms: duration,
                speed: 1.0,
                reversed: false,
                // 占位节点 id：真建节点由剪辑与特效融合那步负责。
                node_id: new_id("node"),
                compound_id: None,
                enable_3d: false,
                transform_3d: None,
                transition_in: None,
                speed_curve: None,
                audio_pitch_shift: false,
                transition_out: None,
                audio_fade_in_ms: None,
                audio_fade_out_ms: None,
                audio_highpass_hz: None,
                audio_lowpass_hz: None,
                audio_delay_ms: None,
                text: None,
                label: None,
                enabled: true,
            };
            clip_id = Some(clip.id.clone());
            track.clips.push(clip);
        }
        seq.duration_ms = seq.duration_ms.max(start + duration);
    }

    Ok(json!({
        "assetId": asset_id,
        "name": file_name_of(&path),
        "kind": info.kind,
        "clipId": clip_id,
        "hasAudio": info.has_audio,
    }))
}


// ---------------------------------------------------------------- AI 剪辑工具实现

/// 找片段所在轨与下标。
fn locate_clip(project: &Project, clip_id: &str) -> Result<(String, usize), String> {
    for seq in &project.sequences {
        for track in &seq.tracks {
            if let Some(i) = track.clips.iter().position(|c| c.id == clip_id) {
                return Ok((track.id.clone(), i));
            }
        }
    }
    Err(format!("找不到片段「{clip_id}」"))
}

/// 给素材选一条合适的轨：指定轨类型匹配就用；否则找同类型第一条未锁轨。
fn pick_track_for_asset(project: &Project, asset_kind: &str, prefer: Option<&str>) -> Option<String> {
    let want: TrackKind = if asset_kind == "audio" {
        TrackKind::Audio
    } else {
        TrackKind::Video
    };
    let seq = project.sequences.first()?;
    if let Some(id) = prefer {
        if let Some(t) = seq.tracks.iter().find(|t| t.id == id && t.kind == want && !t.locked) {
            return Some(t.id.clone());
        }
    }
    seq.tracks
        .iter()
        .find(|t| t.kind == want && !t.locked)
        .map(|t| t.id.clone())
}

fn add_clip(session: &mut Session, args: &Value) -> Result<Value, String> {
    let asset_id = need_str(args, "assetId")?;
    let project = session.project_mut()?;
    let asset = project
        .assets
        .iter()
        .find(|a| a.id == asset_id)
        .ok_or_else(|| format!("找不到素材「{asset_id}」"))?
        .clone();
    let kind = format!("{:?}", asset.kind).to_lowercase();
    let track_id = pick_track_for_asset(project, &kind, opt_str(args, "trackId").as_deref())
        .ok_or_else(|| "没有可用的轨道".to_string())?;
    let duration = opt_f64(args, "durationMs", asset.duration_ms);
    let start = match opt_f64_required(args, "startMs") {
        Some(v) => v,
        None => {
            // 缺省：追加到该轨末尾
            let seq = &project.sequences[0];
            let track = seq.tracks.iter().find(|t| t.id == track_id).ok_or("轨道消失")?;
            track
                .clips
                .iter()
                .map(|c| c.start_ms + c.duration_ms)
                .fold(0.0, f64::max)
        }
    };
    let clip = Clip {
        id: new_id("clip"),
        asset_id,
        track_id: track_id.clone(),
        start_ms: start,
        duration_ms: duration.max(1.0),
        in_ms: 0.0,
        out_ms: duration.max(1.0),
        speed: 1.0,
        reversed: false,
        node_id: String::new(),
        compound_id: None,
        enable_3d: false,
        transform_3d: None,
        transition_in: None,
        speed_curve: None,
        audio_pitch_shift: false,
        transition_out: None,
        audio_fade_in_ms: None,
        audio_fade_out_ms: None,
        audio_highpass_hz: None,
        audio_lowpass_hz: None,
        audio_delay_ms: None,
        text: None,
        label: None,
        enabled: true,
    };
    let seq = &mut project.sequences[0];
    let track = seq
        .tracks
        .iter_mut()
        .find(|t| t.id == track_id)
        .ok_or("轨道消失")?;
    track.clips.push(clip.clone());
    track.clips
        .sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap_or(std::cmp::Ordering::Equal));
    Ok(json!({ "clipId": clip.id, "trackId": track_id, "startMs": clip.start_ms }))
}

fn move_clip(session: &mut Session, args: &Value) -> Result<Value, String> {
    let clip_id = need_str(args, "clipId")?;
    let project = session.project_mut()?;
    let (track_id, idx) = locate_clip(project, &clip_id)?;
    {
        let seq = &mut project.sequences[0];
        let track = seq.tracks.iter_mut().find(|t| t.id == track_id).ok_or("轨道消失")?;
        let c = track.clips.get_mut(idx).ok_or("片段消失")?;
        if let Some(v) = opt_f64_required(args, "startMs") {
            c.start_ms = v.max(0.0);
        }
    }
    // 换轨
    if let Some(to) = opt_str(args, "trackId") {
        let seq = &mut project.sequences[0];
        let src_kind = seq
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .map(|t| t.kind.clone());
        let removed = {
            let src = seq.tracks.iter_mut().find(|t| t.id == track_id).ok_or("源轨消失")?;
            src.clips.remove(idx)
        };
        if let Some(dst) = seq
            .tracks
            .iter_mut()
            .find(|t| t.id == to && Some(t.kind.clone()) == src_kind)
        {
            dst.clips.push(removed);
            dst.clips.sort_by(|a, b| {
                a.start_ms.partial_cmp(&b.start_ms).unwrap_or(std::cmp::Ordering::Equal)
            });
        }
    }
    Ok(json!({ "ok": true }))
}

fn trim_clip(session: &mut Session, args: &Value) -> Result<Value, String> {
    let clip_id = need_str(args, "clipId")?;
    let project = session.project_mut()?;
    let (track_id, idx) = locate_clip(project, &clip_id)?;
    let seq = &mut project.sequences[0];
    let track = seq.tracks.iter_mut().find(|t| t.id == track_id).ok_or("轨道消失")?;
    let c = track.clips.get_mut(idx).ok_or("片段消失")?;
    if let Some(v) = opt_f64_required(args, "startMs") {
        c.start_ms = v.max(0.0);
    }
    if let Some(v) = opt_f64_required(args, "inMs") {
        c.in_ms = v.max(0.0);
    }
    if let Some(v) = opt_f64_required(args, "outMs") {
        c.out_ms = v.max(c.in_ms + 1.0);
    }
    c.duration_ms = c.out_ms - c.in_ms;
    Ok(json!({ "ok": true, "durationMs": c.duration_ms }))
}

fn split_clip(session: &mut Session, args: &Value) -> Result<Value, String> {
    let clip_id = need_str(args, "clipId")?;
    let at = opt_f64_required(args, "atMs").ok_or("split_clip 需要 atMs")?;
    let project = session.project_mut()?;
    let (track_id, idx) = locate_clip(project, &clip_id)?;
    let seq = &mut project.sequences[0];
    let track = seq.tracks.iter_mut().find(|t| t.id == track_id).ok_or("轨道消失")?;
    let c = track.clips.get(idx).ok_or("片段消失")?.clone();
    let local = at - c.start_ms;
    if local <= 1.0 || local >= c.duration_ms - 1.0 {
        return Err("切割点必须落在片段内部（离两端至少 1ms）".into());
    }
    let right = Clip {
        id: new_id("clip"),
        asset_id: c.asset_id.clone(),
        track_id: c.track_id.clone(),
        start_ms: at,
        duration_ms: c.duration_ms - local,
        in_ms: c.in_ms + local,
        out_ms: c.out_ms,
        speed: c.speed,
        reversed: c.reversed,
        node_id: c.node_id.clone(),
        compound_id: c.compound_id.clone(),
        enable_3d: false,
        transform_3d: None,
        transition_in: None,
        speed_curve: None,
        audio_pitch_shift: false,
        transition_out: None,
        audio_fade_in_ms: None,
        audio_fade_out_ms: None,
        audio_highpass_hz: None,
        audio_lowpass_hz: None,
        audio_delay_ms: None,
        text: None,
        label: None,
        enabled: true,
    };
    let left = track.clips.get_mut(idx).ok_or("片段消失")?;
    left.duration_ms = local;
    left.out_ms = c.in_ms + local;
    track.clips.push(right.clone());
    track.clips.sort_by(|a, b| {
        a.start_ms.partial_cmp(&b.start_ms).unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(json!({ "leftId": c.id, "rightId": right.id }))
}

fn delete_clip(session: &mut Session, args: &Value) -> Result<Value, String> {
    let clip_id = need_str(args, "clipId")?;
    let project = session.project_mut()?;
    let (track_id, idx) = locate_clip(project, &clip_id)?;
    let seq = &mut project.sequences[0];
    let track = seq.tracks.iter_mut().find(|t| t.id == track_id).ok_or("轨道消失")?;
    track.clips.remove(idx);
    Ok(json!({ "ok": true }))
}

fn mcp_set_transition(session: &mut Session, args: &Value) -> Result<Value, String> {
    let clip_id = need_str(args, "clipId")?;
    let kind = need_str(args, "kind")?;
    let duration = opt_f64(args, "durationMs", 500.0);
    let project = session.project_mut()?;
    let (track_id, idx) = locate_clip(project, &clip_id)?;
    let seq = &mut project.sequences[0];
    let track = seq.tracks.iter_mut().find(|t| t.id == track_id).ok_or("轨道消失")?;
    let c = track.clips.get_mut(idx).ok_or("片段消失")?;
    if kind == "none" || kind.is_empty() {
        c.transition_in = None;
    } else {
        let allowed = [
            "crossDissolve", "dipToBlack", "dipToWhite", "slidePush", "slidePull",
            "wipeLinear", "wipeRadial", "wipeBlinds", "zoomCross",
        ];
        if !allowed.contains(&kind.as_str()) {
            return Err(format!("不支持的转场类型：{kind}"));
        }
        let max = c.duration_ms.max(1.0);
        c.transition_in = Some(reelix_lib::timeline::model::Transition {
            kind,
            duration_ms: duration.clamp(1.0, max),
        });
    }
    Ok(json!({ "ok": true }))
}

fn mcp_add_track(session: &mut Session, args: &Value) -> Result<Value, String> {
    let kind = need_str(args, "kind")?;
    let project = session.project_mut()?;
    let seq = &mut project.sequences[0];
    let kind = match kind.as_str() {
        "video" => TrackKind::Video,
        "audio" => TrackKind::Audio,
        "subtitle" => TrackKind::Subtitle,
        "camera" => TrackKind::Camera,
        other => return Err(format!("不支持的轨道类型：{other}")),
    };
    let index = seq
        .tracks
        .iter()
        .filter(|t| t.kind == kind)
        .map(|t| t.index)
        .max()
        .map(|v| v + 1)
        .unwrap_or(0);
    let track = reelix_lib::timeline::model::Track {
        id: new_id("track"),
        kind,
        index,
        muted: false,
        solo: false,
        locked: false,
        hidden: false,
        height: if matches!(kind, TrackKind::Audio) { 48.0 } else { 64.0 },
        clips: vec![],
    };
    let id = track.id.clone();
    seq.tracks.push(track);
    Ok(json!({ "trackId": id }))
}

fn mcp_nest_clips(session: &mut Session, args: &Value) -> Result<Value, String> {
    let ids = args
        .get("clipIds")
        .and_then(Value::as_array)
        .ok_or("nest_clips 需要 clipIds 数组")?;
    if ids.len() < 2 {
        return Err("编组至少 2 个片段".into());
    }
    let project = session.project_mut()?;
    let group = new_id("compound");
    let mut n = 0;
    for v in ids {
        let id = v.as_str().ok_or("clipIds 必须是字符串数组")?;
        let (track_id, idx) = locate_clip(project, id)?;
        let seq = &mut project.sequences[0];
        let track = seq.tracks.iter_mut().find(|t| t.id == track_id).ok_or("轨道消失")?;
        if let Some(c) = track.clips.get_mut(idx) {
            c.compound_id = Some(group.clone());
            n += 1;
        }
    }
    Ok(json!({ "compoundId": group, "count": n }))
}

fn mcp_set_clip_3d(session: &mut Session, args: &Value) -> Result<Value, String> {
    let clip_id = need_str(args, "clipId")?;
    let project = session.project_mut()?;
    let (track_id, idx) = locate_clip(project, &clip_id)?;
    let seq = &mut project.sequences[0];
    let track = seq.tracks.iter_mut().find(|t| t.id == track_id).ok_or("轨道消失")?;
    let c = track.clips.get_mut(idx).ok_or("片段消失")?;
    if let Some(v) = opt_bool(args, "enabled") {
        c.enable_3d = v;
        if v && c.transform_3d.is_none() {
            c.transform_3d = Some(reelix_lib::timeline::model::Transform3D {
                position: reelix_lib::timeline::model::Vec3 { x: 0.0, y: 0.0, z: 0.0 },
                rotation: reelix_lib::timeline::model::Vec3 { x: 0.0, y: 0.0, z: 0.0 },
                scale: 1.0,
                anchor: reelix_lib::timeline::model::Vec2 { x: 0.5, y: 0.5 },
                orientation: reelix_lib::timeline::model::Layer3DOrientation::Camera,
                receive_light: true,
            });
        }
    }
    if let Some(tf) = c.transform_3d.as_mut() {
        if let Some(v) = opt_f64_required(args, "x") {
            tf.position.x = v;
        }
        if let Some(v) = opt_f64_required(args, "y") {
            tf.position.y = v;
        }
        if let Some(v) = opt_f64_required(args, "z") {
            tf.position.z = v;
        }
        if let Some(v) = opt_f64_required(args, "scale") {
            tf.scale = v;
        }
        if let Some(v) = opt_f64_required(args, "rotationZ") {
            tf.rotation.z = v;
        }
    }
    Ok(json!({ "ok": true, "enabled": c.enable_3d }))
}

fn mcp_add_subtitle(session: &mut Session, args: &Value) -> Result<Value, String> {
    let text = need_str(args, "text")?;
    let start = opt_f64_required(args, "startMs").ok_or("add_subtitle 需要 startMs")?;
    let duration = opt_f64(args, "durationMs", 3000.0);
    let project = session.project_mut()?;
    let seq = &mut project.sequences[0];
    // 没有字幕轨就建一条
    let track_id = match seq.tracks.iter().find(|t| t.kind == TrackKind::Subtitle) {
        Some(t) => t.id.clone(),
        None => {
            let track = reelix_lib::timeline::model::Track {
                id: new_id("track"),
                kind: TrackKind::Subtitle,
                index: 0,
                muted: false,
                solo: false,
                locked: false,
                hidden: false,
                height: 44.0,
                clips: vec![],
            };
            let id = track.id.clone();
            seq.tracks.push(track);
            id
        }
    };
    let clip = Clip {
        id: new_id("clip"),
        asset_id: String::new(),
        track_id: track_id.clone(),
        text: Some(text.clone()),
        start_ms: start.max(0.0),
        duration_ms: duration.max(100.0),
        in_ms: 0.0,
        out_ms: duration.max(100.0),
        speed: 1.0,
        reversed: false,
        node_id: String::new(),
        compound_id: None,
        enable_3d: false,
        transform_3d: None,
        transition_in: None,
        speed_curve: None,
        audio_pitch_shift: false,
        transition_out: None,
        audio_fade_in_ms: None,
        audio_fade_out_ms: None,
        audio_highpass_hz: None,
        audio_lowpass_hz: None,
        audio_delay_ms: None,
        label: None,
        enabled: true,
    };
    let node_id = String::new();
    let seq = &mut project.sequences[0];
    let track = seq.tracks.iter_mut().find(|t| t.id == track_id).ok_or("字幕轨消失")?;
    let mut clip = clip;
    clip.node_id = node_id;
    track.clips.push(clip.clone());
    Ok(json!({ "clipId": clip.id, "trackId": track_id }))
}

fn probe_media(args: &Value) -> Result<Value, String> {
    let path = need_str(args, "path")?;
    let info = probe_path(&path);
    serde_json::to_value(&info).map_err(|e| format!("序列化探测结果失败：{e}"))
}

fn set_sequence(session: &mut Session, args: &Value) -> Result<Value, String> {
    let project = session.project_mut()?;
    let seq = project
        .sequences
        .first_mut()
        .ok_or_else(|| "工程里没有序列，先 new_project".to_string())?;
    if let Some(v) = opt_f64_required(args, "width") {
        seq.width = v.max(2.0) as u32;
    }
    if let Some(v) = opt_f64_required(args, "height") {
        seq.height = v.max(2.0) as u32;
    }
    if let Some(v) = opt_f64_required(args, "frameRate") {
        seq.frame_rate = v.max(1.0);
    }
    if let Some(v) = opt_f64_required(args, "durationMs") {
        seq.duration_ms = v.max(1.0);
    }
    Ok(json!({
        "width": seq.width,
        "height": seq.height,
        "frameRate": seq.frame_rate,
        "durationMs": seq.duration_ms,
    }))
}

/// 找主程序 `reelix.exe`。
///
/// 顺序：环境变量 `REELIX_EXE` → 与本进程同目录 → 开发期 target 目录。
fn locate_reelix_exe() -> Result<std::path::PathBuf, String> {
    if let Ok(v) = std::env::var("REELIX_EXE") {
        let p = std::path::PathBuf::from(v);
        if p.is_file() {
            return Ok(p);
        }
    }
    let exe = std::env::current_exe().map_err(|e| format!("定位自身失败：{e}"))?;
    let dir = exe.parent().ok_or_else(|| "定位自身目录失败".to_string())?;
    let candidates = [
        // 便携版：两个 exe 放一起
        dir.join("reelix.exe"),
        // 开发期：reelix-mcp/target/release → ../../.. → scaffold/src-tauri/target/release
        dir.join("../../../src-tauri/target/release/reelix.exe"),
        // 保险：再多退一层
        dir.join("../../../../src-tauri/target/release/reelix.exe"),
    ];
    for c in candidates {
        if c.is_file() {
            return Ok(c);
        }
    }
    Err("找不到 reelix.exe：请设置环境变量 REELIX_EXE 指向主程序".to_string())
}

/// 把工程渲染成视频。
///
/// 为什么不在 MCP 里直接渲染：渲染管线（解帧 / 效果栈 / 转场 / 字幕烧录 / 混音）
/// 都在 `commands` 模块里，而那是 `feature = "desktop"` 才编译的，MCP 刻意不链接
/// tauri。所以这里把「导出一段工程」交给主程序的无窗口模式
/// `reelix.exe --export ...`——它内部调用的仍是与界面导出同一个 `export_sync`，
/// 画质完全一致，不是另做一套。
fn render_video(args: &Value) -> Result<Value, String> {
    let project_path = need_str(args, "projectPath")?;
    let output = need_str(args, "outputPath")?;
    let preset = opt_str(args, "preset").unwrap_or_else(|| "h264-1080p".to_string());

    if !Path::new(&project_path).is_file() {
        return Err(format!("工程文件不存在：{project_path}（先用 save_project 落盘）"));
    }
    let exe = locate_reelix_exe()?;

    let mut cmd = Command::new(&exe);
    cmd.arg("--export")
        .arg("--project")
        .arg(&project_path)
        .arg("--out")
        .arg(&output)
        .arg("--preset")
        .arg(&preset);
    if let Some(v) = opt_f64_required(args, "startMs") {
        cmd.arg("--start").arg(format!("{v}"));
    }
    if let Some(v) = opt_f64_required(args, "endMs") {
        cmd.arg("--end").arg(format!("{v}"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let status = cmd
        .status()
        .map_err(|e| format!("启动导出进程失败：{e}"))?;

    // 主程序是 windows_subsystem="windows"，没有控制台，
    // 结果靠退出码 + 它写在输出旁边的 <输出>.export.log
    let log_path = Path::new(&output).with_extension("export.log");
    let log_text = std::fs::read_to_string(&log_path).unwrap_or_default();
    let tail: Vec<&str> = log_text.lines().rev().take(15).collect();
    let tail: Vec<&str> = tail.into_iter().rev().collect();

    if !status.success() {
        return Err(format!(
            "导出失败（退出码 {:?}）：\n{}",
            status.code(),
            tail.join("\n")
        ));
    }

    let size = std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
    Ok(json!({
        "ok": true,
        "output": output,
        "preset": preset,
        "bytes": size,
        "log": tail.join("\n"),
    }))
}

