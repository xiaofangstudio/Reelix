//! 项目命令：新建 / 打开 / 保存 / 取快照 / 关闭。

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::project::{model::Project, serialize};
use crate::state::{lock, AppState};

/// 保存结果，返回最终落盘路径。
#[derive(Debug, Clone, Serialize)]
pub struct SaveResult {
    pub path: String,
}

/// 取当前项目，未打开时报错。
fn require_project(state: &State<'_, AppState>) -> Result<Project, String> {
    let guard = lock(&state.project)?;
    guard
        .clone()
        .ok_or_else(|| "还没有打开项目".to_string())
}

/// 新建项目。画幅 / 帧率 / 色彩空间由开场界面传入，非法值在 serialize 里退回标清档。
#[tauri::command]
pub fn new_project(
    name: String,
    width: u32,
    height: u32,
    frame_rate: f64,
    color_space: String,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let project = serialize::new_project_with(&name, width, height, frame_rate, &color_space);
    *lock(&state.project)? = Some(project.clone());
    *lock(&state.project_path)? = None;
    *lock(&state.project_dirty)? = false;
    lock(&state.keyframes)?.clear();
    lock(&state.dirty)?.clear();
    lock(&state.history)?.reset("新建项目", &project, &[]);
    Ok(project)
}

/// 打开 .reelix 项目文件。
#[tauri::command]
pub fn open_project(path: String, state: State<'_, AppState>) -> Result<Project, String> {
    let project = serialize::load(std::path::Path::new(&path))?;
    *lock(&state.project)? = Some(project.clone());
    *lock(&state.project_path)? = Some(PathBuf::from(&path));
    *lock(&state.project_dirty)? = false;
    lock(&state.keyframes)?.clear();
    lock(&state.dirty)?.clear();
    lock(&state.history)?.reset("打开项目", &project, &[]);
    Ok(project)
}

/// 保存项目。不传路径时用上一次的保存路径。
///
/// TODO(M1)：`path` 为 None 且从未保存过时，改为弹系统保存对话框。
#[tauri::command]
pub fn save_project(path: Option<String>, state: State<'_, AppState>) -> Result<SaveResult, String> {
    let project = require_project(&state)?;

    let target: PathBuf = match path {
        Some(p) => PathBuf::from(p),
        None => {
            let stored = lock(&state.project_path)?.clone();
            stored.ok_or_else(|| "尚未指定保存路径".to_string())?
        }
    };

    serialize::save(&target, &project)?;
    *lock(&state.project_path)? = Some(target.clone());
    *lock(&state.project_dirty)? = false;
    Ok(SaveResult {
        path: target.to_string_lossy().into_owned(),
    })
}

/// 取当前项目快照。
#[tauri::command]
pub fn get_project(state: State<'_, AppState>) -> Result<Project, String> {
    require_project(&state)
}

/// 取当前项目文件路径；从未保存过时返回 None。
///
/// 界面靠它判断「保存」是直接写盘还是要先弹保存框。
#[tauri::command]
pub fn get_project_path(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(lock(&state.project_path)?
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned()))
}

/// 关闭项目并清理相关状态与缓存。
#[tauri::command]
pub fn close_project(state: State<'_, AppState>) -> Result<bool, String> {
    *lock(&state.project)? = None;
    *lock(&state.project_path)? = None;
    *lock(&state.project_dirty)? = false;
    lock(&state.keyframes)?.clear();
    lock(&state.dirty)?.clear();
    lock(&state.history)?.clear();
    *lock(&state.cache)? = Default::default();
    Ok(true)
}
