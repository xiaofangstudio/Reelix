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
}
