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
                    "easing": p_str("缓动：linear / ease-in / ease-out / ease-in-out / bounce / elastic，缺省 linear"),
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
    serde_json::to_value(&keyframe).map_err(|e| format!("序列化关键帧失败：{e}"))
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
    let project = session.project_mut()?;
    project.modified_at = serialize::now_ms();
    serialize::save(Path::new(&path), project)?;
    Ok(json!({ "saved": true, "path": path }))
}

fn open_project(session: &mut Session, args: &Value) -> Result<Value, String> {
    let path = need_str(args, "path")?;
    let project = serialize::load(Path::new(&path))?;
    let id = project.id.clone();
    let name = project.name.clone();
    let sequences = project.sequences.len();

    session.project = Some(project);
    session.keyframes.clear();
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

fn probe_media(args: &Value) -> Result<Value, String> {
    let path = need_str(args, "path")?;
    let info = probe_path(&path);
    serde_json::to_value(&info).map_err(|e| format!("序列化探测结果失败：{e}"))
}
