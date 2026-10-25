//! 项目数据模型。字段名即契约，与 `src/types/project.ts` 一致，
//! 靠 `serde(rename_all = "camelCase")` 保证前后端 JSON 对得上。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::graph::node::Graph;
use crate::timeline::model::Track;

pub type Id = String;

/// 素材类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetKind {
    Video,
    Audio,
    Image,
    ImageSequence,
}

/// 素材。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: Id,
    pub path: String,
    pub name: String,
    pub kind: AssetKind,
    pub duration_ms: f64,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    pub codec: String,
    pub has_audio: bool,
    /// 文件找不到了，需要重新链接
    pub missing: bool,
    /// 所属素材箱；不归入任何文件夹时缺省（旧工程没有这个字段也能加载）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bin_id: Option<Id>,
}

/// 时间线标记：播放头标尺上的一个旗子，只有位置与可选名字。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: Id,
    pub time_ms: f64,
    pub name: Option<String>,
}

/// 素材箱：素材面板里的文件夹。只负责归类，不影响素材本身；
/// 重名允许存在（识别靠 id，不靠名字）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bin {
    pub id: Id,
    pub name: String,
}

/// 序列。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sequence {
    pub id: Id,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    pub color_space: String,
    pub duration_ms: f64,
    pub tracks: Vec<Track>,
    /// 该序列对应的根图
    pub root_graph_id: Id,
    /// 时间线标记；旧工程没有这个字段也能加载（serde default）
    #[serde(default)]
    pub markers: Vec<Marker>,
}

/// 项目。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: Id,
    pub name: String,
    pub created_at: i64,
    pub modified_at: i64,
    pub assets: Vec<Asset>,
    pub sequences: Vec<Sequence>,
    pub graphs: HashMap<Id, Graph>,
    /// 素材箱文件夹；旧工程没有这个字段也能加载（serde default）
    #[serde(default)]
    pub bins: Vec<Bin>,
    /// 关键帧曲线（出场动画、摄像机环绕等所有参数动画）。
    ///
    /// 之前关键帧只活在内存和撤销栈里，一保存就丢——用户做好的动画关掉工程再打开
    /// 全没了。现在随工程一起落盘，旧工程没有这个字段也照样能读（空曲线）。
    #[serde(default)]
    pub curves: Vec<crate::keyframe::model::Curve>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// 标记与素材箱的序列化键必须是 camelCase 契约名。
    #[test]
    fn marker_and_bin_serialize_camel_case() {
        let marker: Value = serde_json::to_value(Marker {
            id: "m1".into(),
            time_ms: 1500.0,
            name: Some("开场".into()),
        })
        .unwrap();
        assert_eq!(marker.get("id").and_then(Value::as_str), Some("m1"));
        assert_eq!(marker.get("timeMs").and_then(Value::as_f64), Some(1500.0));
        assert_eq!(marker.get("name").and_then(Value::as_str), Some("开场"));

        let bin: Value = serde_json::to_value(Bin {
            id: "b1".into(),
            name: "rushes".to_string(),
        })
        .unwrap();
        assert_eq!(bin.get("id").and_then(Value::as_str), Some("b1"));
        assert_eq!(bin.get("name").and_then(Value::as_str), Some("rushes"));
    }

    /// 素材的 binId：设了要写出来，没设不写；缺字段也能加载。
    #[test]
    fn asset_bin_id_is_optional() {
        let asset = |bin_id: Option<Id>| {
            serde_json::to_value(Asset {
                id: "a1".into(),
                path: "C:/a.mp4".into(),
                name: "a.mp4".into(),
                kind: AssetKind::Video,
                duration_ms: 1000.0,
                width: 1920,
                height: 1080,
                frame_rate: 25.0,
                codec: "h264".into(),
                has_audio: true,
                missing: false,
                bin_id,
            })
            .unwrap()
        };

        let without: Value = asset(None);
        assert!(without.get("binId").is_none(), "未归箱时不应写 binId");

        let with: Value = asset(Some("b1".into()));
        assert_eq!(with.get("binId").and_then(Value::as_str), Some("b1"));

        let legacy = serde_json::json!({
            "id": "a1", "path": "C:/a.mp4", "name": "a.mp4", "kind": "video",
            "durationMs": 1000.0, "width": 1920, "height": 1080,
            "frameRate": 25.0, "codec": "h264", "hasAudio": true, "missing": false
        });
        let back: Asset = serde_json::from_value(legacy).expect("旧素材 JSON 必须能加载");
        assert!(back.bin_id.is_none(), "缺 binId 应回落 None");
    }

    /// 旧工程 JSON（无 markers / bins 字段）必须能加载——线上已有工程不能打不开。
    #[test]
    fn project_loads_legacy_json_without_markers_and_bins() {
        let legacy = serde_json::json!({
            "id": "p1",
            "name": "旧工程",
            "createdAt": 1,
            "modifiedAt": 2,
            "assets": [],
            "sequences": [{
                "id": "s1", "name": "主序列", "width": 1920, "height": 1080,
                "frameRate": 25.0, "colorSpace": "Rec.709", "durationMs": 0.0,
                "tracks": [], "rootGraphId": "g1"
            }],
            "graphs": {}
        });
        let project: Project = serde_json::from_value(legacy).expect("旧工程 JSON 必须能加载");
        assert!(project.bins.is_empty(), "缺 bins 应回落为空");
        assert!(project.sequences[0].markers.is_empty(), "缺 markers 应回落为空");
    }
}
