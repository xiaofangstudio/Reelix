//! .reelix 读写与 id/时间工具。
//!
//! 文件格式见 `docs/03-技术架构.md` 第六节：`.reelix` 是一个 ZIP 容器。
//! 骨架阶段先把 project 落成 JSON，保证「新建 → 保存 → 打开」链路先能跑通，
//! 打包成 ZIP 与写 meta.json 放在 M1。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::graph::node::{plug, Graph, GraphNode, PlugDataType};
use crate::project::model::{Asset, Project, Sequence};
use crate::timeline::model::{Track, TrackKind, DEFAULT_SEQUENCE_MS};

static ID_COUNTER: AtomicU64 = AtomicU64::new(1);

/// 当前毫秒时间戳。
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 生成一个足够唯一的 id。骨架阶段用「前缀-时间戳-自增号」。
pub fn new_id(prefix: &str) -> String {
    let n = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{:x}-{:x}", now_ms(), n)
}

/// 按缺省档位（1920×1080 / 25fps / Rec.709）新建一个空项目。
/// 单元测试、MCP 等不需要挑画幅的调用方用它；开场界面走 `new_project_with`。
pub fn new_project(name: &str) -> Project {
    new_project_with(name, 1920, 1080, 25.0, "Rec.709")
}

/// 新建一个空项目：一条按给定画幅 / 帧率 / 色彩空间的序列，一条视频轨、一条音频轨，
/// 根图里预置「序列 → 输出」两个节点，用户往里插特效即可。
///
/// 画幅、帧率、色彩空间由开场界面传入；传进 0 或非法帧率时退回标清档，不做出空壳序列。
pub fn new_project_with(
    name: &str,
    width: u32,
    height: u32,
    frame_rate: f64,
    color_space: &str,
) -> Project {
    // 兜底：画幅至少 1 像素、帧率必须有限且为正，否则退回标清档
    let width = if width == 0 { 1920 } else { width };
    let height = if height == 0 { 1080 } else { height };
    let frame_rate = if frame_rate.is_finite() && frame_rate > 0.0 {
        frame_rate
    } else {
        25.0
    };
    let color_space = if color_space.trim().is_empty() {
        "Rec.709"
    } else {
        color_space
    };
    let now = now_ms();
    let sequence_id = new_id("seq");
    let root_graph_id = new_id("graph");
    let seq_node_id = new_id("node");
    let out_node_id = new_id("node");

    let root_graph = Graph {
        id: root_graph_id.clone(),
        nodes: vec![
            GraphNode {
                id: seq_node_id.clone(),
                node_type: "sequence".into(),
                name: "序列".into(),
                x: 120.0,
                y: 90.0,
                params: HashMap::new(),
                bypassed: false,
                collapsed: false,
                animated: false,
                inputs: vec![plug("in", "输入", PlugDataType::Image, false)],
                outputs: vec![plug("out", "输出", PlugDataType::Image, true)],
            },
            GraphNode {
                id: out_node_id.clone(),
                node_type: "output".into(),
                name: "输出".into(),
                x: 420.0,
                y: 90.0,
                params: HashMap::new(),
                bypassed: false,
                collapsed: false,
                animated: false,
                inputs: vec![plug("in", "输入", PlugDataType::Image, true)],
                outputs: vec![],
            },
        ],
        connections: vec![crate::graph::node::Connection {
            id: new_id("conn"),
            from_node: seq_node_id,
            from_plug: "out".into(),
            to_node: out_node_id,
            to_plug: "in".into(),
        }],
        parent_node_id: None,
    };

    let mut graphs = HashMap::new();
    graphs.insert(root_graph_id.clone(), root_graph);

    let sequence = Sequence {
        id: sequence_id.clone(),
        name: "主序列".into(),
        width,
        height,
        frame_rate,
        color_space: color_space.to_string(),
        // 空工程也要有可用的标尺/播放空间；加片段后由 recompute 接管
        duration_ms: DEFAULT_SEQUENCE_MS,
        root_graph_id,
        markers: Vec::new(),
        tracks: vec![
            Track {
                id: new_id("track"),
                kind: TrackKind::Video,
                index: 0,
                muted: false,
                solo: false,
                locked: false,
                hidden: false,
                height: 64.0,
                clips: vec![],
            },
            Track {
                id: new_id("track"),
                kind: TrackKind::Audio,
                index: 0,
                muted: false,
                solo: false,
                locked: false,
                hidden: false,
                height: 48.0,
                clips: vec![],
            },
        ],
    };

    Project {
        id: new_id("proj"),
        name: name.to_string(),
        created_at: now,
        modified_at: now,
        assets: Vec::<Asset>::new(),
        sequences: vec![sequence],
        graphs,
        bins: Vec::new(),
        curves: Vec::new(),
    }
}

