//! 历史命令：撤销 / 重做 / 列表 / 跳转。
//!
//! 剪辑操作与特效操作在同一个撤销栈里，用户按一次 Ctrl+Z，
//! 撤销的是他上一次做的任何事，不区分属于哪一层。

use serde::Serialize;
use tauri::State;

use crate::history::HistoryEntry;
use crate::keyframe::model::Curve;
use crate::state::{lock, AppState};

/// 撤销 / 重做的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    pub ok: bool,
    /// 中文描述，用于状态栏提示
    pub description: String,
}

/// 用历史快照替换当前项目与关键帧。
fn apply(
    state: &State<'_, AppState>,
    project: crate::project::model::Project,
    keyframes: Vec<Curve>,
) -> Result<(), String> {
    *lock(&state.project)? = Some(project);
    lock(&state.keyframes)?.load_curves(keyframes);
    *lock(&state.project_dirty)? = true;
    Ok(())
}

/// 撤销上一步。
#[tauri::command]
pub fn undo(state: State<'_, AppState>) -> Result<UndoResult, String> {
    let snapshot = lock(&state.history)?.undo();
    match snapshot {
        Some((description, project, keyframes)) => {
            apply(&state, project, keyframes)?;
            Ok(UndoResult { ok: true, description })
        }
        None => Ok(UndoResult {
            ok: false,
            description: "没有可撤销的操作".into(),
        }),
    }
}

/// 重做下一步。
#[tauri::command]
pub fn redo(state: State<'_, AppState>) -> Result<UndoResult, String> {
    let snapshot = lock(&state.history)?.redo();
    match snapshot {
        Some((description, project, keyframes)) => {
            apply(&state, project, keyframes)?;
            Ok(UndoResult { ok: true, description })
        }
        None => Ok(UndoResult {
            ok: false,
            description: "没有可重做的操作".into(),
        }),
    }
}

/// 取历史列表。
#[tauri::command]
pub fn get_history(state: State<'_, AppState>) -> Result<Vec<HistoryEntry>, String> {
    Ok(lock(&state.history)?.list())
}

/// 跳到某个历史点。
#[tauri::command]
pub fn jump_history(index: usize, state: State<'_, AppState>) -> Result<bool, String> {
    let snapshot = lock(&state.history)?.jump(index);
    match snapshot {
        Some((project, keyframes)) => {
            apply(&state, project, keyframes)?;
            Ok(true)
        }
        None => Ok(false),
    }
}
