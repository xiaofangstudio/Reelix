//! 渲染命令：请求帧 / 预览开关 / 预览质量 / 标脏 / 缓存统计。
//!
//! 契约与 `src/services/render.ts` 一一对应。一帧的产出口径全部落在 Rust 侧：
//!
//! 1. 按 `sequence_id` 找到序列，按播放时刻在视频轨上定位当前片段；
//! 2. [`crate::compositor::decode`] 起 ffmpeg 独立进程解出该时刻的原始 RGBA；
//! 3. 沿序列的根图按拓扑序过一遍效果栈（[`crate::graph::apply`]）；
//! 4. [`crate::compositor::png`] 编成 PNG，先查两级帧缓存，命中就直接回。
//!
//! 返回值是 PNG 原始字节（[`tauri::ipc::Response`]），前端拿到的是 `ArrayBuffer`，
//! 直接 `URL.createObjectURL` 就能显示——不落临时文件，也不开 assetProtocol。
//! 前端永远只拿到算好的图，不做解码、不做逐帧合成。

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, State};

use crate::compositor::{cache, decode, png};
use crate::graph::engine::topo_order;
use crate::graph::{apply, Connection, Frame, Graph, ParamValue};
use crate::keyframe::store::KeyframeStore;
use crate::project::model::{Project, Sequence};
use crate::state::{lock, AppState};
use crate::timeline::model::{Clip, TrackKind};

/// 没有给显示尺寸时，预览画幅默认不超过这个长边。
///
/// 直接按工程画幅出图会让每帧 PNG 涨到好几兆，拖动播放头立刻卡住；
/// 预览允许画质让位，导出走另一条逐帧精确的管线。
const PREVIEW_MAX_SIDE: f64 = 1280.0;

/// 缓存统计，与前端 `CacheStats` 对齐。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub memory_bytes: u64,
    pub disk_bytes: u64,
    pub entries: usize,
}

/// 预览帧就绪事件的载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFrame {
    pub time_ms: f64,
    pub path: String,
}

/// 图脏标记事件的载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyPayload {
    pub node_ids: Vec<String>,
}

/// 一帧要按什么算：画幅、吸附后的时刻、效果链、要解码的素材。
pub(crate) struct FramePlan {
    pub width: usize,
    pub height: usize,
    /// 按序列帧率吸附过的时刻，缓存键与解帧位置都用它。
    pub snapped_ms: f64,
    pub graph: Graph,
    /// 效果链的拓扑序节点 id（上游在前）。
    pub order: Vec<String>,
    /// 要解码的素材路径与该素材内的时刻；这一刻没有可播画面时为 `None`。
    pub source: Option<(String, f64)>,
    /// 片段来源指纹：素材路径 + 入出点 + 速度 + 倒放。
    /// 只拿路径做缓存键的话，修剪或变速后同一时刻会命中旧画面。
    pub source_key: Option<String>,
    /// 片段入场转场：当前时刻落在转场窗口内时才有值。
    pub transition: Option<TransitionPlan>,
    /// 片段尾部淡出（剪映「淡出」）：末尾窗口内向黑/白渐隐，不需要前片段。
    pub fade_out: Option<TransitionPlan>,
    /// 3D 图层变换（片段启用 3D 时带上；渲染时真作用于画面）。
    pub transform_3d: Option<crate::graph::effects::Transform3D>,
    /// 景深参数（摄像机片段提供；缺省不做模糊）。
    pub depth_of_field: Option<DepthOfField>,
    /// 摄像机取景：序列图里挂了 camera 节点时带上（已经把关键帧烘好）。
    /// 有它，3D 图层走真透视投影，「摄像机环绕拍摄」才有近大远小。
    pub camera: Option<crate::graph::effects::CameraPlan>,
}

/// 景深：合焦平面 Z + 最大模糊强度（像素）。
#[derive(Debug, Clone, Copy)]
pub(crate) struct DepthOfField {
    pub focus_z: f32,
    pub strength: f32,
}

/// 一帧的入场转场计划：前片段画面来源与混合进度。
pub(crate) struct TransitionPlan {
    /// 转场类型：`crossDissolve` / `dipToBlack` / `dipToWhite`，未知类型按叠化处理。
    pub kind: String,
    /// 片段头部内的进度，0.0 是片段起点，1.0 是转场结束。
    pub progress: f32,
    /// 前一个相邻片段的画面来源；`None` 表示没有前片段，按黑/白渐入。
    pub previous: Option<(String, f64)>,
}

/// 请求一帧，返回编码好的 PNG 字节。
///
/// 标了 `async` 是为了让它在 Tauri 的异步运行时线程池里执行：解帧要起 ffmpeg
/// 子进程（几百毫秒级），若留在主线程会把整个界面卡住。函数体本身仍是同步的——
/// 逻辑上就是「算一帧、回一帧」，没必要改写成 `async fn`。
#[tauri::command(async)]
pub fn request_frame(
    sequence_id: String,
    time_ms: f64,
    max_width: Option<f64>,
    max_height: Option<f64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    let cache_dir = PathBuf::from(lock(&state.settings)?.cache_dir.clone());
    let scale = lock(&state.preview)?.scale;

    // 先从权威工程快照里把这一帧需要的东西全取出来，随即释放工程锁——
    // 解帧与合成是慢活，别把工程锁占着不让别的命令动。
    let plan = {
        let guard = lock(&state.project)?;
        let project = guard.as_ref().ok_or_else(|| "还没有打开项目".to_string())?;
        // 关键帧与工程一起取，烘参数这一步必须在释放锁之前做完。
        let keyframes = lock(&state.keyframes)?;
        let size = preview_size(
            project
                .sequences
                .iter()
                .find(|s| s.id == sequence_id)
                .map(|s| (s.width, s.height))
                .unwrap_or((1920, 1080)),
            scale,
            max_width,
            max_height,
        );
        plan_frame(project, &sequence_id, time_ms, size, &keyframes)?
    };

    // 缓存键带上效果链指纹：任何参数一改，指纹就变，旧画面自然不会被误命中。
    // 转场类型 / 时长 / 前片段来源也进指纹，换转场后不会回放旧画面。
    let transition_key = plan.transition.as_ref().map(|t| {
        format!("{}|{:.6}|{:?}", t.kind, t.progress, t.previous)
    });
    let fingerprint = chain_fingerprint(
        &plan.graph,
        &plan.order,
        plan.source_key.as_deref(),
        transition_key.as_deref(),
    );
    let bucket = format!("{sequence_id}-{fingerprint:016x}");
    let path = cache::frame_file(&cache_dir, &bucket, plan.width, plan.height, plan.snapped_ms);
    let key = path.to_string_lossy().into_owned();

    // 第一级：内存里已经编好的 PNG。
    if let Some(bytes) = lock(&state.frames)?.get(&key) {
        let bytes = bytes.to_vec();
        emit_frame(&app, plan.snapped_ms, &key);
        return Ok(Response::new(bytes));
    }

    // 第二级：磁盘上还留着同一个时间点的图。
    if let Ok(bytes) = std::fs::read(&path) {
        lock(&state.frames)?.put(key.clone(), bytes.clone());
        emit_frame(&app, plan.snapped_ms, &key);
        return Ok(Response::new(bytes));
    }

    // 两级都没命中：真解一帧，再过一遍效果栈；转场窗口内再混合前片段。
    let frame = render_plan(&plan)?;

    let png_bytes = png::encode_rgba8(plan.width, plan.height, &frame_to_rgba8(&frame));

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, &png_bytes);
    // 写完顺手整理一次磁盘缓存，别让它无限长。
    cache::tidy_disk(&cache_dir);
    lock(&state.frames)?.put(key.clone(), png_bytes.clone());

    emit_frame(&app, plan.snapped_ms, &key);
    Ok(Response::new(png_bytes))
}

