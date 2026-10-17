//! 时间线命令：加/移/裁/切/删片段，加/删轨道。
//!
//! 这些操作既要维护轨道结构，也要与图节点保持对应——片段上的 `node_id` 就是接口。
//! 每一次成功改动都会记入撤销栈（`history::record`），让 Ctrl+Z 能一路退回去。

use tauri::State;

use crate::history::record;
use crate::project::model::Project;
use crate::project::serialize::new_id;
use crate::state::{lock, AppState};
use crate::timeline::model::{Clip, Track, TrackKind};

fn require_project<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, Option<Project>>, String> {
    let guard = lock(&state.project)?;
    if guard.is_none() {
        return Err("还没有打开项目".to_string());
    }
    Ok(guard)
}

fn find_clip_mut<'a>(project: &'a mut Project, clip_id: &str) -> Option<&'a mut Clip> {
    for sequence in project.sequences.iter_mut() {
        for track in sequence.tracks.iter_mut() {
            if let Some(idx) = track.clips.iter().position(|c| c.id == clip_id) {
                return Some(&mut track.clips[idx]);
            }
        }
    }
    None
}

fn find_track_mut<'a>(project: &'a mut Project, track_id: &str) -> Option<&'a mut Track> {
    for sequence in project.sequences.iter_mut() {
        if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == track_id) {
            return Some(track);
        }
    }
    None
}

fn default_height(kind: TrackKind) -> f64 {
    match kind {
        TrackKind::Video => 64.0,
        TrackKind::Audio => 48.0,
        TrackKind::Camera => 44.0,
        TrackKind::Subtitle => 40.0,
    }
}

/// 加一个片段到指定轨道。返回新片段。
///
/// `compound_id`：视音频链接组 id——同一个视频素材的画面与声音分别落在
/// 视频轨与音频轨时，两段共用同一个 compound_id（达芬奇/PR 的「默认粘起来」），
/// 序列里没有其它片段带这个 id 时就它自己一组，不影响单独剪辑。
#[tauri::command]
pub fn add_clip(
    track_id: String,
    asset_id: String,
    start_ms: f64,
    duration_ms: f64,
    compound_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Clip, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;

    let clip = Clip {
        id: new_id("clip"),
        asset_id,
        track_id: track_id.clone(),
        start_ms,
        duration_ms,
        in_ms: 0.0,
        out_ms: duration_ms,
        speed: 1.0,
        reversed: false,
        // 每个片段对应一个图节点，剪辑与特效从这里接上
        node_id: new_id("node"),
        compound_id,
        enable_3d: false,
        transform_3d: None,
        text: None,
    };

    let track = find_track_mut(project, &track_id).ok_or_else(|| "找不到该轨道".to_string())?;
    track.clips.push(clip.clone());
    track
        .clips
        .sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap_or(std::cmp::Ordering::Equal));

    record(&state, "添加片段", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(clip)
}

