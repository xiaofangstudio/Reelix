//! 时间线命令：加/移/裁/切/删片段，加/删轨道。
//!
//! 这些操作既要维护轨道结构，也要与图节点保持对应——片段上的 `node_id` 就是接口。
//! 每一次成功改动都会记入撤销栈（`history::record`），让 Ctrl+Z 能一路退回去。

use tauri::State;

use crate::history::record;
use crate::project::model::{Bin, Marker, Project, Sequence};
use crate::project::serialize::new_id;
use crate::state::{lock, AppState};
use crate::timeline::model::{
    Clip, SpeedKey, Track, TrackKind, Transform3D, Transition, DEFAULT_SEQUENCE_MS,
};

/// 序列时长 = 最靠后的片段出点；空序列保留默认时长。
///
/// 加/移/裁/切/删/改速片段后都必须重算——时长是标尺刻度、播放头范围、
/// 导出区间的唯一来源。漏一次，用户就会看到「标尺空的、播放头拖不动、
/// 监视器停住」（工程时长永远是 0 的老 bug）。
/// 有片段就严格跟内容走（10s 的片子就是 10s，不拿默认值撑大）；
/// 一条片段都没有时才给默认时长，保证空工程也有可用的标尺。
pub(crate) fn recompute_sequence_duration(sequence: &mut Sequence) {
    let mut end = 0.0f64;
    let mut any = false;
    for track in &sequence.tracks {
        for clip in &track.clips {
            end = end.max(clip.end_ms());
            any = true;
        }
    }
    sequence.duration_ms = if any {
        // 至少 1s：零长片段不至于把时长压成 0
        end.max(1000.0)
    } else {
        DEFAULT_SEQUENCE_MS
    };
}