/// 开始预览播放。
#[tauri::command]
pub fn start_preview(sequence_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let mut preview = lock(&state.preview)?;
    preview.running = true;
    preview.sequence_id = Some(sequence_id);
    Ok(true)
}

/// 停止预览播放。
#[tauri::command]
pub fn stop_preview(state: State<'_, AppState>) -> Result<bool, String> {
    let mut preview = lock(&state.preview)?;
    preview.running = false;
    preview.sequence_id = None;
    Ok(true)
}

/// 设置预览缩放，取值夹到 0.25 ~ 1.0。
#[tauri::command]
pub fn set_preview_quality(scale: f64, state: State<'_, AppState>) -> Result<bool, String> {
    let clamped = scale.clamp(0.25, 1.0);
    lock(&state.preview)?.scale = clamped;
    // 运行时缩放与设置里的默认值保持一致，改完不必落盘。
    lock(&state.settings)?.preview_scale = clamped;
    Ok(true)
}

/// 手动把某个节点标脏，并广播 `graph://dirty`。
#[tauri::command]
pub fn invalidate_node(
    node_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    lock(&state.dirty)?.mark(&node_id);
    let _ = app.emit(
        "graph://dirty",
        DirtyPayload {
            node_ids: vec![node_id],
        },
    );
    Ok(true)
}

/// 读取缓存占用。数字全部从真实的两级缓存现算，不留估账。
#[tauri::command]
pub fn get_cache_stats(state: State<'_, AppState>) -> Result<CacheStats, String> {
    let cache_dir = PathBuf::from(lock(&state.settings)?.cache_dir.clone());
    let (_, disk_bytes) = cache::dir_stats(&cache::frames_root(&cache_dir));
    let frames = lock(&state.frames)?;
    Ok(CacheStats {
        memory_bytes: frames.memory_bytes(),
        disk_bytes,
        entries: frames.len(),
    })
}

/// 清理缓存。`scope` 取 `"memory"` / `"disk"` / `"all"`。
#[tauri::command]
pub fn clear_cache(scope: String, state: State<'_, AppState>) -> Result<bool, String> {
    let cache_dir = PathBuf::from(lock(&state.settings)?.cache_dir.clone());
    match scope.as_str() {
        "memory" => {
            lock(&state.frames)?.clear();
        }
        "disk" => {
            cache::clear_disk(&cache_dir);
        }
        "all" => {
            lock(&state.frames)?.clear();
            cache::clear_disk(&cache_dir);
        }
        other => return Err(format!("未知的缓存清理范围：{other}")),
    }
    Ok(true)
}

/// 广播「这一帧好了」。
fn emit_frame(app: &AppHandle, time_ms: f64, path: &str) {
    let _ = app.emit(
        "preview://frame",
        PreviewFrame {
            time_ms,
            path: path.to_string(),
        },
    );
}

/// 定出这一帧怎么算。`size` 由调用方定：预览走 [`preview_size`]，导出走预设画幅。
pub(crate) fn plan_frame(
    project: &Project,
    sequence_id: &str,
    time_ms: f64,
    size: (usize, usize),
    keyframes: &KeyframeStore,
) -> Result<FramePlan, String> {
    let sequence = project
        .sequences
        .iter()
        .find(|s| s.id == sequence_id)
        .ok_or_else(|| format!("找不到序列：{sequence_id}"))?;

    let (width, height) = size;

    // 时刻按序列帧率吸附，同一帧内反复请求才不会各算一遍。
    let frame_ms = if sequence.frame_rate > 0.0 {
        1000.0 / sequence.frame_rate
    } else {
        0.0
    };
    let snapped_ms = if frame_ms > 0.0 {
        (time_ms / frame_ms).round() * frame_ms
    } else {
        time_ms
    };

    // 根图缺失时退化成空图：画面照出，只是没有效果可过。
    let mut graph = project
        .graphs
        .get(&sequence.root_graph_id)
        .cloned()
        .unwrap_or_else(|| Graph {
            id: sequence.root_graph_id.clone(),
            nodes: Vec::new(),
            connections: Vec::new(),
            parent_node_id: None,
        });

    // 把曲线烘成这一帧的参数取值。必须在算拓扑序、算指纹之前完成——
    // 参数一动指纹就变，缓存才不会把旧画面当成新结果回给监视器。
    keyframes.bake_graph(&mut graph, snapped_ms);
    let order = topo_order(&graph).map_err(|e| e.to_string())?;

    let hit = locate_clip(sequence, time_ms);
    let source = hit.and_then(|clip| clip_source(project, clip, time_ms));
    let source_key = hit.and_then(|clip| clip_source_key(project, clip));
    let transition = hit.and_then(|clip| plan_transition(sequence, project, clip, snapped_ms));
    let fade_out = hit.and_then(|clip| plan_fade_out(clip, snapped_ms));
    // 3D 变换：命中片段且启用了 3D 才带上；摄像机片段不占画面（它的变换是全局取景，
    // 由后续迭代接），这里只对图层片段生效。
    let transform_3d = hit
        .filter(|clip| clip.enable_3d && clip.transform_3d.is_some())
        .and_then(|clip| clip.transform_3d.as_ref())
        .map(|t| crate::graph::effects::Transform3D {
            position: [t.position.x as f32, t.position.y as f32, t.position.z as f32],
            rotation: [t.rotation.x as f32, t.rotation.y as f32, t.rotation.z as f32],
            scale: t.scale as f32,
            anchor: [t.anchor.x as f32, t.anchor.y as f32],
        });

    // 摄像机取景：图里挂了 camera 节点就用它的位置 / 看向点 / 焦距。
    // 参数已经过 bake_graph，关键帧驱动的环绕运动在这一刻就是具体数值。
    // 之前摄像机节点纯属摆设——建得出来、拖得动，渲染一眼不看它。
    let camera = graph
        .nodes
        .iter()
        .find(|n| n.node_type == "camera" && !n.bypassed)
        .map(|n| {
            let num = |k: &str, fallback: f64| {
                n.params.get(k).and_then(|v| v.as_f64()).unwrap_or(fallback)
            };
            crate::graph::effects::CameraPlan {
                position: [
                    num("posX", 0.0) as f32,
                    num("posY", 0.0) as f32,
                    num("posZ", -1000.0) as f32,
                ],
                target: [
                    num("targetX", 0.0) as f32,
                    num("targetY", 0.0) as f32,
                    num("targetZ", 0.0) as f32,
                ],
                focal_length: num("focalLength", 50.0) as f32,
            }
        });

    Ok(FramePlan {
        width,
        height,
        snapped_ms,
        graph,
        order,
        source,
        source_key,
        transition,
        fade_out,
        transform_3d,
        depth_of_field: None,
        camera,
    })
}

