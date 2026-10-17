//! 关键帧命令：打点 / 删除 / 移动 / 切线 / 缓动 / 求值。
//!
//! 剪辑层与合成层共用同一套命令：`target_id` 既能是片段 id，也能是节点 id。
//! 曲线求值的权威实现始终在 `keyframe::curve` 里，前端只发命令、拿结果。

use tauri::State;

use crate::history::commit;
use crate::keyframe::model::{EasingPreset, Keyframe};
use crate::state::{lock, AppState};

/// 在某时刻打一个关键帧，已存在则覆盖。返回落定的那一帧。
#[tauri::command]
pub fn set_keyframe(
    target_id: String,
    param: String,
    time_ms: f64,
    value: f64,
    state: State<'_, AppState>,
) -> Result<Keyframe, String> {
    let keyframe = {
        let mut store = lock(&state.keyframes)?;
        store.set_keyframe(&target_id, &param, time_ms, value, EasingPreset::Linear)
    };

    // 目标若是图节点，点亮它标题栏的动画小圆点；是片段则忽略。
    mark_animated(&state, &target_id)?;
    lock(&state.dirty)?.mark(&target_id);
    commit(&state, "打关键帧")?;
    *lock(&state.project_dirty)? = true;
    Ok(keyframe)
}

/// 按 id 删除关键帧。
#[tauri::command]
pub fn remove_keyframe(keyframe_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let ok = lock(&state.keyframes)?.remove(&keyframe_id);
    if ok {
        commit(&state, "删除关键帧")?;
        *lock(&state.project_dirty)? = true;
    }
    Ok(ok)
}

/// 移动关键帧的时间与值。
#[tauri::command]
pub fn move_keyframe(
    keyframe_id: String,
    time_ms: f64,
    value: f64,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let ok = lock(&state.keyframes)?.move_keyframe(&keyframe_id, time_ms, value);
    if ok {
        commit(&state, "移动关键帧")?;
        *lock(&state.project_dirty)? = true;
    }
    Ok(ok)
}

/// 调整某一侧贝塞尔手柄。`side` 取 `"in"` 或 `"out"`。
#[tauri::command]
pub fn set_curve_tangent(
    keyframe_id: String,
    side: String,
    x: f64,
    y: f64,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let side_in = match side.as_str() {
        "in" => true,
        "out" => false,
        other => return Err(format!("未知的切线方向：{other}")),
    };
    let ok = lock(&state.keyframes)?.set_tangent(&keyframe_id, side_in, x, y);
    if ok {
        commit(&state, "调整曲线切线")?;
        *lock(&state.project_dirty)? = true;
    }
    Ok(ok)
}

/// 套用缓动预设。
#[tauri::command]
pub fn set_easing_preset(
    keyframe_id: String,
    preset: EasingPreset,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let ok = lock(&state.keyframes)?.set_easing(&keyframe_id, preset);
    if ok {
        commit(&state, "套用缓动")?;
        *lock(&state.project_dirty)? = true;
    }
    Ok(ok)
}

/// 求某时刻的参数值，用于属性面板实时回显。没有曲线时返回 0。
#[tauri::command]
pub fn evaluate_param(
    target_id: String,
    param: String,
    time_ms: f64,
    state: State<'_, AppState>,
) -> Result<f64, String> {
    let value = lock(&state.keyframes)?
        .evaluate(&target_id, &param, time_ms)
        .unwrap_or(0.0);
    Ok(value)
}

/// 目标若是图节点，同步它的「有关键帧」小圆点。
fn mark_animated(state: &State<'_, AppState>, target_id: &str) -> Result<(), String> {
    let mut guard = lock(&state.project)?;
    let Some(project) = guard.as_mut() else {
        return Ok(());
    };
    for graph in project.graphs.values_mut() {
        if let Some(node) = graph.node_mut(target_id) {
            node.animated = true;
            return Ok(());
        }
    }
    Ok(())
}
