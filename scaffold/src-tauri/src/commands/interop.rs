//! 跨软件联动：Strata（修图）→ Reelix（剪辑）。
//!
//! 机制（投递箱）：
//! Strata 把改好的 PNG 写进
//!    `%LOCALAPPDATA%\Reelix\dropbox\`；Reelix 下次启动 / 每次获得焦点时
//!    扫这个目录，有新文件就导入并清掉（避免重复导入）。
//!
//! 导入就是「登记进素材箱」（PNG 图片素材），前端收到事件后弹提示，
//! 用户从素材箱拖上轨。默认格式 PNG——Strata 侧导出时用 PNG。

use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

/// 投递箱目录：`%LOCALAPPDATA%\Reelix\dropbox`。
pub fn dropbox_dir() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))?;
    Some(base.join("Reelix").join("dropbox"))
}

/// Strata 送来的图片落地文件名约定：`strata-<毫秒时间戳>-<随机>.png`。
/// 只认 `strata-` 前缀的 `.png`，用户自己扔进来的其他文件不碰。

/// 写心跳：Strata 靠它判断 Reelix 是否正在运行（10 秒过期）。
fn write_heartbeat(base: &std::path::Path) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let json = format!("{{\"ts\":{}}}", now);
    let _ = std::fs::create_dir_all(base);
    let _ = std::fs::write(base.join("heartbeat.json"), json);
}

/// 扫投递箱，把新图片登记进素材箱。返回本次导入的素材数。
#[tauri::command]
pub fn import_dropbox(app: AppHandle) -> Result<usize, String> {
    let Some(dir) = dropbox_dir() else {
        return Ok(0);
    };
    if !dir.is_dir() {
        // 投递箱还没建：建出来并写心跳（Strata 探测用）
        let _ = std::fs::create_dir_all(&dir);
        write_heartbeat(dir.parent().unwrap_or(&dir));
        return Ok(0);
    }
    write_heartbeat(dir.parent().unwrap_or(&dir));
    let mut imported = 0usize;
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("读投递箱失败：{e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        // 只收 Strata 送来的（前缀约定），且只收 png
        if !name.starts_with("strata-") || !name.ends_with(".png") {
            continue;
        }
        let Some(state) = app.try_state::<crate::AppState>() else {
            continue;
        };
        let added = crate::commands::media::import_media(
            vec![path.to_string_lossy().into_owned()],
            state,
        );
        match added {
            Ok(assets) if !assets.is_empty() => {
                imported += assets.len();
                let _ = std::fs::remove_file(&path);
                let _ = app.emit(
                    "reelix://strata-imported",
                    serde_json::json!({ "count": assets.len(), "names": assets.iter().map(|a| a.name.clone()).collect::<Vec<_>>() }),
                );
            }
            _ => {
                // 导入失败（缺工程等）：留着下次再试，不删文件
            }
        }
    }
    Ok(imported)
}

/// Reelix 是否在跑（Strata 侧探测用）：本地端口探活由 Strata 做深链触发，
/// 这里只提供投递箱路径，Strata 写不进去就知道没装。
#[tauri::command]
pub fn dropbox_path() -> Result<String, String> {
    dropbox_dir()
        .map(|d| d.to_string_lossy().into_owned())
        .ok_or_else(|| "定位不到本机数据目录".to_string())
}