/// 尾部淡出计划：片段末尾 `duration` 毫秒内向黑/白渐隐。
/// progress 从 0（淡出开始）到 1（全黑/全白），落在窗口外返回 None。
fn plan_fade_out(clip: &Clip, snapped_ms: f64) -> Option<TransitionPlan> {
    let transition = clip.transition_out.as_ref()?;
    let duration = transition.duration_ms.min(clip.duration_ms);
    if duration <= 0.0 {
        return None;
    }
    let local_ms = snapped_ms - clip.start_ms;
    let window_start = clip.duration_ms - duration;
    if local_ms <= window_start {
        return None;
    }
    let progress = ((local_ms - window_start) / duration).clamp(0.0, 1.0) as f32;
    Some(TransitionPlan {
        kind: transition.kind.clone(),
        progress,
        previous: None,
    })
}

/// 片段在某一时刻对应的素材路径与素材内时刻。
///
/// 时刻会夹到片段的入出点之间：转场取前片段画面时，时刻可能已经越过它的
/// 出点（本模型里相邻片段不重叠），这时停在最后一帧，不拿越界时间喂 ffmpeg。
/// 曲线变速时走积分映射（source_offset），恒定变速时退化为线性（行为不变）。
fn clip_source(project: &Project, clip: &Clip, time_ms: f64) -> Option<(String, f64)> {
    let asset = project.assets.iter().find(|a| a.id == clip.asset_id)?;
    // 片段内已走过的时长 → 素材内偏移（曲线下是速度积分，恒定速度时是线性乘积）
    let walked = clip.source_offset(time_ms - clip.start_ms);
    let low = clip.in_ms.min(clip.out_ms);
    let high = clip.in_ms.max(clip.out_ms);
    // 倒放：从出点往回数；正向：从入点往后数。两侧都夹到素材范围内。
    let local_ms = if clip.reversed {
        (clip.out_ms - walked).clamp(low, high)
    } else {
        (clip.in_ms + walked).clamp(low, high)
    };
    Some((asset.path.clone(), local_ms))
}

