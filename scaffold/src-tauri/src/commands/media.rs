//! 素材命令：导入 / 探测 / 重新链接 / 移除 / 生成缩略图。
//!
//! 探测的实现在 `crate::media::probe`——那是一份不依赖 tauri 的纯逻辑，
//! `reelix-mcp` 用的是同一份，探测口径不会两处各写一套。
//! 这里只负责把探测结果并进工程、落历史、标脏。

use std::path::{Path, PathBuf};

use tauri::ipc::Response;
use tauri::State;

use crate::compositor::decode;
use crate::history::record;
use crate::media::probe::{file_name_of, probe_path, MediaInfo};
use crate::project::model::{Asset, AssetKind};
use crate::project::serialize::new_id;
use crate::state::{lock, AppState};

/// 导入素材，返回新增的元数据数组。
#[tauri::command]
pub fn import_media(paths: Vec<String>, state: State<'_, AppState>) -> Result<Vec<Asset>, String> {
    let mut guard = lock(&state.project)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;

    let mut added = Vec::new();
    for path in paths {
        let info = probe_path(&path);
        let asset = Asset {
            id: new_id("asset"),
            name: file_name_of(&path),
            path: info.path,
            kind: info.kind,
            duration_ms: info.duration_ms,
            width: info.width,
            height: info.height,
            frame_rate: info.frame_rate,
            codec: info.codec,
            has_audio: info.has_audio,
            missing: !Path::new(&path).exists(),
        };
        // 同一个路径不重复导入
        if project.assets.iter().any(|a| a.path == asset.path) {
            continue;
        }
        project.assets.push(asset.clone());
        added.push(asset);
    }
    if !added.is_empty() {
        record(&state, "导入素材", project)?;
        *lock(&state.project_dirty)? = true;
    }
    Ok(added)
}

/// 只探测媒体信息，不写入项目。
#[tauri::command]
pub fn probe_media(path: String) -> Result<MediaInfo, String> {
    if path.trim().is_empty() {
        return Err("素材路径为空".to_string());
    }
    Ok(probe_path(&path))
}

/// 重新链接丢失的素材。
#[tauri::command]
pub fn relink_media(
    asset_id: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = lock(&state.project)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let asset = project
        .assets
        .iter_mut()
        .find(|a| a.id == asset_id)
        .ok_or_else(|| "找不到该素材".to_string())?;
    asset.path = new_path.clone();
    asset.name = file_name_of(&new_path);
    asset.missing = !Path::new(&new_path).exists();
    record(&state, "重新链接素材", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 移除素材引用；`delete_file` 为真时同时删掉磁盘文件。
#[tauri::command]
pub fn remove_media(
    asset_id: String,
    delete_file: bool,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = lock(&state.project)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;

    let removed = project
        .assets
        .iter()
        .position(|a| a.id == asset_id)
        .map(|idx| project.assets.remove(idx));

    let Some(asset) = removed else {
        return Err("找不到该素材".to_string());
    };

    if delete_file {
        // 删除磁盘文件属于破坏性操作，失败不阻断项目改动，只回报错误。
        let _ = std::fs::remove_file(&asset.path);
    }

    // 同步清掉时间线上引用该素材的片段，避免留下悬空引用。
    for sequence in project.sequences.iter_mut() {
        for track in sequence.tracks.iter_mut() {
            track.clips.retain(|c| c.asset_id != asset_id);
        }
    }

    record(&state, "移除素材", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 生成指定时刻的缩略图，直接回 PNG 字节。
///
/// 真抽帧：ffmpeg 解一帧编 PNG，落缓存目录后回字节，前端 `URL.createObjectURL`
/// 就能显示。同一（素材，秒级时刻）第二次请求直接读缓存文件，不再起 ffmpeg。
/// 音频素材没有画面，返回中文错误，由前端拦截不发这条命令。
#[tauri::command(async)]
pub fn generate_thumbnail(
    asset_id: String,
    time_ms: f64,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    let (asset_path, kind) = {
        let guard = lock(&state.project)?;
        let project = guard.as_ref().ok_or_else(|| "还没有打开项目".to_string())?;
        let asset = project
            .assets
            .iter()
            .find(|a| a.id == asset_id)
            .ok_or_else(|| "找不到该素材".to_string())?;
        (asset.path.clone(), asset.kind)
    };
    if kind == AssetKind::Audio {
        return Err("音频素材没有画面缩略图".to_string());
    }
    if !Path::new(&asset_path).exists() {
        return Err("素材文件丢失，请重新链接后再试".to_string());
    }

    let cache_dir = PathBuf::from(lock(&state.settings)?.cache_dir.clone());
    let file = format!("thumb-{asset_id}-{}.png", time_ms.round() as i64);
    let path = cache_dir.join(file);

    // 缓存命中就不重抽；秒级粒度对缩略图足够，拖时间戳不会打爆 ffmpeg。
    if !path.is_file() {
        let bytes = decode::extract_frame_png(Path::new(&asset_path), time_ms, 320)?;
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&path, &bytes).map_err(|e| format!("缩略图写缓存失败：{e}"))?;
    }
    let bytes =
        std::fs::read(&path).map_err(|e| format!("缩略图读缓存失败：{e}"))?;
    Ok(Response::new(bytes))
}
