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
    let fingerprint = chain_fingerprint(
        &plan.graph,
        &plan.order,
        plan.source_key.as_deref(),
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

    // 两级都没命中：真解一帧，再过一遍效果栈。
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

    let source = locate_clip(sequence, time_ms).and_then(|clip| {
        let asset = project.assets.iter().find(|a| a.id == clip.asset_id)?;
        let speed = if clip.speed.abs() < f64::EPSILON {
            1.0
        } else {
            clip.speed
        };
        let offset = (time_ms - clip.start_ms) * speed;
        // 倒放：从出点往回数。两侧都夹到不小于 0，ffmpeg 才不会拿到负时刻。
        let local_ms = if clip.reversed {
            (clip.out_ms - offset).max(0.0)
        } else {
            (clip.in_ms + offset).max(0.0)
        };
        Some((asset.path.clone(), local_ms))
    });

    let source_key = locate_clip(sequence, time_ms).and_then(|clip| {
        let asset = project.assets.iter().find(|a| a.id == clip.asset_id)?;
        let speed = if clip.speed.abs() < f64::EPSILON {
            1.0
        } else {
            clip.speed
        };
        Some(format!(
            "{}|{:.3}|{:.3}|{:.6}|{}",
            asset.path, clip.in_ms, clip.out_ms, speed, clip.reversed
        ))
    });

    Ok(FramePlan {
        width,
        height,
        snapped_ms,
        graph,
        order,
        source,
        source_key,
    })
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
        if let Some(clip) = track.clips.iter().find(|c| c.covers(time_ms)) {
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
fn chain_fingerprint(graph: &Graph, order: &[String], seed: Option<&str>) -> u64 {
    let mut hasher = DefaultHasher::new();
    seed.unwrap_or("").hash(&mut hasher);

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

        let before = chain_fingerprint(&graph, &order, None);
        graph.nodes[0].set_param("contrast", ParamValue::Number(20.0));
        let after = chain_fingerprint(&graph, &order, None);

        assert_ne!(before, after);

        // 同样的参数再算一遍必须一样，不然每次请求都会重算。
        assert_eq!(after, chain_fingerprint(&graph, &order, None));
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
            chain_fingerprint(&graph, &order, Some("C:/a.mp4")),
            chain_fingerprint(&graph, &order, Some("C:/b.mp4"))
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
            node_id: "n1".into(),
            compound_id: None,
            enable_3d: false,
            transform_3d: None,
            text: None,
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
            chain_fingerprint(&plan_a.graph, &order_a, None),
            chain_fingerprint(&plan_b.graph, &plan_b.order, None),
            "关键帧取值不同，指纹必须不同"
        );
    }
}