/// 移动片段起点；给了 `track_id` 就顺带跨轨搬过去。
#[tauri::command]
pub fn move_clip(
    clip_id: String,
    start_ms: f64,
    track_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;

    let target_track = track_id.as_deref();
    let current_track = project
        .sequences
        .iter()
        .flat_map(|s| s.tracks.iter())
        .find(|t| t.clips.iter().any(|c| c.id == clip_id))
        .map(|t| t.id.clone())
        .ok_or_else(|| "找不到该片段".to_string())?;

    let cross_track = matches!(target_track, Some(id) if id != current_track);

    if cross_track {
        // 先确认目标轨道存在，避免把片段从原轨道摘下来后无处安放
        let target_ok = project
            .sequences
            .iter()
            .flat_map(|s| s.tracks.iter())
            .any(|t| Some(t.id.as_str()) == target_track);
        if !target_ok {
            return Err("找不到目标轨道".to_string());
        }
        let mut moved: Option<Clip> = None;
        for sequence in project.sequences.iter_mut() {
            for track in sequence.tracks.iter_mut() {
                if track.id == current_track {
                    if let Some(idx) = track.clips.iter().position(|c| c.id == clip_id) {
                        moved = Some(track.clips.remove(idx));
                    }
                }
            }
        }
        let mut moved = moved.ok_or_else(|| "找不到该片段".to_string())?;
        moved.start_ms = start_ms.max(0.0);
        moved.track_id = target_track.unwrap_or_default().to_string();
        let new_track_id = moved.track_id.clone();
        let dest = project
            .sequences
            .iter_mut()
            .flat_map(|s| s.tracks.iter_mut())
            .find(|t| t.id == new_track_id)
            .ok_or_else(|| "找不到目标轨道".to_string())?;
        dest.clips.push(moved);
        dest.clips
            .sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap_or(std::cmp::Ordering::Equal));
    } else {
        let clip = find_clip_mut(project, &clip_id).ok_or_else(|| "找不到该片段".to_string())?;
        clip.start_ms = start_ms.max(0.0);
    }

    record(&state, "移动片段", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 裁剪片段：给出新的素材入点/出点。
#[tauri::command]
pub fn trim_clip(
    clip_id: String,
    in_ms: f64,
    out_ms: f64,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let clip = find_clip_mut(project, &clip_id).ok_or_else(|| "找不到该片段".to_string())?;

    let start = in_ms.min(out_ms).max(0.0);
    let end = out_ms.max(in_ms).max(0.0);
    let speed = if clip.speed.abs() < f64::EPSILON {
        1.0
    } else {
        clip.speed
    };
    clip.in_ms = start;
    clip.out_ms = end;
    clip.duration_ms = ((end - start) / speed.abs()).max(0.0);

    record(&state, "裁剪片段", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 在指定时刻切割片段，返回切出来的右半段。
#[tauri::command]
pub fn split_clip(clip_id: String, at_ms: f64, state: State<'_, AppState>) -> Result<Clip, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;

    // 先在轨道里完成切割，拿到右半段；离开借用范围后再记入撤销栈。
    let mut result: Option<Clip> = None;
    for sequence in project.sequences.iter_mut() {
        for track in sequence.tracks.iter_mut() {
            let Some(idx) = track.clips.iter().position(|c| c.id == clip_id) else {
                continue;
            };
            let left = track.clips[idx].clone();
            if at_ms <= left.start_ms || at_ms >= left.end_ms() {
                return Err("切割点必须落在片段内部".to_string());
            }
            let offset = at_ms - left.start_ms;
            let speed = if left.speed.abs() < f64::EPSILON {
                1.0
            } else {
                left.speed
            };

            let mut right = left.clone();
            right.id = new_id("clip");
            right.start_ms = at_ms;
            right.duration_ms = left.duration_ms - offset;
            right.in_ms = left.in_ms + offset * speed;
            // 右半段是独立片段：必须有自己的图节点，否则两半共用一条效果链，
            // 左半段调色会连带右半段变色。链接组同理，拆开才不会互相拖走。
            right.node_id = new_id("node");
            right.compound_id = left.compound_id.as_ref().map(|_| new_id("compound"));

            // 左半段保留原入点，出点收到切割处
            let left_out = left.in_ms + offset * speed;
            track.clips[idx].duration_ms = offset;
            track.clips[idx].out_ms = left_out;
            track.clips.insert(idx + 1, right.clone());

            result = Some(right);
            break;
        }
        if result.is_some() {
            break;
        }
    }

    match result {
        Some(right) => {
            record(&state, "切割片段", project)?;
            *lock(&state.project_dirty)? = true;
            Ok(right)
        }
        None => Err("找不到该片段".to_string()),
    }
}

/// 批量删除片段。
#[tauri::command]
pub fn delete_clips(clip_ids: Vec<String>, state: State<'_, AppState>) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    for sequence in project.sequences.iter_mut() {
        for track in sequence.tracks.iter_mut() {
            track.clips.retain(|c| !clip_ids.contains(&c.id));
        }
    }

    record(&state, "删除片段", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 设置片段速度（保持素材范围，改变时间线上的时长）。
#[tauri::command]
pub fn set_clip_speed(
    clip_id: String,
    speed: f64,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    if !(0.1..=100.0).contains(&speed.abs()) {
        return Err("速度必须在 0.1 ~ 100 之间".to_string());
    }
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let clip = find_clip_mut(project, &clip_id).ok_or_else(|| "找不到该片段".to_string())?;
    clip.speed = speed;
    let source_span = (clip.out_ms - clip.in_ms).abs();
    clip.duration_ms = (source_span / speed.abs()).max(0.0);

    record(&state, "修改片段速度", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 加一条轨道（视频 / 音频 / 摄像机 / 字幕）。
///
/// `sequence_id` 指定落在哪条序列上；不给就用第一条。
/// 之前这里无条件写 `sequences[0]`，多序列工程里加轨会加到看不见的地方去。
#[tauri::command]
pub fn add_track(
    kind: TrackKind,
    sequence_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Track, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let sequence = match sequence_id {
        Some(id) => project
            .sequences
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| "找不到该序列".to_string())?,
        None => project
            .sequences
            .first_mut()
            .ok_or_else(|| "项目里还没有序列".to_string())?,
    };

    let index = sequence
        .tracks
        .iter()
        .filter(|t| t.kind == kind)
        .count() as i32;

    let track = Track {
        id: new_id("track"),
        kind,
        index,
        muted: false,
        solo: false,
        locked: false,
        hidden: false,
        height: default_height(kind),
        clips: Vec::new(),
    };
    sequence.tracks.push(track.clone());

    record(&state, "添加轨道", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(track)
}

/// 删除轨道（连同其上的片段）。
#[tauri::command]
pub fn remove_track(track_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;

    let mut removed = false;
    for sequence in project.sequences.iter_mut() {
        let before = sequence.tracks.len();
        sequence.tracks.retain(|t| t.id != track_id);
        if sequence.tracks.len() != before {
            removed = true;
            break;
        }
    }

    if removed {
        record(&state, "删除轨道", project)?;
        *lock(&state.project_dirty)? = true;
        Ok(true)
    } else {
        Err("找不到该轨道".to_string())
    }
}

/// 轨道开关：静音 / 隐藏 / 锁定 / 独奏。
///
/// 时间线 gutter 上的四个小按钮走这里。之前它们是纯装饰，
/// 点了不生效，轨道状态永远是导入时的默认值。
#[tauri::command]
pub fn set_track_flags(
    track_id: String,
    muted: Option<bool>,
    hidden: Option<bool>,
    locked: Option<bool>,
    solo: Option<bool>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let track = find_track_mut(project, &track_id).ok_or_else(|| "找不到该轨道".to_string())?;
    if let Some(v) = muted {
        track.muted = v;
    }
    if let Some(v) = hidden {
        track.hidden = v;
    }
    if let Some(v) = locked {
        track.locked = v;
    }
    if let Some(v) = solo {
        track.solo = v;
    }

    record(&state, "轨道开关", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}
