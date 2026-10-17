//! 设置命令：读取 / 写入。
//!
//! 设置写在 `%APPDATA%\Reelix\settings.json`，由这一侧负责读写。
//! 没有云端同步，没有账号，配置只存在本机。

use tauri::State;

use crate::state::{lock, AppState};
use crate::storage::settings::Settings;

/// 读取设置。
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(lock(&state.settings)?.clone())
}

/// 写入设置，返回写入后的完整设置。
#[tauri::command]
pub fn set_settings(
    settings: Settings,
    state: State<'_, AppState>,
) -> Result<Settings, String> {
    let mut next = settings;
    next.clamp_preview_scale();
    next.save()?;

    // 预览缩放同步到运行时状态，不必等下次启动。
    lock(&state.preview)?.scale = next.preview_scale;
    *lock(&state.settings)? = next.clone();
    Ok(next)
}
