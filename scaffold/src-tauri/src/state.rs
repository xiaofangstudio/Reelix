//! 全局运行时状态。
//!
//! Tauri 把这里的一个实例托管给所有命令。所有重活共享同一份状态，
//! 前端拿到的快照都是从这些锁里读出来的，保证「时间线与节点图是同一份数据」。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use crate::compositor::cache::FrameCache;
use crate::graph::engine::GraphEngine;
use crate::graph::evaluator::DirtyTracker;
use crate::history::History;
use crate::keyframe::KeyframeStore;
use crate::project::model::Project;
use crate::storage::settings::Settings;

/// 预览播放的运行时状态。
#[derive(Debug, Clone)]
pub struct PreviewState {
    pub running: bool,
    /// 预览缩放，0.25 ~ 1.0
    pub scale: f64,
    pub sequence_id: Option<String>,
}

impl Default for PreviewState {
    fn default() -> Self {
        Self {
            running: false,
            scale: 1.0,
            sequence_id: None,
        }
    }
}

/// 缓存占用统计。
#[derive(Debug, Clone, Default)]
pub struct CacheState {
    pub memory_bytes: u64,
    pub disk_bytes: u64,
    pub entries: usize,
}

/// 一个导出任务的进度。
#[derive(Debug, Clone, Default)]
pub struct ExportJob {
    pub id: String,
    pub paused: bool,
    pub cancelled: bool,
    pub frame: u64,
    pub total_frames: u64,
    pub stage: String,
}

/// 一个空间解算任务的进度。
#[derive(Debug, Clone, Default)]
pub struct ReconstructJob {
    pub id: String,
    pub cancelled: bool,
    /// 0 ~ 1
    pub progress: f64,
    pub stage: String,
}

/// 应用全局状态。
#[derive(Default)]
pub struct AppState {
    /// 当前项目；None 表示还没新建/打开
    pub project: Mutex<Option<Project>>,
    /// 当前项目文件路径；None 表示还没保存过
    pub project_path: Mutex<Option<PathBuf>>,
    /// 是否有未保存改动
    pub project_dirty: Mutex<bool>,
    /// 共享关键帧引擎：片段参数与节点参数都存这里
    pub keyframes: Mutex<KeyframeStore>,
    /// 脏标记
    pub dirty: Mutex<DirtyTracker>,
    /// 图引擎：逐节点输出缓存，负责增量重算
    pub engine: Mutex<GraphEngine>,
    /// 撤销栈：剪辑与特效共用一个
    pub history: Mutex<History>,
    pub settings: Mutex<Settings>,
    pub preview: Mutex<PreviewState>,
    /// 预览帧缓存：已编码的 PNG 留在内存里，回拖时零磁盘 I/O
    pub frames: Mutex<FrameCache>,
    pub cache: Mutex<CacheState>,
    pub exports: Mutex<HashMap<String, ExportJob>>,
    /// 空间识别任务：COLMAP 解算在后台线程跑，进度与取消都走这张表
    pub reconstruct: Mutex<HashMap<String, ReconstructJob>>,
}

/// 统一加锁，避免每处都写一遍中毒错误处理。
pub fn lock<T>(m: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    m.lock()
        .map_err(|_| "内部状态锁已损坏，请重启 Reelix".to_string())
}