/// 保存项目。
pub fn save(path: &Path, project: &Project) -> Result<(), String> {
    // TODO(M1)：改成写 ZIP 容器（project.json / thumbnail.png / meta.json）。
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建项目目录失败：{e}"))?;
        }
    }
    let json =
        serde_json::to_vec_pretty(project).map_err(|e| format!("项目序列化失败：{e}"))?;
    std::fs::write(path, json).map_err(|e| format!("写入项目文件失败：{e}"))
}

/// 打开项目。
pub fn load(path: &Path) -> Result<Project, String> {
    // TODO(M1)：改成解 ZIP 容器，并对畸形输入（zip 炸弹 / 超深嵌套）做防护。
    let bytes = std::fs::read(path).map_err(|e| format!("读取项目文件失败：{e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("项目文件解析失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// 新建项目必须带齐骨架：1920×1080 / 25fps 的序列、一视频一音频轨、
    /// 根图里预置「序列 → 输出」并已连好线。
    #[test]
    fn new_project_builds_the_documented_skeleton() {
        let p = new_project("我的片子");
        assert_eq!(p.name, "我的片子");
        assert!(p.assets.is_empty(), "新项目不该自带素材");
        assert_eq!(p.sequences.len(), 1, "新项目应当只有一条序列");

        let seq = &p.sequences[0];
        assert_eq!((seq.width, seq.height), (1920, 1080));
        assert!((seq.frame_rate - 25.0).abs() < 1e-9);
        assert_eq!(seq.color_space, "Rec.709");
        assert_eq!(seq.tracks.len(), 2, "应当自带视频轨与音频轨");
        assert_eq!(seq.tracks[0].kind, TrackKind::Video, "第一条应当是视频轨");
        assert_eq!(seq.tracks[1].kind, TrackKind::Audio, "第二条应当是音频轨");

        let graph = p.graphs.get(&seq.root_graph_id).expect("根图应当挂在项目里");
        assert_eq!(graph.nodes.len(), 2, "根图应当预置序列与输出两个节点");
        assert!(graph.nodes.iter().any(|n| n.node_type == "sequence"), "缺序列节点");
        assert!(graph.nodes.iter().any(|n| n.node_type == "output"), "缺输出节点");
        assert_eq!(graph.connections.len(), 1, "序列应当已经接到输出");
        let conn = &graph.connections[0];
        assert_eq!(conn.from_plug, "out");
        assert_eq!(conn.to_plug, "in");
        assert!(graph.parent_node_id.is_none(), "根图没有父节点");
    }

    /// 开场界面选定的画幅 / 帧率 / 色彩空间必须原样落进序列；
    /// 传进非法值时退回 1920×1080 / 25fps / Rec.709，不做出空壳序列。
    #[test]
    fn new_project_honours_start_screen_settings() {
        let p = new_project_with("竖屏短片", 1080, 1920, 30.0, "Rec.2020");
        let seq = &p.sequences[0];
        assert_eq!((seq.width, seq.height), (1080, 1920));
        assert!((seq.frame_rate - 30.0).abs() < 1e-9);
        assert_eq!(seq.color_space, "Rec.2020");

        let bad = new_project_with("兜底", 0, 0, f64::NAN, "  ");
        let bad_seq = &bad.sequences[0];
        assert_eq!((bad_seq.width, bad_seq.height), (1920, 1080));
        assert!((bad_seq.frame_rate - 25.0).abs() < 1e-9);
        assert_eq!(bad_seq.color_space, "Rec.709");
    }

    /// 各级 id 必须互不相同，否则图与关键帧的引用会串在一起。
    #[test]
    fn new_project_ids_are_unique() {
        let p = new_project("x");
        let mut seen: HashSet<String> = HashSet::new();
        assert!(seen.insert(p.id.clone()), "项目 id 重复");
        for seq in &p.sequences {
            assert!(seen.insert(seq.id.clone()), "序列 id 重复");
            for t in &seq.tracks {
                assert!(seen.insert(t.id.clone()), "轨道 id 重复");
            }
            if let Some(g) = p.graphs.get(&seq.root_graph_id) {
                assert!(seen.insert(g.id.clone()), "图 id 重复");
                for n in &g.nodes {
                    assert!(seen.insert(n.id.clone()), "节点 id 重复");
                }
                for c in &g.connections {
                    assert!(seen.insert(c.id.clone()), "连线 id 重复");
                }
            }
        }
    }

    /// 保存再打开要能完整还原骨架，且落盘的是合法 UTF-8 JSON。
    #[test]
    fn project_round_trips_through_disk() {
        let path = std::env::temp_dir().join(format!("{}.reelix", new_id("test")));
        let original = new_project("往返测试");
        save(&path, &original).expect("保存应当成功");

        let raw = std::fs::read(&path).expect("文件应当存在");
        assert!(std::str::from_utf8(&raw).is_ok(), "落盘的应当是合法 UTF-8");

        let back = load(&path).expect("打开应当成功");
        assert_eq!(back.name, original.name);
        assert_eq!(back.id, original.id);
        assert_eq!(back.sequences.len(), original.sequences.len());
        assert_eq!(back.sequences[0].width, 1920);
        assert_eq!(back.graphs.len(), original.graphs.len());

        std::fs::remove_file(&path).ok();
    }

    /// 打开不存在的文件应当返回可读的中文错误，而不是 panic。
    #[test]
    fn load_reports_missing_file_in_chinese() {
        let path = std::env::temp_dir().join(format!("{}-missing.reelix", new_id("test")));
        let err = load(&path).expect_err("文件不存在应当报错");
        assert!(err.contains("读取项目文件失败"), "错误文案应当是中文且可读：{err}");
    }

    /// 内置示例工程（src/services/sampleProject.ts 生成的那份 JSON）必须能原样打开。
    ///
    /// 这份Fixture 锁死前后端契约：节点类型字段叫 `type`、插槽叫 `connected`、
    /// 片段 3D 开关叫 `enable3D`/`transform3D`、序列必填 `colorSpace`、
    /// 标记只有 `{ id, timeMs, name }`。任何一边改了名，这个测试先红。
    /// 注意：改了 TS 里的示例工程，要同步更新这里。
    #[test]
    fn sample_project_json_deserializes() {
        let json = r##"{
          "id": "proj-1",
          "name": "30 秒认识 Reelix（示例）",
          "createdAt": 0,
          "modifiedAt": 0,
          "assets": [],
          "sequences": [
            {
              "id": "seq-1",
              "name": "主序列",
              "width": 1920,
              "height": 1080,
              "frameRate": 30,
              "colorSpace": "Rec.709",
              "durationMs": 30000,
              "rootGraphId": "graph-1",
              "tracks": [
                {
                  "id": "track-v3",
                  "kind": "subtitle",
                  "index": 2,
                  "muted": false,
                  "solo": false,
                  "locked": false,
                  "hidden": false,
                  "height": 44,
                  "clips": [
                    {
                      "id": "clip-title",
                      "assetId": "",
                      "trackId": "track-v3",
                      "text": "Reelix · 特效合成软件",
                      "label": "主标题",
                      "startMs": 500,
                      "durationMs": 4000,
                      "inMs": 0,
                      "outMs": 4000,
                      "speed": 1,
                      "reversed": false,
                      "nodeId": "",
                      "enable3D": false,
                      "transitionIn": null,
                      "enabled": true
                    }
                  ]
                },
                {
                  "id": "track-v2",
                  "kind": "video",
                  "index": 1,
                  "muted": false,
                  "solo": false,
                  "locked": false,
                  "hidden": false,
                  "height": 64,
                  "clips": [
                    {
                      "id": "clip-circle",
                      "assetId": "",
                      "trackId": "track-v2",
                      "startMs": 3000,
                      "durationMs": 8000,
                      "inMs": 0,
                      "outMs": 8000,
                      "speed": 1,
                      "reversed": false,
                      "nodeId": "node-circle",
                      "enable3D": true,
                      "transform3D": {
                        "position": { "x": 120, "y": 40, "z": 200 },
                        "rotation": { "x": 0, "y": 0, "z": 15 },
                        "scale": 0.8,
                        "anchor": { "x": 0.5, "y": 0.5 },
                        "orientation": "camera",
                        "receiveLight": true
                      },
                      "transitionIn": { "kind": "crossDissolve", "durationMs": 800 },
                      "enabled": true
                    }
                  ]
                },
                {
                  "id": "track-v1",
                  "kind": "video",
                  "index": 0,
                  "muted": false,
                  "solo": false,
                  "locked": false,
                  "hidden": false,
                  "height": 64,
                  "clips": [
                    {
                      "id": "clip-gradient",
                      "assetId": "",
                      "trackId": "track-v1",
                      "label": "渐变背景",
                      "startMs": 0,
                      "durationMs": 30000,
                      "inMs": 0,
                      "outMs": 30000,
                      "speed": 1,
                      "reversed": false,
                      "nodeId": "node-gradient",
                      "enable3D": false,
                      "transitionIn": null,
                      "enabled": true
                    }
                  ]
                },
                {
                  "id": "track-a1",
                  "kind": "audio",
                  "index": 0,
                  "muted": false,
                  "solo": false,
                  "locked": false,
                  "hidden": false,
                  "height": 48,
                  "clips": []
                },
                {
                  "id": "track-s1",
                  "kind": "subtitle",
                  "index": 1,
                  "muted": false,
                  "solo": false,
                  "locked": false,
                  "hidden": false,
                  "height": 44,
                  "clips": [
                    {
                      "id": "clip-sub",
                      "assetId": "",
                      "trackId": "track-s1",
                      "text": "合成 · 剪辑 · 3D · 关键帧",
                      "startMs": 12000,
                      "durationMs": 5000,
                      "inMs": 0,
                      "outMs": 5000,
                      "speed": 1,
                      "reversed": false,
                      "nodeId": "",
                      "enable3D": false,
                      "transitionIn": { "kind": "dipToBlack", "durationMs": 400 },
                      "enabled": true
                    }
                  ]
                },
                {
                  "id": "track-cam",
                  "kind": "camera",
                  "index": 0,
                  "muted": false,
                  "solo": false,
                  "locked": false,
                  "hidden": false,
                  "height": 44,
                  "clips": []
                }
              ],
              "markers": [
                { "id": "mk-1", "timeMs": 0, "name": "开场：渐变入场" },
                { "id": "mk-2", "timeMs": 11000, "name": "中段：字幕切入" },
                { "id": "mk-3", "timeMs": 22000, "name": "收尾：准备导出" }
              ]
            }
          ],
          "graphs": {
            "graph-1": {
              "id": "graph-1",
              "nodes": [
                {
                  "id": "node-gradient",
                  "type": "gradient",
                  "name": "渐变",
                  "x": 0,
                  "y": 0,
                  "params": { "colorA": "#0f2b22", "colorB": "#9fd4b6", "angle": 35 },
                  "inputs": [{ "key": "in", "label": "输入", "dataType": "image", "connected": false }],
                  "outputs": [{ "key": "out", "label": "输出", "dataType": "image", "connected": true }],
                  "bypassed": false,
                  "collapsed": false,
                  "animated": false
                },
                {
                  "id": "node-grid",
                  "type": "grid",
                  "name": "网格",
                  "x": 0,
                  "y": 0,
                  "params": { "spacing": 120, "lineWidth": 2, "color": "#8fc4a8" },
                  "inputs": [{ "key": "in", "label": "输入", "dataType": "image", "connected": true }],
                  "outputs": [{ "key": "out", "label": "输出", "dataType": "image", "connected": true }],
                  "bypassed": false,
                  "collapsed": false,
                  "animated": false
                },
                {
                  "id": "node-circle",
                  "type": "circle",
                  "name": "圆",
                  "x": 0,
                  "y": 0,
                  "params": { "centerX": 0.5, "centerY": 0.45, "radius": 28, "color": "#ffd94d", "feather": 12 },
                  "inputs": [{ "key": "in", "label": "输入", "dataType": "image", "connected": true }],
                  "outputs": [{ "key": "out", "label": "输出", "dataType": "image", "connected": true }],
                  "bypassed": false,
                  "collapsed": false,
                  "animated": false
                },
                {
                  "id": "node-poster",
                  "type": "posterize",
                  "name": "色调分离",
                  "x": 0,
                  "y": 0,
                  "params": { "levels": 8 },
                  "inputs": [{ "key": "in", "label": "输入", "dataType": "image", "connected": true }],
                  "outputs": [{ "key": "out", "label": "输出", "dataType": "image", "connected": true }],
                  "bypassed": false,
                  "collapsed": false,
                  "animated": false
                },
                {
                  "id": "node-output",
                  "type": "output",
                  "name": "输出",
                  "x": 0,
                  "y": 0,
                  "params": {},
                  "inputs": [{ "key": "in", "label": "输入", "dataType": "image", "connected": true }],
                  "outputs": [],
                  "bypassed": false,
                  "collapsed": false,
                  "animated": false
                }
              ],
              "connections": [
                { "id": "conn-1", "fromNode": "node-gradient", "fromPlug": "out", "toNode": "node-grid", "toPlug": "in" },
                { "id": "conn-2", "fromNode": "node-grid", "fromPlug": "out", "toNode": "node-circle", "toPlug": "in" },
                { "id": "conn-3", "fromNode": "node-circle", "fromPlug": "out", "toNode": "node-poster", "toPlug": "in" },
                { "id": "conn-4", "fromNode": "node-poster", "fromPlug": "out", "toNode": "node-output", "toPlug": "in" }
              ]
            }
          },
          "bins": []
        }"##;

        let p: Project = serde_json::from_str(json).expect("示例工程 JSON 必须能反序列化");

        // 序列层：colorSpace 必填、三个标记都带名字
        let seq = &p.sequences[0];
        assert_eq!(seq.color_space, "Rec.709");
        assert_eq!(seq.markers.len(), 3);
        assert_eq!(seq.markers[0].name.as_deref(), Some("开场：渐变入场"));

        // 轨道层：六条轨，种类齐全
        assert_eq!(seq.tracks.len(), 6);

        // 3D 片段：enable3D 与 transform3D 必须真的落下来（大小写敏感）
        let v2 = seq.tracks.iter().find(|t| t.id == "track-v2").expect("V2 轨应在");
        let circle_clip = &v2.clips[0];
        assert!(circle_clip.enable_3d, "V2 片段应当启用 3D");
        let tf = circle_clip.transform_3d.as_ref().expect("3D 变换应当在");
        assert!((tf.scale - 0.8).abs() < 1e-9);
        assert!(circle_clip.transition_in.is_some(), "V2 片段应当带转场");

        // 图节点层：type 字段（不是 nodeType）、connected 插槽、输出节点收尾
        let graph = p.graphs.get(&seq.root_graph_id).expect("根图应当挂在项目里");
        assert_eq!(graph.nodes.len(), 5);
        let gradient = graph.nodes.iter().find(|n| n.id == "node-gradient").expect("渐变节点应在");
        assert_eq!(gradient.node_type, "gradient");
        assert!(gradient.outputs[0].connected, "渐变输出已接线");
        assert!(!gradient.inputs[0].connected, "渐变没有输入接线");
        assert!(graph.nodes.iter().any(|n| n.node_type == "output"), "链尾应当有输出节点");
        assert_eq!(graph.connections.len(), 4);

        // 字幕轨片段：文字落在 text 上，nodeId 为空串（与 app 自己建字幕片段一致）
        let s1 = seq.tracks.iter().find(|t| t.id == "track-s1").expect("字幕轨应在");
        assert_eq!(s1.clips[0].text.as_deref(), Some("合成 · 剪辑 · 3D · 关键帧"));
        assert_eq!(s1.clips[0].node_id, "");
    }

    /// 关键帧曲线必须随工程落盘。
    ///
    /// 以前 curves 只活在内存里，保存时不写、打开时又 clear()——
    /// 用户做好的出场动画 / 摄像机环绕，关掉工程再打开就凭空消失。
    #[test]
    fn keyframe_curves_round_trip_through_json() {
        use crate::keyframe::{EasingPreset, KeyframeStore};

        let mut project = new_project("曲线落盘");
        let mut store = KeyframeStore::new();
        store.set_keyframe("camera-node", "posX", 0.0, -300.0, EasingPreset::Linear);
        store.set_keyframe("camera-node", "posX", 4000.0, 300.0, EasingPreset::Linear);
        project.curves = store.curves();
        assert_eq!(project.curves.len(), 1, "两条关键帧应合成一条曲线");

        // 走一遍真实的 JSON 序列化 / 反序列化
        let json = serde_json::to_string(&project).expect("工程应能序列化");
        let back: Project = serde_json::from_str(&json).expect("工程应能反序列化");
        assert_eq!(back.curves.len(), 1, "关键帧曲线必须能从工程文件读回来");
        assert_eq!(back.curves[0].keyframes.len(), 2, "两帧都应保住");

        // 旧工程没有 curves 字段也必须能读（serde default 兜底）
        let legacy = json.replace("\"curves\"", "\"legacyCurves\"");
        let old: Project = serde_json::from_str(&legacy).expect("缺 curves 的旧工程应能读");
        assert!(old.curves.is_empty(), "旧工程读进来应当是空曲线，而不是报错");
    }
}