/// 片段来源指纹：素材路径 + 入出点 + 速度 + 倒放 + 变速曲线。
///
/// 曲线进指纹：改一个速度关键点，指纹就变，监视器不会拿旧画面糊弄。
fn clip_source_key(project: &Project, clip: &Clip) -> Option<String> {
    let asset = project.assets.iter().find(|a| a.id == clip.asset_id)?;
    let speed = if clip.speed.abs() < f64::EPSILON {
        1.0
    } else {
        clip.speed
    };
    let curve = clip
        .speed_curve
        .as_ref()
        .map(|keys| {
            keys.iter()
                .map(|k| format!("{}@{:.3}", k.speed, k.t_ms))
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    Some(format!(
        "{}|{:.3}|{:.3}|{:.6}|{}|{}|{}",
        asset.path,
        clip.in_ms,
        clip.out_ms,
        speed,
        clip.reversed,
        clip.audio_pitch_shift,
        curve
    ))
}

/// 片段头部的入场转场计划；当前时刻不在窗口内或没有转场时返回 `None`。
fn plan_transition(
    sequence: &Sequence,
    project: &Project,
    clip: &Clip,
    snapped_ms: f64,
) -> Option<TransitionPlan> {
    let transition = clip.transition_in.as_ref()?;
    // 转场不能比片段本身长，超出时按片段时长截断。
    let duration = transition.duration_ms.min(clip.duration_ms);
    if duration <= 0.0 {
        return None;
    }
    let local_ms = snapped_ms - clip.start_ms;
    if local_ms >= duration {
        return None;
    }
    let progress = (local_ms / duration).clamp(0.0, 1.0) as f32;

    // 前一个相邻片段：同一轨道上在本片段起点之前结束（不重叠），
    // 取 end_ms 最接近本片段起点的那一个。
    let previous = previous_clip(sequence, clip).and_then(|prev| {
        // 相邻片段不覆盖当前时刻，停在它的最后一帧（留 1ms 避开素材 EOF）。
        let prev_time = snapped_ms.min(prev.end_ms() - 1.0);
        clip_source(project, prev, prev_time)
    });

    Some(TransitionPlan {
        kind: transition.kind.clone(),
        progress,
        previous,
    })
}

/// 同一轨道上排在本片段之前、且不重叠的最后一个片段。
fn previous_clip<'a>(sequence: &'a Sequence, current: &Clip) -> Option<&'a Clip> {
    let track = sequence.tracks.iter().find(|t| t.id == current.track_id)?;
    track
        .clips
        .iter()
        .filter(|c| c.enabled && c.id != current.id && c.end_ms() <= current.start_ms)
        .max_by(|a, b| {
            a.end_ms()
                .partial_cmp(&b.end_ms())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

/// 按计划出一帧：解码 → 过效果栈 → 转场窗口内再混合前片段。
///
/// 预览与导出共用这一条路径，保证两边画面完全一致；前片段也走同一套
/// 解码与效果链求值，不在转场里另写一份。
pub(crate) fn render_plan(plan: &FramePlan) -> Result<Frame, String> {
    let mut frame = match &plan.source {
        Some((asset, local_ms)) => {
            decode::decode_frame(Path::new(asset), *local_ms, plan.width, plan.height)?
        }
        // 这一刻没有画面：出一张透明帧，效果链照样跑，监视器不会白屏。
        None => Frame::new(plan.width, plan.height),
    };
    if !plan.order.is_empty() {
        frame = composite(&plan.graph, &plan.order, frame);
    }

    // 3D 图层变换真渲染：启用 3D 的片段，其 XYZ 位置/缩放/Z 旋转/锚点
    // 在这一步作用到画面上（移出画布的部分变透明）。以前这里直接跳过，
    // 导致 3D 开关、XYZ、旋转全是“存了数据不生效”的假功能。
    if let Some(tf) = &plan.transform_3d {
        // 挂了摄像机就走真透视（贴图会随机位近大远小，绕着拍看得出来）；
        // 没挂摄像机时保持原来的仿射行为，不动既有片子的观感。
        frame = match &plan.camera {
            Some(cam) => crate::graph::effects::project_layer_camera(&frame, tf, cam),
            None => crate::graph::effects::transform3d(&frame, tf),
        };
        // 景深：Z 偏离合焦面时按强度模糊（焦点默认 z=0）
        if let Some(dof) = &plan.depth_of_field {
            frame = crate::graph::effects::depth_of_field(
                &frame,
                tf.position[2],
                dof.focus_z,
                dof.strength,
            );
        }
    }

    let mut frame = frame;

    if let Some(transition) = &plan.transition {
        // 前片段解不出来时不拖垮整帧，退化成从黑/白渐入。
        let previous = transition.previous.as_ref().and_then(|(asset, local_ms)| {
            let mut prev =
                decode::decode_frame(Path::new(asset), *local_ms, plan.width, plan.height).ok()?;
            if !plan.order.is_empty() {
                prev = composite(&plan.graph, &plan.order, prev);
            }
            Some(prev)
        });

        frame = apply_transition(
            &transition.kind,
            transition.progress,
            previous.as_ref(),
            &frame,
        );
    }

    // 尾部淡出（剪映「淡出」）放在最后：出场渐隐盖住转场结果。
    // progress 0 = 原画面，1 = 全黑/全白——与入场的方向正好相反。
    if let Some(fade) = &plan.fade_out {
        frame = apply_fade_out(&fade.kind, fade.progress, &frame);
    }

    Ok(frame)
}

/// 尾部淡出：向黑/白渐隐。`progress` 0 = 原画面，1 = 全黑/全白。
fn apply_fade_out(kind: &str, progress: f32, frame: &Frame) -> Frame {
    let p = progress.clamp(0.0, 1.0);
    let color = if kind == "dipToWhite" {
        [1.0, 1.0, 1.0, 1.0]
    } else {
        [0.0, 0.0, 0.0, 1.0]
    };
    let target = Frame::filled(frame.width, frame.height, color);
    mix_frames(frame, &target, p)
}

/// 按转场类型把前后两帧混合成一帧。
///
/// `progress` 是片段头部内的进度 0.0 ~ 1.0；`previous` 为 `None` 表示没有
/// 前片段，`crossDissolve` / `dipToBlack` 退化为从黑场渐入，`dipToWhite`
/// 退化为从白场渐入。未知类型一律按叠化处理。
pub(crate) fn apply_transition(
    kind: &str,
    progress: f32,
    previous: Option<&Frame>,
    current: &Frame,
) -> Frame {
    let p = progress.clamp(0.0, 1.0);
    let black = || Frame::filled(current.width, current.height, [0.0, 0.0, 0.0, 1.0]);

    match kind {
        "dipToBlack" | "dipToWhite" => {
            let color = if kind == "dipToWhite" {
                Frame::filled(current.width, current.height, [1.0, 1.0, 1.0, 1.0])
            } else {
                black()
            };
            match previous {
                // 前半段前片段渐暗 / 渐白，后半段本片段从目标色渐入。
                // 中点归前半段：p = 0.5 时正好落到纯黑 / 纯白。
                Some(prev) if p <= 0.5 => mix_frames(prev, &color, p * 2.0),
                Some(_) => mix_frames(&color, current, (p - 0.5) * 2.0),
                // 没有前片段：直接从黑 / 白渐入。
                None => mix_frames(&color, current, p),
            }
        }
        // ---- PR 转场家族补全（滑动 / 擦除 / 缩放），全部纯像素操作 ----
        // 推：前帧整体向左滑出，本帧从右侧推入。
        "slidePush" => {
            let Some(prev) = previous else {
                return mix_frames(&black(), current, p);
            };
            slide_frames(prev, current, (p * current.width as f32) as usize, false)
        }
        // 拉：本帧从左侧拉入盖住前帧（前帧不动）。
        "slidePull" => {
            let Some(prev) = previous else {
                return mix_frames(&black(), current, p);
            };
            slide_frames(prev, current, (p * current.width as f32) as usize, true)
        }
        // 线性擦除：分界线从左到右扫过，左边显示本帧。
        "wipeLinear" => {
            let Some(prev) = previous else {
                return mix_frames(&black(), current, p);
            };
            wipe_linear(prev, current, p)
        }
        // 径向擦除：以画面中心为轴的扇形扫过。
        "wipeRadial" => {
            let Some(prev) = previous else {
                return mix_frames(&black(), current, p);
            };
            wipe_radial(prev, current, p)
        }
        // 百叶窗：竖向条带依次显现。
        "wipeBlinds" => {
            let Some(prev) = previous else {
                return mix_frames(&black(), current, p);
            };
            wipe_blinds(prev, current, p, 8)
        }
        // 交叉缩放：前帧放大淡出，本帧从小放大进入。
        "zoomCross" => {
            let Some(prev) = previous else {
                return mix_frames(&black(), current, p);
            };
            zoom_cross(prev, current, p)
        }
        // crossDissolve 与无法识别的类型一律按叠化。
        _ => match previous {
            Some(prev) => mix_frames(prev, current, p),
            None => mix_frames(&black(), current, p),
        },
    }
}

/// 推 / 拉共用的滑动混合：seam 是分界像素列。
/// push=false：分界左边是本帧（推入），右边是前帧；
/// push=true（拉）：分界左边是本帧从左拉入，右边仍是前帧。
fn slide_frames(prev: &Frame, current: &Frame, seam: usize, pull: bool) -> Frame {
    if prev.width != current.width || prev.height != current.height {
        return current.clone();
    }
    let seam = seam.min(current.width);
    let mut out = current.clone();
    for y in 0..current.height {
        for x in 0..current.width {
            let use_current = if pull { x < seam } else { x >= seam };
            if !use_current {
                let i = (y * current.width + x) * 4;
                let j = (y * prev.width + x) * 4;
                for k in 0..4 {
                    out.pixels[i + k] = prev.pixels[j + k];
                }
            }
        }
    }
    out
}

/// 线性擦除：x < 分界 → 本帧，否则前帧（带 2px 软边）。
fn wipe_linear(prev: &Frame, current: &Frame, p: f32) -> Frame {
    if prev.width != current.width || prev.height != current.height {
        return current.clone();
    }
    let edge = p * current.width as f32;
    let mut out = current.clone();
    for y in 0..current.height {
        for x in 0..current.width {
            let i = (y * current.width + x) * 4;
            let d = x as f32 - edge;
            // 软边 2px 内做线性过渡
            let w = (d / 2.0).clamp(0.0, 1.0);
            if w < 1.0 {
                let j = (y * prev.width + x) * 4;
                for k in 0..4 {
                    let c = prev.pixels[j + k];
                    out.pixels[i + k] = c + (out.pixels[i + k] - c) * w;
                }
            }
        }
    }
    out
}

/// 径向擦除：扇形角度内是本帧。以中心为轴、从正上方顺时针扫。
fn wipe_radial(prev: &Frame, current: &Frame, p: f32) -> Frame {
    if prev.width != current.width || prev.height != current.height {
        return current.clone();
    }
    let cx = current.width as f32 / 2.0;
    let cy = current.height as f32 / 2.0;
    let max_angle = p * std::f32::consts::TAU;
    let mut out = current.clone();
    for y in 0..current.height {
        for x in 0..current.width {
            let i = (y * current.width + x) * 4;
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            // atan2 以正右方为 0，转到以正上方为 0 的顺时针角
            let mut a = dy.atan2(dx) + std::f32::consts::FRAC_PI_2;
            if a < 0.0 {
                a += std::f32::consts::TAU;
            }
            if a > max_angle {
                let j = (y * prev.width + x) * 4;
                for k in 0..4 {
                    out.pixels[i + k] = prev.pixels[j + k];
                }
            }
        }
    }
    out
}

/// 百叶窗：把画面竖切 bands 条，每条按自己的局部进度从上往下显现。
fn wipe_blinds(prev: &Frame, current: &Frame, p: f32, bands: usize) -> Frame {
    if prev.width != current.width || prev.height != current.height {
        return current.clone();
    }
    let band_w = (current.width as f32 / bands as f32).ceil() as usize;
    let mut out = current.clone();
    for y in 0..current.height {
        for x in 0..current.width {
            let band = (x / band_w.max(1)).min(bands - 1);
            // 每条带错开一点点相位，产生依次扫过的观感
            let local = ((p * bands as f32) - band as f32).clamp(0.0, 1.0);
            if (x % band_w.max(1)) as f32 > local * band_w.max(1) as f32 {
                let i = (y * current.width + x) * 4;
                let j = (y * prev.width + x) * 4;
                for k in 0..4 {
                    out.pixels[i + k] = prev.pixels[j + k];
                }
            }
        }
    }
    out
}

/// 交叉缩放：前帧从 1.0 放大到 1.0 + p*0.6 并淡出；本帧从 0.7 + p*0.3 放大到 1.0 淡入。
fn zoom_cross(prev: &Frame, current: &Frame, p: f32) -> Frame {
    let scaled_prev = zoom_frame(prev, 1.0 + p * 0.6);
    let scaled_cur = zoom_frame(current, 0.7 + p * 0.3);
    mix_frames(&scaled_prev, &scaled_cur, p)
}

/// 把帧以中心为轴缩放（超出部分裁掉，缩小部分补透明边——这里补黑边更自然）。
fn zoom_frame(src: &Frame, scale: f32) -> Frame {
    let mut out = Frame::filled(src.width, src.height, [0.0, 0.0, 0.0, 1.0]);
    let cx = src.width as f32 / 2.0;
    let cy = src.height as f32 / 2.0;
    let inv = 1.0 / scale.max(0.01);
    for y in 0..out.height {
        for x in 0..out.width {
            let sx = ((x as f32 - cx) * inv + cx) as usize;
            let sy = ((y as f32 - cy) * inv + cy) as usize;
            if sx < src.width && sy < src.height {
                let i = (y * out.width + x) * 4;
                let j = (sy * src.width + sx) * 4;
                for k in 0..4 {
                    out.pixels[i + k] = src.pixels[j + k];
                }
            }
        }
    }
    out
}

/// 线性混合两帧：`weight = 0` 取 `from`，`weight = 1` 取 `to`。
fn mix_frames(from: &Frame, to: &Frame, weight: f32) -> Frame {
    let w = weight.clamp(0.0, 1.0);
    if from.width != to.width
        || from.height != to.height
        || from.pixels.len() != to.pixels.len()
    {
        // 画幅不一致时不做混合，直接给目标帧（正常解码路径都按同一画幅出图）。
        return to.clone();
    }
    let mut out = to.clone();
    for (px, (a, b)) in out
        .pixels
        .iter_mut()
        .zip(from.pixels.iter().zip(to.pixels.iter()))
    {
        *px = a + (b - a) * w;
    }
    out
}

/// 按预览缩放与显示尺寸定输出画幅。
///
/// 缩放先夹到 0.25 ~ 1.0；前端给了监视器的显示尺寸就再收一档，
/// 没给则守住长边上限，避免默认按 1920×1080 出图。
pub(crate) fn preview_size(
    seq_size: (u32, u32),
    scale: f64,
    max_width: Option<f64>,
    max_height: Option<f64>,
) -> (usize, usize) {
    let w = (seq_size.0 as f64).max(1.0);
    let h = (seq_size.1 as f64).max(1.0);
    let mut factor = scale.clamp(0.25, 1.0);

    let cap_w = max_width.filter(|v| *v >= 1.0);
    let cap_h = max_height.filter(|v| *v >= 1.0);
    match (cap_w, cap_h) {
        (Some(mw), Some(mh)) => factor = factor.min(mw / w).min(mh / h),
        (Some(mw), None) => factor = factor.min(mw / w),
        (None, Some(mh)) => factor = factor.min(mh / h),
        (None, None) => {
            let longest = w.max(h);
            if longest > PREVIEW_MAX_SIDE {
                factor = factor.min(PREVIEW_MAX_SIDE / longest);
            }
        }
    }

    let out_w = ((w * factor).round() as usize).max(1);
    let out_h = ((h * factor).round() as usize).max(1);
    (out_w, out_h)
}

/// 找这一刻该显示哪个片段：取覆盖当前时刻、层级最高的可见视频轨片段。
fn locate_clip(sequence: &Sequence, time_ms: f64) -> Option<&Clip> {
    // 有轨道独奏时只看独奏轨，和常见剪辑器的口径一致。
    let solo = sequence
        .tracks
        .iter()
        .any(|t| t.kind == TrackKind::Video && t.solo);

    let mut best: Option<&Clip> = None;
    let mut best_index = i32::MIN;
    for track in &sequence.tracks {
        if track.kind != TrackKind::Video || track.hidden || track.muted {
            continue;
        }
        if (solo && !track.solo) || track.index < best_index {
            continue;
        }
        if let Some(clip) = track.clips.iter().find(|c| c.covers(time_ms) && c.enabled) {
            best = Some(clip);
            best_index = track.index;
        }
    }
    best
}

/// 沿效果栈把一帧算出来。
///
/// 按拓扑序逐节点应用：主输入取「连到它的那条主连接」的结果，没有连接就退回
/// 片段解出来的原帧——孤立挂着的效果节点也照样作用在当前画面上，不会把画面算没。
/// `blend` / `merge` 这类双输入节点用第二路连接的结果当 `source`。
pub(crate) fn composite(graph: &Graph, order: &[String], seed: Frame) -> Frame {
    let mut values: HashMap<String, Frame> = HashMap::new();
    let mut last = seed.clone();

    for id in order {
        let Some(node) = graph.node(id) else { continue };

        let refs: Vec<&Connection> = graph
            .connections
            .iter()
            .filter(|c| c.to_node == node.id)
            .collect();
        let primary_idx = refs
            .iter()
            .position(|c| is_primary_plug(&c.to_plug))
            .unwrap_or(0);

        let primary = refs
            .get(primary_idx)
            .and_then(|c| values.get(&c.from_node))
            .cloned()
            .unwrap_or_else(|| seed.clone());
        let secondary = refs
            .iter()
            .enumerate()
            .find(|(i, _)| *i != primary_idx)
            .and_then(|(_, c)| values.get(&c.from_node));

        let out = if node.bypassed {
            // 旁路：数据直通，节点留着。
            primary
        } else {
            apply(&node.node_type, &node.params, &primary, secondary).unwrap_or(primary)
        };

        last = out.clone();
        values.insert(node.id.clone(), out);
    }

    // 有输出节点就以它为准，否则用最后一个算出来的。
    if let Some(node) = graph.nodes.iter().find(|n| n.node_type == "output") {
        if let Some(frame) = values.get(&node.id) {
            return frame.clone();
        }
    }
    last
}

/// 主输入插槽的常见命名。命中就优先当第一路，避免两路接反。
fn is_primary_plug(plug: &str) -> bool {
    matches!(
        plug,
        "input" | "image" | "in" | "a" | "foreground" | "front" | "base"
    )
}

/// 效果链指纹：节点类型、旁路状态、全部参数一起哈希。
///
/// 缓存键里带上它，参数一改就换一个键，旧画面不会被误当成新结果。
/// 参数按键名排序后再哈希——`HashMap` 的遍历顺序不稳定，不排序指纹就会飘。
fn chain_fingerprint(
    graph: &Graph,
    order: &[String],
    seed: Option<&str>,
    transition: Option<&str>,
) -> u64 {
    let mut hasher = DefaultHasher::new();
    seed.unwrap_or("").hash(&mut hasher);
    // 转场状态也进指纹：类型 / 进度 / 前片段一变就换键，旧画面不会被误命中。
    transition.unwrap_or("").hash(&mut hasher);

    for id in order {
        let Some(node) = graph.node(id) else { continue };
        node.node_type.hash(&mut hasher);
        node.bypassed.hash(&mut hasher);

        let mut keys: Vec<&String> = node.params.keys().collect();
        keys.sort();
        for key in keys {
            key.hash(&mut hasher);
            match &node.params[key] {
                ParamValue::Bool(v) => {
                    0u8.hash(&mut hasher);
                    v.hash(&mut hasher);
                }
                ParamValue::Number(v) => {
                    1u8.hash(&mut hasher);
                    // 走位模式：`NaN` 与 `-0.0` 也要能区分。
                    v.to_bits().hash(&mut hasher);
                }
                ParamValue::Text(v) => {
                    2u8.hash(&mut hasher);
                    v.hash(&mut hasher);
                }
            }
        }
    }

    hasher.finish()
}

/// 合成用的浮点帧转成 8 位 RGBA。取值先夹到 0 ~ 1，再四舍五入。
pub(crate) fn frame_to_rgba8(frame: &Frame) -> Vec<u8> {
    frame
        .pixels
        .iter()
        .map(|v| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::GraphNode;

    fn node(id: &str, node_type: &str) -> GraphNode {
        GraphNode {
            id: id.to_string(),
            node_type: node_type.to_string(),
            name: node_type.to_string(),
            x: 0.0,
            y: 0.0,
            params: HashMap::new(),
            bypassed: false,
            collapsed: false,
            animated: false,
            inputs: Vec::new(),
            outputs: Vec::new(),
        }
    }

    /// 前端给了监视器显示尺寸时，必须按它收画幅，别出满分辨率大图。
    #[test]
    fn preview_size_follows_display_size_hint() {
        let (w, h) = preview_size((1920, 1080), 1.0, Some(960.0), Some(540.0));
        assert_eq!((w, h), (960, 540));
    }

    /// 没给显示尺寸时守住长边上限，不让默认帧涨到好几兆。
    #[test]
    fn preview_size_caps_long_side_without_hint() {
        // 3840×2160 是 16:9，长边收到 1280 后短边按比例是 720。
        let (w, h) = preview_size((3840, 2160), 1.0, None, None);
        assert_eq!(w, PREVIEW_MAX_SIDE as usize);
        assert_eq!(h, 720);
    }

    /// 缩放系数与显示尺寸同时给出时，取更小的那个。
    #[test]
    fn preview_size_takes_the_smaller_scale() {
        let (w, _) = preview_size((1920, 1080), 0.25, Some(1920.0), Some(1080.0));
        assert_eq!(w, 480, "0.25 的缩放更小，应当生效");
    }

    /// 画幅至少 1×1，绝不能出零尺寸。
    #[test]
    fn preview_size_never_returns_zero() {
        let (w, h) = preview_size((1920, 1080), 0.25, Some(0.5), Some(0.5));
        assert!(w >= 1 && h >= 1);
    }

    /// 参数一改指纹就得变，否则缓存会把旧画面当成新的。
    #[test]
    fn fingerprint_changes_with_params() {
        let mut graph = Graph {
            id: "g".into(),
            nodes: vec![node("n1", "grade")],
            connections: Vec::new(),
            parent_node_id: None,
        };
        let order = vec!["n1".to_string()];

        let before = chain_fingerprint(&graph, &order, None, None);
        graph.nodes[0].set_param("contrast", ParamValue::Number(20.0));
        let after = chain_fingerprint(&graph, &order, None, None);

        assert_ne!(before, after);

        // 同样的参数再算一遍必须一样，不然每次请求都会重算。
        assert_eq!(after, chain_fingerprint(&graph, &order, None, None));
    }

    /// 换成别的素材，指纹也要变。
    #[test]
    fn fingerprint_changes_with_source() {
        let graph = Graph {
            id: "g".into(),
            nodes: vec![node("n1", "output")],
            connections: Vec::new(),
            parent_node_id: None,
        };
        let order = vec!["n1".to_string()];
        assert_ne!(
            chain_fingerprint(&graph, &order, Some("C:/a.mp4"), None),
            chain_fingerprint(&graph, &order, Some("C:/b.mp4"), None)
        );
    }

    /// 结构性节点只做直通，不带任何效果时画面必须原样出来。
    #[test]
    fn composite_passes_through_structural_nodes() {
        let graph = Graph {
            id: "g".into(),
            nodes: vec![node("seq", "sequence"), node("out", "output")],
            connections: vec![Connection {
                id: "c1".into(),
                from_node: "seq".into(),
                from_plug: "output".into(),
                to_node: "out".into(),
                to_plug: "input".into(),
            }],
            parent_node_id: None,
        };
        let order = vec!["seq".to_string(), "out".to_string()];
        let seed = Frame::filled(2, 2, [0.25, 0.5, 0.75, 1.0]);

        let out = composite(&graph, &order, seed.clone());
        assert_eq!(out.width, 2);
        assert_eq!(out.height, 2);
        assert_eq!(out.pixels, seed.pixels, "直通不能改动任何像素");
    }

    /// 旁路的节点必须原样直通，不能把效果算上去。
    #[test]
    fn composite_respects_bypass() {
        let mut grade = node("g1", "grade");
        grade.bypassed = true;
        grade.set_param("contrast", ParamValue::Number(100.0));

        let graph = Graph {
            id: "g".into(),
            nodes: vec![node("seq", "sequence"), grade, node("out", "output")],
            connections: vec![
                Connection {
                    id: "c1".into(),
                    from_node: "seq".into(),
                    from_plug: "output".into(),
                    to_node: "g1".into(),
                    to_plug: "input".into(),
                },
                Connection {
                    id: "c2".into(),
                    from_node: "g1".into(),
                    from_plug: "output".into(),
                    to_node: "out".into(),
                    to_plug: "input".into(),
                },
            ],
            parent_node_id: None,
        };
        let order = vec!["seq".to_string(), "g1".to_string(), "out".to_string()];
        let seed = Frame::filled(2, 2, [0.1, 0.2, 0.3, 1.0]);

        let out = composite(&graph, &order, seed.clone());
        assert_eq!(out.pixels, seed.pixels, "旁路节点不该改动像素");
    }

    /// 浮点帧转 8 位：越界要夹住，不能溢出回绕。
    #[test]
    fn frame_to_rgba8_clamps_out_of_range() {
        let mut frame = Frame::new(1, 1);
        frame.pixels = vec![-1.0, 0.0, 1.0, 2.0];
        assert_eq!(frame_to_rgba8(&frame), vec![0u8, 0, 255, 255]);
    }

    /// 修剪入出点或变速后，同一时刻的来源指纹必须变，缓存才不会回旧画面。
    #[test]
    fn source_key_tracks_trim_and_speed() {
        use crate::project::model::Asset;
        use crate::project::serialize::new_project;
        use crate::timeline::model::Clip;

        let mut project = new_project("来源指纹");
        let sequence_id = project.sequences[0].id.clone();
        let track_id = project.sequences[0].tracks[0].id.clone();
        project.assets.push(Asset {
            id: "a1".into(),
            path: "C:/media/a.mp4".into(),
            name: "a.mp4".into(),
            kind: crate::project::model::AssetKind::Video,
            duration_ms: 10_000.0,
            width: 1920,
            height: 1080,
            frame_rate: 25.0,
            codec: "h264".into(),
            has_audio: true,
            missing: false,
            bin_id: None,
        });
        project.sequences[0].tracks[0].clips.push(Clip {
            id: "c1".into(),
            asset_id: "a1".into(),
            track_id,
            start_ms: 0.0,
            duration_ms: 1000.0,
            in_ms: 0.0,
            out_ms: 1000.0,
            speed: 1.0,
            reversed: false,
            speed_curve: None,
            audio_pitch_shift: false,
            node_id: "n1".into(),
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

        let store = KeyframeStore::new();
        let key_at = |project: &Project| {
            plan_frame(project, &sequence_id, 400.0, (640, 360), &store)
                .unwrap()
                .source_key
                .expect("这一刻应当有画面来源")
        };

        let before = key_at(&project);
        project.sequences[0].tracks[0].clips[0].in_ms = 500.0;
        project.sequences[0].tracks[0].clips[0].out_ms = 1500.0;
        let trimmed = key_at(&project);
        assert_ne!(before, trimmed, "改入出点后来源指纹必须变");

        project.sequences[0].tracks[0].clips[0].speed = 2.0;
        let sped = key_at(&project);
        assert_ne!(trimmed, sped, "改速度后来源指纹必须变");
    }

    /// 关键帧必须真的烘进这一帧的参数里，否则「拖关键帧画面跟着变」就是空话。
    /// 时刻取 40ms 的整数倍，避开帧率吸附造成的取整。
    #[test]
    fn plan_frame_bakes_keyframes_into_params() {
        use crate::graph::catalog::create_node;
        use crate::keyframe::model::EasingPreset;
        use crate::project::serialize::new_project;

        let mut project = new_project("关键帧烘入");
        let sequence_id = project.sequences[0].id.clone();
        let root_id = project.sequences[0].root_graph_id.clone();

        let grade = create_node("grade", 0.0, 0.0).expect("调色节点应当在注册表里");
        let node_id = grade.id.clone();
        project
            .graphs
            .get_mut(&root_id)
            .expect("根图应当存在")
            .nodes
            .push(grade);

        let mut store = KeyframeStore::new();
        store.set_keyframe(&node_id, "contrast", 0.0, 0.0, EasingPreset::Linear);
        store.set_keyframe(&node_id, "contrast", 1000.0, 100.0, EasingPreset::Linear);

        let contrast_at = |ms: f64| {
            let plan = plan_frame(&project, &sequence_id, ms, (1920, 1080), &store)
                .expect("应当能规划出一帧");
            match plan.graph.node(&node_id).unwrap().param("contrast") {
                Some(ParamValue::Number(v)) => *v,
                other => panic!("contrast 应当是数值，实际 {other:?}"),
            }
        };
        assert!((contrast_at(400.0) - 40.0).abs() < 1e-4, "0.4s 处应为 40");
        assert!((contrast_at(200.0) - 20.0).abs() < 1e-4, "0.2s 处应为 20");

        // 不同时刻烘出不同取值，指纹才会不同，缓存才不会串帧。
        let plan_a = plan_frame(&project, &sequence_id, 200.0, (1920, 1080), &store).unwrap();
        let order_a = plan_a.order.clone();
        let plan_b = plan_frame(&project, &sequence_id, 400.0, (1920, 1080), &store).unwrap();
        assert_ne!(
            chain_fingerprint(&plan_a.graph, &order_a, None, None),
            chain_fingerprint(&plan_b.graph, &plan_b.order, None, None),
            "关键帧取值不同，指纹必须不同"
        );
    }

    /// 叠化半程：前片段与本片段各取一半。
    #[test]
    fn cross_dissolve_mixes_halfway() {
        let prev = Frame::filled(1, 1, [0.0, 0.0, 0.0, 1.0]);
        let current = Frame::filled(1, 1, [1.0, 1.0, 1.0, 1.0]);

        let out = apply_transition("crossDissolve", 0.5, Some(&prev), &current);
        assert!((out.pixels[0] - 0.5).abs() < 1e-6);
        assert!((out.pixels[1] - 0.5).abs() < 1e-6);
        assert!((out.pixels[2] - 0.5).abs() < 1e-6);
        assert_eq!(out.pixels[3], 1.0);
    }

    /// 黑场过渡：中点必须是纯黑，两侧各走一半。
    #[test]
    fn dip_to_black_goes_through_black() {
        let prev = Frame::filled(1, 1, [1.0, 1.0, 1.0, 1.0]);
        let current = Frame::filled(1, 1, [1.0, 1.0, 1.0, 1.0]);

        let mid = apply_transition("dipToBlack", 0.5, Some(&prev), &current);
        assert!(mid.pixels[..3].iter().all(|v| v.abs() < 1e-6), "中点应当是纯黑");

        let quarter = apply_transition("dipToBlack", 0.25, Some(&prev), &current);
        assert!((quarter.pixels[0] - 0.5).abs() < 1e-6, "1/4 处前片段压到半亮");

        let three_quarter = apply_transition("dipToBlack", 0.75, Some(&prev), &current);
        assert!(
            (three_quarter.pixels[0] - 0.5).abs() < 1e-6,
            "3/4 处本片段从黑升到半亮"
        );
    }

    /// 白场过渡：没有前片段时直接从白场渐入。
    #[test]
    fn dip_to_white_without_previous_fades_from_white() {
        let current = Frame::filled(1, 1, [0.0, 0.0, 0.0, 1.0]);
        let out = apply_transition("dipToWhite", 0.5, None, &current);
        assert!((out.pixels[0] - 0.5).abs() < 1e-6);
        assert!((out.pixels[1] - 0.5).abs() < 1e-6);
        assert!((out.pixels[2] - 0.5).abs() < 1e-6);
    }

    /// 没有前片段的叠化退化为从黑场渐入。
    #[test]
    fn cross_dissolve_without_previous_fades_from_black() {
        let current = Frame::filled(1, 1, [1.0, 1.0, 1.0, 1.0]);
        let out = apply_transition("crossDissolve", 0.25, None, &current);
        assert!((out.pixels[0] - 0.25).abs() < 1e-6);
    }

    /// 无法识别的转场类型按叠化处理。
    #[test]
    fn unknown_transition_falls_back_to_cross_dissolve() {
        let prev = Frame::filled(1, 1, [0.0, 0.0, 0.0, 1.0]);
        let current = Frame::filled(1, 1, [1.0, 1.0, 1.0, 1.0]);

        let unknown = apply_transition("wipe", 0.5, Some(&prev), &current);
        let dissolve = apply_transition("crossDissolve", 0.5, Some(&prev), &current);
        assert_eq!(unknown.pixels, dissolve.pixels);
    }

    /// 造一个带两个相邻视频片段的工程，第二个片段可带入场转场。
    fn project_with_two_clips(transition: Option<crate::timeline::model::Transition>) -> (Project, String) {
        use crate::project::model::Asset;
        use crate::project::serialize::new_project;
        use crate::timeline::model::Clip;

        let mut project = new_project("转场计划");
        let sequence_id = project.sequences[0].id.clone();
        let track_id = project.sequences[0].tracks[0].id.clone();

        for (id, path) in [("a1", "C:/media/a.mp4"), ("a2", "C:/media/b.mp4")] {
            project.assets.push(Asset {
                id: id.into(),
                path: path.into(),
                name: id.into(),
                kind: crate::project::model::AssetKind::Video,
                duration_ms: 10_000.0,
                width: 1920,
                height: 1080,
                frame_rate: 25.0,
                codec: "h264".into(),
                has_audio: true,
                missing: false,
                bin_id: None,
            });
        }

        let clip = |id: &str,
                    asset: &str,
                    start_ms: f64,
                    transition_in: Option<crate::timeline::model::Transition>|
         -> Clip {
            Clip {
                id: id.into(),
                asset_id: asset.into(),
                track_id: track_id.clone(),
                start_ms,
                duration_ms: 1000.0,
                in_ms: 0.0,
                out_ms: 1000.0,
                speed: 1.0,
                reversed: false,
                speed_curve: None,
                audio_pitch_shift: false,
                node_id: "n1".into(),
                compound_id: None,
                enable_3d: false,
                transform_3d: None,
                text: None,
                enabled: true,
                label: None,
                transition_in,
                transition_out: None,
                audio_highpass_hz: None,
                audio_lowpass_hz: None,
                audio_delay_ms: None,
                audio_fade_in_ms: None,
                audio_fade_out_ms: None,
            }
        };

        let first = clip("c1", "a1", 0.0, None);
        let second = clip("c2", "a2", 1000.0, transition);
        project.sequences[0].tracks[0].clips.push(first);
        project.sequences[0].tracks[0].clips.push(second);
        (project, sequence_id)
    }

    /// 转场窗口内要能给出前片段来源与线性进度。
    #[test]
    fn plan_frame_reports_transition_in_window() {
        let (project, sequence_id) = project_with_two_clips(Some(
            crate::timeline::model::Transition {
                kind: "crossDissolve".into(),
                duration_ms: 200.0,
            },
        ));
        let store = KeyframeStore::new();

        // 1050ms 按 25fps 吸附到 1040ms，片段内偏移 40ms，进度 0.2。
        let plan = plan_frame(&project, &sequence_id, 1050.0, (640, 360), &store).unwrap();
        let transition = plan.transition.as_ref().expect("这一刻应当落在转场窗口内");
        assert_eq!(transition.kind, "crossDissolve");
        assert!(
            (transition.progress - 0.2).abs() < 1e-4,
            "吸附后进度应为 0.2，实际 {}",
            transition.progress
        );
        let (path, at) = transition.previous.as_ref().expect("应当找到前片段");
        assert_eq!(path, "C:/media/a.mp4");
        assert!((*at - 999.0).abs() < 1e-6, "前片段应停在最后一帧");

        // 窗口结束后不再有转场计划。
        let after = plan_frame(&project, &sequence_id, 1200.0, (640, 360), &store).unwrap();
        assert!(after.transition.is_none());
    }

    /// 片段没有转场时不能凭空造出转场计划。
    #[test]
    fn plan_frame_without_transition_has_none() {
        let (project, sequence_id) = project_with_two_clips(None);
        let store = KeyframeStore::new();
        let plan = plan_frame(&project, &sequence_id, 1050.0, (640, 360), &store).unwrap();
        assert!(plan.transition.is_none());
    }

    /// 尾部淡出：末尾窗口内出计划、窗口外没有；进度从 0 渐到 1。
    #[test]
    fn plan_frame_reports_fade_out_at_tail() {
        let (mut project, sequence_id) = project_with_two_clips(None);
        // 给第二个片段（1000~2000ms）挂 200ms 黑场淡出
        let track = &mut project.sequences[0].tracks[0];
        track.clips[1].transition_out = Some(crate::timeline::model::Transition {
            kind: "dipToBlack".into(),
            duration_ms: 200.0,
        });
        let store = KeyframeStore::new();

        // 窗口外（1500ms，淡出从 1800ms 开始）没有淡出计划
        let outside = plan_frame(&project, &sequence_id, 1500.0, (640, 360), &store).unwrap();
        assert!(outside.fade_out.is_none(), "窗口外不应有淡出");

        // 1880ms 按 25fps 吸附后不变，落在 [1800, 2000] 窗口内偏早，进度 0.4
        let mid = plan_frame(&project, &sequence_id, 1880.0, (640, 360), &store).unwrap();
        let fade = mid.fade_out.as_ref().expect("尾巴窗口内应有淡出计划");
        assert_eq!(fade.kind, "dipToBlack");
        assert!((fade.progress - 0.4).abs() < 1e-4, "窗口内进度应 0.4，实际 {}", fade.progress);
        assert!(fade.previous.is_none(), "淡出不需要前片段");
    }
}
