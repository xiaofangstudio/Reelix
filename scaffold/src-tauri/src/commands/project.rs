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
pub fn require_project(state: &State<'_, AppState>) -> Result<Project, String> {
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
    // 关键帧随工程一起回来：出场动画、摄像机环绕这些参数动画不能在重开后就消失。
    // 以前这里直接 clear()，等于每次打开都把用户做好的动画抹掉。
    lock(&state.keyframes)?.load_curves(project.curves.clone());
    lock(&state.dirty)?.clear();
    lock(&state.history)?.reset("打开项目", &project, &project.curves);
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

    // 落盘前把内存里的关键帧曲线打进工程快照：
    // 关键帧本来只活在内存里，不写进去的话关掉再开，所有动画都没了。
    let mut snapshot = project;
    snapshot.curves = lock(&state.keyframes)?.curves();
    serialize::save(&target, &snapshot)?;
    *lock(&state.project_path)? = Some(target.clone());
    *lock(&state.project_dirty)? = false;
    Ok(SaveResult {
        path: target.to_string_lossy().into_owned(),
    })
}

/// 取当前项目快照。
#[tauri::command]
pub fn get_project(state: State<'_, AppState>) -> Result<Project, String> {
    // 快照也带上关键帧曲线：前端据此判断哪些参数有动画，
    // 与保存时写入的完全一致，不会出现「界面说有动画、文件里却没有」。
    let mut project = require_project(&state)?;
    project.curves = lock(&state.keyframes)?.curves();
    Ok(project)
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

/// 工程自上次保存后有没有未落盘的改动。
/// 自动保存靠它决定要不要真写盘——没改动还每秒写一次是浪费。
#[tauri::command]
pub fn project_is_dirty(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(*lock(&state.project_dirty)?)
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

/// 让序列画幅与帧率自动适配某个素材（导入首个视频时用，剪映习惯）。
#[tauri::command]
pub fn adapt_sequence_to_asset(
    sequence_id: String,
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let mut project = require_project(&state)?;
    let asset = project
        .assets
        .iter()
        .find(|a| a.id == asset_id)
        .ok_or_else(|| "找不到素材".to_string())?
        .clone();
    let sequence = project
        .sequences
        .iter_mut()
        .find(|s| s.id == sequence_id)
        .ok_or_else(|| "找不到序列".to_string())?;
    if asset.width > 0 {
        sequence.width = asset.width;
    }
    if asset.height > 0 {
        sequence.height = asset.height;
    }
    if asset.frame_rate >= 1.0 {
        sequence.frame_rate = asset.frame_rate;
    }
    *lock(&state.project)? = Some(project.clone());
    Ok(project)
}

/// 用户主目录（示例工程放 Documents 用）。
#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|v| v.to_string_lossy().into_owned())
        .ok_or_else(|| "定位不到主目录".to_string())
}

/// 写一个文本文件（示例工程生成用；只写用户给的绝对路径）。
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(&path, contents).map_err(|e| format!("写文件失败：{e}"))
}