/// 按轨道 id 反查它所在的序列（可变）。
fn sequence_of<'a>(project: &'a mut Project, track_id: &str) -> &'a mut Sequence {
    // 轨道必然属于某条序列；真找不到就退到第一条，绝不 panic。
    let idx = project
        .sequences
        .iter()
        .position(|s| s.tracks.iter().any(|t| t.id == track_id))
        .unwrap_or(0);
    &mut project.sequences[idx]
}

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
        speed_curve: None,
        audio_pitch_shift: false,
        // 每个片段对应一个图节点，剪辑与特效从这里接上
        node_id: new_id("node"),
        compound_id,
        enable_3d: false,
        transform_3d: None,
        text: None,
        enabled: true,
        label: None,
        transition_in: None,
        transition_out: None,
        audio_fade_in_ms: None,
        audio_highpass_hz: None,
        audio_lowpass_hz: None,
        audio_delay_ms: None,
        audio_fade_out_ms: None,
    };

    let track = find_track_mut(project, &track_id).ok_or_else(|| "找不到该轨道".to_string())?;
    track.clips.push(clip.clone());
    track
        .clips
        .sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap_or(std::cmp::Ordering::Equal));
    recompute_sequence_duration(sequence_of(project, &track_id));

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
    recompute_sequence_duration(sequence_of(project, &current_track));

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
    clip.in_ms = start;
    clip.out_ms = end;
    // 曲线变速：时长按逆积分算（源长 → 片段内时长）；恒定速度就是除法
    clip.duration_ms = if clip.has_speed_curve() {
        clip.local_for_source((end - start).abs()).max(0.0)
    } else {
        let speed = clip.base_speed();
        ((end - start) / speed.abs()).max(0.0)
    };
    let track_id = clip.track_id.clone();
    recompute_sequence_duration(sequence_of(project, &track_id));

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
    let mut cut_track_id: Option<String> = None;
    for sequence in project.sequences.iter_mut() {
        for track in sequence.tracks.iter_mut() {
            let Some(idx) = track.clips.iter().position(|c| c.id == clip_id) else {
                continue;
            };
            cut_track_id = Some(track.id.clone());
            let left = track.clips[idx].clone();
            if at_ms <= left.start_ms || at_ms >= left.end_ms() {
                return Err("切割点必须落在片段内部".to_string());
            }
            let offset = at_ms - left.start_ms;
            // 曲线变速：源偏移按积分算；恒定速度就是乘法
            let src_offset = left.source_offset(offset);

            let mut right = left.clone();
            right.id = new_id("clip");
            right.start_ms = at_ms;
            right.duration_ms = left.duration_ms - offset;
            right.in_ms = left.in_ms + src_offset;
            // 右半段是独立片段：必须有自己的图节点，否则两半共用一条效果链，
            // 左半段调色会连带右半段变色。链接组同理，拆开才不会互相拖走。
            right.node_id = new_id("node");
            right.compound_id = left.compound_id.as_ref().map(|_| new_id("compound"));
            // 曲线跟着重定基：右半段的 tMs 从切割点重新起算，
            // 并在切割点补一个关键点，速度才不会在缝上跳变。
            right.speed_curve = left.speed_curve.as_ref().map(|keys| {
                let seam_speed = left.speed_at(offset);
                let mut ks: Vec<SpeedKey> = keys
                    .iter()
                    .filter(|k| k.t_ms > offset)
                    .map(|k| SpeedKey {
                        t_ms: k.t_ms - offset,
                        speed: k.speed,
                    })
                    .collect();
                ks.insert(
                    0,
                    SpeedKey {
                        t_ms: 0.0,
                        speed: seam_speed,
                    },
                );
                // 尾点必须落在右半段末尾
                if let Some(last) = ks.last_mut() {
                    last.t_ms = right.duration_ms.max(0.0);
                }
                ks
            });

            // 左半段保留原入点，出点收到切割处
            let left_out = left.in_ms + src_offset;
            track.clips[idx].duration_ms = offset;
            track.clips[idx].out_ms = left_out;
            // 左半段曲线尾点同样压到切割处
            if let Some(keys) = track.clips[idx].speed_curve.as_mut() {
                if let Some(last) = keys.last_mut() {
                    last.t_ms = offset.max(0.0);
                }
            }
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
            if let Some(tid) = cut_track_id {
                recompute_sequence_duration(sequence_of(project, &tid));
            }
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
    let mut touched: Option<String> = None;
    for sequence in project.sequences.iter_mut() {
        for track in sequence.tracks.iter_mut() {
            if track.clips.iter().any(|c| clip_ids.contains(&c.id)) {
                touched = Some(track.id.clone());
                track.clips.retain(|c| !clip_ids.contains(&c.id));
            }
        }
    }
    if let Some(tid) = touched {
        recompute_sequence_duration(sequence_of(project, &tid));
    }

    record(&state, "删除片段", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 设置恒定倍速。会同时清掉曲线变速——两条路数不能同时生效，
/// 拖速度滑条就等于退出曲线模式（剪映同款语义）。
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
    clip.speed_curve = None;
    let source_span = (clip.out_ms - clip.in_ms).abs();
    clip.duration_ms = (source_span / speed.abs()).max(0.0);
    let track_id = clip.track_id.clone();
    recompute_sequence_duration(sequence_of(project, &track_id));

    record(&state, "修改片段速度", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 设置 / 清除曲线变速（剪映同款折线：片段内时刻 → 速度）。
///
/// 传入 None 或不足两个点 = 清除曲线，回落到恒定 `speed`。
/// 曲线会按片段时长归一化：tMs 夹到 [0, durationMs]，速度夹到 [0.01, 100]。
/// 设了曲线后，片段时长按曲线积分重算（源长固定，时长随曲线变）。
#[tauri::command]
pub fn set_clip_speed_curve(
    clip_id: String,
    curve: Option<Vec<SpeedKey>>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let clip = find_clip_mut(project, &clip_id).ok_or_else(|| "找不到该片段".to_string())?;

    let normalized: Option<Vec<SpeedKey>> = curve.and_then(|keys| {
        if keys.len() < 2 {
            return None;
        }
        let mut ks: Vec<SpeedKey> = keys
            .into_iter()
            .map(|k| SpeedKey {
                t_ms: k.t_ms.clamp(0.0, clip.duration_ms.max(0.0)),
                speed: k.speed.clamp(0.01, 100.0),
            })
            .collect();
        ks.sort_by(|a, b| a.t_ms.partial_cmp(&b.t_ms).unwrap_or(std::cmp::Ordering::Equal));
        // 端点必须压在片段头尾，否则首尾速度会漏出曲线
        if let Some(first) = ks.first_mut() {
            first.t_ms = 0.0;
        }
        if let Some(last) = ks.last_mut() {
            last.t_ms = clip.duration_ms.max(0.0);
        }
        Some(ks)
    });

    clip.speed_curve = normalized;
    if clip.has_speed_curve() {
        // 源长不变，时长按积分重算：duration = F⁻¹(out - in)
        let span = (clip.out_ms - clip.in_ms).abs();
        clip.duration_ms = clip.local_for_source(span).max(0.0);
        // speed 字段退居「无曲线时的兜底」，同步成均速让 UI 显示不掉链
        clip.speed = clip.average_speed();
    }
    let track_id = clip.track_id.clone();
    recompute_sequence_duration(sequence_of(project, &track_id));

    record(&state, "修改变速曲线", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 声音变调开关（剪映同款）：开 → 变速时音高随速度变；关 → 保调。
#[tauri::command]
pub fn set_clip_pitch_shift(
    clip_id: String,
    pitch_shift: bool,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let clip = find_clip_mut(project, &clip_id).ok_or_else(|| "找不到该片段".to_string())?;
    clip.audio_pitch_shift = pitch_shift;
    record(&state, "切换声音变调", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 片段倒放开关（剪映同款）。
#[tauri::command]
pub fn set_clip_reversed(
    clip_id: String,
    reversed: bool,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let clip = find_clip_mut(project, &clip_id).ok_or_else(|| "找不到该片段".to_string())?;
    clip.reversed = reversed;
    record(&state, "切换片段倒放", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 片段开关：启用 / 禁用、标签颜色（右键菜单与标签子菜单用）。
/// 禁用的片段不参与预览与导出（渲染时跳过，见 render.rs 的 `c.enabled`）。
#[tauri::command]
pub fn set_clip_flags(
    clip_id: String,
    enabled: Option<bool>,
    label: Option<String>,
    enable_3d: Option<bool>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let clip = find_clip_mut(project, &clip_id).ok_or_else(|| "找不到该片段".to_string())?;
    if let Some(v) = enabled {
        clip.enabled = v;
    }
    if let Some(l) = label {
        clip.label = if l.is_empty() { None } else { Some(l) };
    }
    // 「启用 3D」图层开关：真写进工程。之前界面只改本地 store，
    // 下一次拉快照就被权威数据洗掉、导出时后端也读不到——典型的「按下没反应」。
    if let Some(v) = enable_3d {
        clip.enable_3d = v;
        if v && clip.transform_3d.is_none() {
            clip.transform_3d = Some(Transform3D::default());
        }
        if !v {
            clip.transform_3d = None;
        }
    }
    record(&state, "修改片段开关", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 写片段的 3D 变换（位置 / 旋转 / 缩放 / 锚点 / 受光）。
///
/// 3D 图层的位置、朝向是真能改的：这里只接数值，怎么用由合成器决定。
/// 没给就保留原值，方便界面只改其中一个轴。
#[tauri::command]
pub fn set_clip_transform_3d(
    clip_id: String,
    position: Option<crate::timeline::model::Vec3>,
    rotation: Option<crate::timeline::model::Vec3>,
    scale: Option<f64>,
    anchor: Option<crate::timeline::model::Vec2>,
    receive_light: Option<bool>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let clip = find_clip_mut(project, &clip_id).ok_or_else(|| "找不到该片段".to_string())?;

    let node_id = clip.node_id.clone();
    let t = clip.transform_3d.get_or_insert_with(Transform3D::default);
    if let Some(p) = position {
        t.position = p;
    }
    if let Some(r) = rotation {
        t.rotation = r;
    }
    if let Some(s) = scale {
        t.scale = s;
    }
    if let Some(a) = anchor {
        t.anchor = a;
    }
    if let Some(l) = receive_light {
        t.receive_light = l;
    }
    // 改了 3D 参数就当它是 3D 图层，避免用户拖了半天发现开关没开
    clip.enable_3d = true;

    // 让这一段的渲染缓存失效，监视器才刷得出新姿态
    lock(&state.engine)?.invalidate(&node_id);
    record(&state, "修改 3D 变换", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 取消视音频链接：清除该片段所在链接组的 compound_id（PR 的 Unlink）。
/// 点组内任意一段，整组分开——画面与声音从此各自独立。
#[tauri::command]
pub fn unlink_compound(clip_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let clip = find_clip_mut(project, &clip_id).ok_or_else(|| "找不到该片段".to_string())?;
    let compound = match clip.compound_id.take() {
        Some(id) => id,
        None => return Ok(false), // 本来就没链接，安静返回
    };
    // 整组解除：所有共用这个 compound_id 的片段一起清掉
    for sequence in &mut project.sequences {
        for track in &mut sequence.tracks {
            for c in &mut track.clips {
                if c.compound_id.as_deref() == Some(compound.as_str()) {
                    c.compound_id = None;
                }
            }
        }
    }
    record(&state, "取消视音频链接", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 加一条轨道（视频 / 音频 / 摄像机 / 字幕）。
///
/// `sequence_id` 指定落在哪条序列上；不给就用第一条。
/// 之前这里无条件写 `sequences[0]`，多序列工程里加轨会加到看不见的地方去。
///
/// 新轨沉底：index 取同类型现存最大值 + 1，时间线行按 index 升序排
/// （index 小的在上），所以最大值的新轨落在最下面——剪映/PR 都是往下加轨。
///
/// 编号也因此顺着 V1 → V2 → V3 递增。老代码用「最小值 - 1」配降序排序，
/// 得出 -1 会显示成 V0 / V-1，用户看到就是「顶上莫名冒出一条不明轨道」。
pub fn next_track_index(tracks: &[Track], kind: TrackKind) -> i32 {
    tracks
        .iter()
        .filter(|t| t.kind == kind)
        .map(|t| t.index)
        .max()
        .map(|m| m + 1)
        .unwrap_or(0)
}

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

    let index = next_track_index(&sequence.tracks, kind);

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
    let mut removed_from: Option<String> = None;
    for sequence in project.sequences.iter_mut() {
        let before = sequence.tracks.len();
        sequence.tracks.retain(|t| t.id != track_id);
        if sequence.tracks.len() != before {
            removed = true;
            removed_from = Some(sequence.id.clone());
            break;
        }
    }

    if removed {
        // 删轨会带走它的片段，时长要跟着重算
        if let Some(seq_id) = removed_from {
            if let Some(seq) = project.sequences.iter_mut().find(|s| s.id == seq_id) {
                recompute_sequence_duration(seq);
            }
        }
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

/// 找到指定序列（不给 id 时取第一条）。
fn find_sequence_mut<'a>(project: &'a mut Project, sequence_id: Option<&str>) -> Option<&'a mut Sequence> {
    match sequence_id {
        Some(id) => project.sequences.iter_mut().find(|s| s.id == id),
        None => project.sequences.first_mut(),
    }
}

/// 设置片段的转场（入场叠化）。
///
/// `kind` 传 none/空串表示清除转场。可用的转场由合成器实现：
/// `crossDissolve`（叠化）、`dipToBlack`（黑场过渡）、`dipToWhite`（白场过渡）。
/// 转场时长不能超过片段自身时长，超出时按片段时长钳制。
#[tauri::command]
pub fn set_transition(
    clip_id: String,
    kind: Option<String>,
    duration_ms: Option<f64>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;

    let clip = find_clip_mut(project, &clip_id).ok_or_else(|| "找不到该片段".to_string())?;

    match kind.as_deref() {
        None | Some("") | Some("none") => {
            clip.transition_in = None;
        }
        Some(kind) => {
            let kind = match kind {
                "crossDissolve" | "dipToBlack" | "dipToWhite" | "slidePush" | "slidePull" | "wipeLinear" | "wipeRadial" | "wipeBlinds" | "zoomCross" | "fade" => {
                    if kind == "fade" { "crossDissolve".to_string() } else { kind.to_string() }
                }
                other => return Err(format!("不支持的转场类型：{other}")),
            };
            let max = clip.duration_ms.max(1.0);
            let duration = duration_ms.unwrap_or(500.0).clamp(1.0, max);
            clip.transition_in = Some(Transition {
                kind,
                duration_ms: duration,
            });
        }
    }

    record(&state, "设置转场", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 设置 / 清除尾部淡出（剪映的「淡出」）。挂在片段属性上，
/// 不是效果栈里的一项——用户明确要求转场各归其位。
#[tauri::command]
pub fn set_clip_transition_out(
    clip_id: String,
    kind: Option<String>,
    duration_ms: Option<f64>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;

    let clip = find_clip_mut(project, &clip_id).ok_or_else(|| "找不到该片段".to_string())?;

    match kind.as_deref() {
        None | Some("") | Some("none") => {
            clip.transition_out = None;
        }
        Some(kind) => {
            // 淡出只向黑/白渐隐；其余类型没有「尾部」语义，按黑场处理
            let kind = match kind {
                "dipToBlack" | "dipToWhite" | "fade" => {
                    if kind == "fade" { "dipToBlack".to_string() } else { kind.to_string() }
                }
                other => return Err(format!("淡出只支持黑场/白场：{other}")),
            };
            let max = clip.duration_ms.max(1.0);
            let duration = duration_ms.unwrap_or(500.0).clamp(1.0, max);
            clip.transition_out = Some(Transition {
                kind,
                duration_ms: duration,
            });
        }
    }

    record(&state, "设置淡出", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 设置音频片段的淡入淡出时长（毫秒）。传 0 表示取消。
#[tauri::command]
pub fn set_audio_fade(
    clip_id: String,
    fade_in_ms: Option<f64>,
    fade_out_ms: Option<f64>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;

    let clip = find_clip_mut(project, &clip_id).ok_or_else(|| "找不到该片段".to_string())?;
    let max = clip.duration_ms.max(1.0);

    if let Some(v) = fade_in_ms {
        clip.audio_fade_in_ms = if v <= 0.0 { None } else { Some(v.clamp(1.0, max)) };
    }
    if let Some(v) = fade_out_ms {
        clip.audio_fade_out_ms = if v <= 0.0 { None } else { Some(v.clamp(1.0, max)) };
    }

    record(&state, "设置音频淡入淡出", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 在指定时刻加一个时间线标记，返回新标记。
#[tauri::command]
pub fn add_marker(
    sequence_id: Option<String>,
    time_ms: f64,
    name: Option<String>,
    state: State<'_, AppState>,
) -> Result<Marker, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let sequence =
        find_sequence_mut(project, sequence_id.as_deref()).ok_or_else(|| "找不到该序列".to_string())?;

    let marker = Marker {
        id: new_id("marker"),
        time_ms: time_ms.max(0.0),
        name,
    };
    sequence.markers.push(marker.clone());
    sequence
        .markers
        .sort_by(|a, b| a.time_ms.partial_cmp(&b.time_ms).unwrap_or(std::cmp::Ordering::Equal));

    record(&state, "添加标记", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(marker)
}

/// 删除一个时间线标记。
#[tauri::command]
pub fn remove_marker(
    sequence_id: Option<String>,
    marker_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let sequence =
        find_sequence_mut(project, sequence_id.as_deref()).ok_or_else(|| "找不到该序列".to_string())?;

    let before = sequence.markers.len();
    sequence.markers.retain(|m| m.id != marker_id);
    if sequence.markers.len() == before {
        return Err("找不到该标记".to_string());
    }

    record(&state, "删除标记", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 移动标记到新的时刻。
#[tauri::command]
pub fn move_marker(
    sequence_id: Option<String>,
    marker_id: String,
    time_ms: f64,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let sequence =
        find_sequence_mut(project, sequence_id.as_deref()).ok_or_else(|| "找不到该序列".to_string())?;

    let marker = sequence
        .markers
        .iter_mut()
        .find(|m| m.id == marker_id)
        .ok_or_else(|| "找不到该标记".to_string())?;
    marker.time_ms = time_ms.max(0.0);
    sequence
        .markers
        .sort_by(|a, b| a.time_ms.partial_cmp(&b.time_ms).unwrap_or(std::cmp::Ordering::Equal));

    record(&state, "移动标记", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 新建素材箱文件夹。
#[tauri::command]
pub fn create_bin(name: String, state: State<'_, AppState>) -> Result<Bin, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;

    let trimmed = name.trim();
    let bin = Bin {
        id: new_id("bin"),
        name: if trimmed.is_empty() { "新建素材箱".to_string() } else { trimmed.to_string() },
    };
    project.bins.push(bin.clone());

    record(&state, "新建素材箱", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(bin)
}

/// 重命名素材箱文件夹。
#[tauri::command]
pub fn rename_bin(bin_id: String, name: String, state: State<'_, AppState>) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;

    let bin = project
        .bins
        .iter_mut()
        .find(|b| b.id == bin_id)
        .ok_or_else(|| "找不到该素材箱".to_string())?;
    let trimmed = name.trim();
    if !trimmed.is_empty() {
        bin.name = trimmed.to_string();
    }

    record(&state, "重命名素材箱", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 删除素材箱文件夹；箱内素材回到「全部」，素材本身不删。
#[tauri::command]
pub fn remove_bin(bin_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;

    let before = project.bins.len();
    project.bins.retain(|b| b.id != bin_id);
    if project.bins.len() == before {
        return Err("找不到该素材箱".to_string());
    }
    for asset in project.assets.iter_mut() {
        if asset.bin_id.as_deref() == Some(bin_id.as_str()) {
            asset.bin_id = None;
        }
    }

    record(&state, "删除素材箱", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 把素材归入文件夹；`bin_id` 传 None 表示移出（回到「全部」）。
#[tauri::command]
pub fn set_asset_bin(
    asset_id: String,
    bin_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;

    if let Some(id) = bin_id.as_deref() {
        if !project.bins.iter().any(|b| b.id == id) {
            return Err("找不到该素材箱".to_string());
        }
    }

    let asset = project
        .assets
        .iter_mut()
        .find(|a| a.id == asset_id)
        .ok_or_else(|| "找不到该素材".to_string())?;
    asset.bin_id = bin_id;

    record(&state, "移动素材到素材箱", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}


/// 设置片段音频 DSP：高通/低通截止（Hz，null 关）、回声延迟（ms，null 关）。
#[tauri::command]
pub fn set_audio_dsp(
    clip_id: String,
    highpass_hz: Option<f64>,
    lowpass_hz: Option<f64>,
    delay_ms: Option<f64>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let clip = find_clip_mut(project, &clip_id).ok_or_else(|| "找不到该片段".to_string())?;
    clip.audio_highpass_hz = highpass_hz.filter(|v| *v > 20.0);
    clip.audio_lowpass_hz = lowpass_hz.filter(|v| *v > 20.0);
    clip.audio_delay_ms = delay_ms.filter(|v| *v > 1.0);
    record(&state, "设置音频处理", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::serialize::new_project;

    /// 空工程也要有可用的默认时长：标尺有刻度、播放头拖得动。
    #[test]
    fn new_project_has_default_duration() {
        let p = new_project("空工程");
        assert!(
            (p.sequences[0].duration_ms - DEFAULT_SEQUENCE_MS).abs() < 1e-9,
            "空序列时长应当是默认 60s，实际 {}",
            p.sequences[0].duration_ms
        );
    }

    /// 片段变更后时长 = 最靠后的片段出点；删空了回落到默认时长。
    #[test]
    fn recompute_duration_follows_last_clip() {
        let mut p = new_project("时长");
        let seq = &mut p.sequences[0];
        recompute_sequence_duration(seq);
        assert!(
            (seq.duration_ms - DEFAULT_SEQUENCE_MS).abs() < 1e-9,
            "没有片段时应保留默认时长"
        );

        let track = seq.tracks.iter_mut().next().unwrap();
        track.clips.push(Clip {
            id: "c1".into(),
            asset_id: String::new(),
            track_id: track.id.clone(),
            start_ms: 10_000.0,
            duration_ms: 5_000.0,
            in_ms: 0.0,
            out_ms: 5_000.0,
            speed: 1.0,
            reversed: false,
            speed_curve: None,
            audio_pitch_shift: false,
            node_id: String::new(),
            compound_id: None,
            enable_3d: false,
            transform_3d: None,
            text: None,
            enabled: true,
            label: None,
            transition_in: None,
            transition_out: None,
            audio_highpass_hz: None,
            audio_lowpass_hz: None,
            audio_delay_ms: None,
            audio_fade_in_ms: None,
            audio_fade_out_ms: None,
        });
        recompute_sequence_duration(seq);
        assert!((seq.duration_ms - 15_000.0).abs() < 1e-9, "时长应跟到最靠后出点 15s");

        // 删空回默认
        seq.tracks[0].clips.clear();
        recompute_sequence_duration(seq);
        assert!(
            (seq.duration_ms - DEFAULT_SEQUENCE_MS).abs() < 1e-9,
            "删空后应回落默认时长"
        );
    }

    /// 新轨 index = 同类型现存最小值减一：时间线行按 index 降序，
    /// 新轨沉到同类型最底下，编号顺着 V1 → V2 → V3 递增（不再出现 V0 / V-1）。
    ///
    /// 这是用户「顶上莫名冒出一条 V 轨」的直接回归测试：
    /// index 必须单调递增且大于所有现存同类型轨道，界面升序排下来才在底部。
    #[test]
    fn add_track_index_keeps_new_track_at_bottom() {
        let p = new_project("加轨");
        let seq = &p.sequences[0];
        // 新工程自带一条 V(index 0) 一条 A(index 0)，下一条应从 1 起
        assert_eq!(next_track_index(&seq.tracks, TrackKind::Video), 1);
        assert_eq!(next_track_index(&seq.tracks, TrackKind::Audio), 1);

        // 连加三条 V 轨：index 必须 1、2、3 顺下去
        let mut tracks = seq.tracks.clone();
        for want in [1, 2, 3] {
            let got = next_track_index(&tracks, TrackKind::Video);
            assert_eq!(got, want, "第 {want} 条新 V 轨 index 应为 {want}");
            tracks.push(Track {
                id: format!("track-{want}"),
                kind: TrackKind::Video,
                index: got,
                muted: false,
                solo: false,
                locked: false,
                hidden: false,
                height: default_height(TrackKind::Video),
                clips: Vec::new(),
            });
        }
        // 全部同类型 index 都必须 < 最新算出来的，也就是新轨永远在最底下
        let fresh = next_track_index(&tracks, TrackKind::Video);
        let max_video = tracks
            .iter()
            .filter(|t| t.kind == TrackKind::Video)
            .map(|t| t.index)
            .max()
            .unwrap();
        assert!(fresh > max_video, "新轨 index 必须比现存最大的还大");

        // 一条轨道都没有时从 0 起（首条就是 V1，不是 V0）
        assert_eq!(next_track_index(&[], TrackKind::Video), 0);
        // 音频轨独立计数，不受视频轨影响
        assert_eq!(next_track_index(&tracks, TrackKind::Audio), 1);
    }
}
