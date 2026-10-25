//! 导出命令：开始 / 取消 / 暂停 / 继续 / 预设列表。
//!
//! 契约与 `src/services/export.ts` 对齐。导出是真编码：后台线程逐帧
//! 复用预览的帧管线（[`crate::commands::render`] 的 plan → decode → composite），
//! RGBA 裸流直灌 ffmpeg 编 H.264/H.265，音频按轨道混成一条 AAC。
//! 红线：导出走 ffmpeg 子进程，不做 WebGL 截屏。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::render;
use crate::commands::subtitle;
use crate::commands::project::require_project;
use crate::compositor::decode;
use crate::keyframe::KeyframeStore;
use crate::media::audio;
use crate::media::audio::MIX_SAMPLE_RATE;
use crate::project::model::{Project, Sequence};
use crate::project::serialize::new_id;
use crate::state::{lock, AppState, ExportJob};
use crate::timeline::TrackKind;

/// 导出范围。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRange {
    pub start_ms: f64,
    pub end_ms: f64,
}

/// 导出预设，字段名与前端 `ExportPreset` 一致。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreset {
    pub id: String,
    /// 中文名，界面直接显示
    pub name: String,
    pub container: String,
    pub video_codec: String,
    pub audio_codec: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    pub bitrate_kbps: u32,
    /// 本机 ffmpeg 是否真的能编这个编码（HEVC 在部分显卡上会失败）
    pub available: bool,
}

/// 开始导出的结果：任务 id。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportStart {
    pub job_id: String,
}

/// 导出进度事件的载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub job_id: String,
    pub frame: u64,
    pub total_frames: u64,
    pub eta_ms: f64,
    pub stage: String,
}

/// 毫秒 → CMX3600 时间码（HH:MM:SS:FF，非丢帧）。
fn edl_tc(ms: f64, fps: f64) -> String {
    let total_frames = (ms / 1000.0 * fps).round() as u64;
    let f = total_frames % fps as u64;
    let total_secs = total_frames / fps as u64;
    format!(
        "{:02}:{:02}:{:02}:{:02}",
        total_secs / 3600,
        (total_secs % 3600) / 60,
        total_secs % 60,
        f
    )
}

/// 导出 EDL（CMX3600）：把视频轨的每个片段写成一条剪辑记录，
/// 给达芬奇 / PR / EE 等软件对剪用。这是真交换格式，不是摆设。
#[tauri::command]
pub fn export_edl(
    sequence_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let project = require_project(&state)?;
    let seq = project
        .sequences
        .iter()
        .find(|s| s.id == sequence_id)
        .ok_or_else(|| "找不到序列".to_string())?;
    let fps = if seq.frame_rate >= 1.0 { seq.frame_rate } else { 25.0 };
    let width = seq.width;
    let height = seq.height;

    // 按轨道从高到低（顶层优先），只取视频轨；每个 clip 一条记录
    let mut tracks: Vec<_> = seq
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Video)
        .collect();
    tracks.sort_by_key(|t| std::cmp::Reverse(t.index));

    let mut out = String::new();
    out.push_str(&format!("TITLE: {} \n", seq.name));
    out.push_str("FCM: NON-DROP FRAME\n\n");
    let mut record_in = 0.0f64;
    let mut event_no = 1usize;
    for track in &tracks {
        for clip in &track.clips {
            let reel: String = clip
                .asset_id
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .take(8)
                .collect::<String>()
                .to_uppercase();
            let reel = if reel.is_empty() { "AX".to_string() } else { reel };
            // EDL 的源入出点就是素材时间戳：入点直接用 in_ms；
            // 出点按变速积分算（恒定速度时等于 out_ms，曲线时取实际走完的源长）
            let src_in = clip.in_ms;
            let src_out = clip.in_ms + clip.source_offset(clip.duration_ms);
            let rec_out = record_in + clip.duration_ms;
            out.push_str(&format!(
                "{:03}  {:<8} {:<3} {:<2}  {} {} {}\n",
                event_no,
                reel,
                "V",
                "C",
                edl_tc(src_in, fps),
                edl_tc(src_out, fps),
                edl_tc(record_in, fps),
            ));
            out.push_str(&format!("* FROM CLIP NAME: {}\n", clip.id));
            out.push_str(&format!("* RES: {}x{}\n\n", width, height));
            record_in = rec_out;
            event_no += 1;
        }
    }

    std::fs::write(&path, out).map_err(|e| format!("写 EDL 失败：{e}"))?;
    Ok(event_no - 1)
}

/// 内置导出预设：够用就好，全部中文名。
/// 探测本机 ffmpeg 是否有某个编码器（-encoders 列表里找名字）。
fn probe_encoder_available(name: &str) -> bool {
    let Some(ffmpeg) = crate::compositor::decode::locate_ffmpeg() else {
        return false;
    };
    let out = std::process::Command::new(&ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains(name),
        Err(_) => false,
    }
}

pub fn export_presets() -> Vec<ExportPreset> {
    vec![
        ExportPreset {
            id: "h264-1080p".into(),
            name: "1080p H.264".into(),
            container: "mp4".into(),
            video_codec: "h264".into(),
            audio_codec: "aac".into(),
            width: 1920,
            height: 1080,
            frame_rate: 30.0,
            bitrate_kbps: 12000,
            available: true,
        },
        ExportPreset {
            id: "h265-4k".into(),
            name: "4K H.265".into(),
            container: "mp4".into(),
            video_codec: "h265".into(),
            audio_codec: "aac".into(),
            width: 3840,
            height: 2160,
            frame_rate: 30.0,
            bitrate_kbps: 40000,
            available: true,
        },
        ExportPreset {
            id: "h264-720p-proxy".into(),
            name: "720p 代理".into(),
            container: "mp4".into(),
            video_codec: "h264".into(),
            audio_codec: "aac".into(),
            width: 1280,
            height: 720,
            frame_rate: 30.0,
            bitrate_kbps: 5000,
            available: true,
        },
    ]
}

/// 给子进程加 CREATE_NO_WINDOW，导出时绝不弹黑窗。
#[cfg(windows)]
pub fn no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn no_window(_command: &mut Command) {}

/// ffmpeg 自报的编码器名单（只认视频编码器），进程内缓存一次。
fn ffmpeg_encoders() -> &'static Vec<String> {
    static ENCODERS: OnceLock<Vec<String>> = OnceLock::new();
    ENCODERS.get_or_init(|| {
        let Some(ffmpeg) = decode::locate_ffmpeg() else {
            return Vec::new();
        };
        let mut command = Command::new(ffmpeg);
        command.args(["-hide_banner", "-encoders"]);
        no_window(&mut command);
        let Ok(output) = command.output() else {
            return Vec::new();
        };
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                let flags = fields.next()?;
                if !flags.starts_with('V') {
                    return None;
                }
                fields.next().map(str::to_string)
            })
            .collect()
    })
}

fn has_encoder(name: &str) -> bool {
    ffmpeg_encoders().iter().any(|e| e == name)
}

/// 真编一帧来验证编码器，光看 `-encoders` 名单不够：
/// 本机 `hevc_mf` 在名单里但初始化会报 0x80004005。
fn probe_encoder(name: &str) -> bool {
    if !has_encoder(name) {
        return false;
    }
    let Some(ffmpeg) = decode::locate_ffmpeg() else {
        return false;
    };
    let mut command = Command::new(ffmpeg);
    command.args([
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:r=1:d=1",
        "-frames:v",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        name,
        "-f",
        "null",
        "-",
    ]);
    no_window(&mut command);
    matches!(command.output(), Ok(o) if o.status.success())
}

/// 按编码族挑第一个本机真能用的编码器，进程内缓存。
fn resolve_encoder(codec: &str) -> Option<&'static str> {
    if codec.eq_ignore_ascii_case("h265") {
        static PICKED: OnceLock<Option<&'static str>> = OnceLock::new();
        *PICKED.get_or_init(|| {
            ["hevc_mf", "hevc_nvenc", "libx265"]
                .into_iter()
                .find(|name| probe_encoder(name))
        })
    } else {
        static PICKED: OnceLock<Option<&'static str>> = OnceLock::new();
        *PICKED.get_or_init(|| {
            ["h264_mf", "libopenh264", "h264_nvenc", "libx264"]
                .into_iter()
                .find(|name| probe_encoder(name))
        })
    }
}

fn codec_available(codec: &str) -> bool {
    resolve_encoder(codec).is_some()
}

/// 本机编码能力，前端用来禁用不可用预设。
#[tauri::command]
pub fn export_capabilities() -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    if codec_available("h264") {
        out.push("h264".into());
    }
    if codec_available("h265") {
        out.push("h265".into());
    }
    Ok(out)
}

/// 开始导出。返回任务 id，并立刻广播一条 0 进度。
///
/// 校验通过后在后台线程里跑完整条渲染管线：逐帧 plan → 解码 → 合成 →
/// RGBA 灌进 ffmpeg 的 stdin，音频按轨道混好后作为第二路输入一并封装。
/// 前端通过 `export://progress` 事件拿真进度。
#[tauri::command(async)]
pub fn start_export(
    sequence_id: String,
    preset: String,
    output_path: String,
    range: ExportRange,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ExportStart, String> {
    if output_path.trim().is_empty() {
        return Err("导出路径为空".to_string());
    }
    if range.end_ms <= range.start_ms {
        return Err("导出范围无效：结束时间必须晚于开始时间".to_string());
    }
    let preset_def = export_presets()
        .into_iter()
        .find(|p| p.id == preset)
        .ok_or_else(|| format!("未知的导出预设：{preset}"))?;
    // 编码器在启动时就定下来：没有可用编码器就不要让任务进队列空转。
    let video_encoder = resolve_encoder(&preset_def.video_codec).ok_or_else(|| {
        if preset_def.video_codec.eq_ignore_ascii_case("h265") {
            "本机 ffmpeg 没有可用的 H.265 编码器（hevc_mf / hevc_nvenc / libx265 均不可用），请改用 H.264 预设".to_string()
        } else {
            "本机 ffmpeg 没有可用的 H.264 编码器（h264_mf / libopenh264 均不可用），请检查 ffmpeg 目录是否完整".to_string()
        }
    })?;

    // 校验序列存在，帧率与画幅以序列为准，预设只定封装与压缩档位。
    let (project, keyframes, cache_dir) = {
        let guard = lock(&state.project)?;
        let project = guard
            .as_ref()
            .ok_or_else(|| "还没有打开项目".to_string())?
            .clone();
        let keyframes = lock(&state.keyframes)?.clone();
        let cache_dir = lock(&state.settings)?.cache_dir.clone();
        (project, keyframes, cache_dir)
    };
    let sequence = project
        .sequences
        .iter()
        .find(|s| s.id == sequence_id)
        .ok_or_else(|| "找不到该序列".to_string())?
        .clone();

    let frame_rate = sequence.frame_rate.max(1.0);
    let span_ms = range.end_ms - range.start_ms;
    let total_frames = ((span_ms / 1000.0) * frame_rate).round().max(0.0) as u64;
    if total_frames == 0 {
        return Err("导出范围太短，按序列帧率算不出一整帧".to_string());
    }

    let size = export_size(&sequence, preset_def.width, preset_def.height);
    let job_id = new_id("export");

    {
        let mut exports = lock(&state.exports)?;
        exports.insert(
            job_id.clone(),
            ExportJob {
                id: job_id.clone(),
                paused: false,
                cancelled: false,
                frame: 0,
                total_frames,
                stage: "准备中".into(),
            },
        );
    }

    let _ = app.emit(
        "export://progress",
        ExportProgress {
            job_id: job_id.clone(),
            frame: 0,
            total_frames,
            eta_ms: 0.0,
            stage: "准备中".into(),
        },
    );

    std::thread::Builder::new()
        .name(format!("export-{job_id}"))
        .spawn({
            let job_id = job_id.clone();
            move || {
                run_export(
                    app,
                    job_id,
                    project,
                    sequence,
                    keyframes,
                    preset_def,
                    video_encoder,
                    size,
                    frame_rate,
                    range,
                    PathBuf::from(output_path),
                    PathBuf::from(cache_dir),
                    total_frames,
                );
            }
        })
        .map_err(|e| format!("导出线程启动失败：{e}"))?;

    Ok(ExportStart { job_id })
}

/// 按预设画幅收序列画幅：等比放进预设框里，且**绝不硬放大**——
/// 放大不增加信息量只费编码时间；宽高都取偶（yuv420p 的硬要求）。
fn export_size(sequence: &Sequence, preset_w: u32, preset_h: u32) -> (usize, usize) {
    let sw = (sequence.width.max(1)) as f64;
    let sh = (sequence.height.max(1)) as f64;
    let factor = 1.0f64.min((preset_w.max(1) as f64 / sw).min(preset_h.max(1) as f64 / sh));
    let even = |v: f64| -> usize { ((v.round() as usize).max(2)) & !1 };
    (even(sw * factor), even(sh * factor))
}

/// 后台导出主循环。所有失败都以中文进度事件回报，绝不 panic。
#[allow(clippy::too_many_arguments)]
fn run_export(
    app: AppHandle,
    job_id: String,
    project: Project,
    sequence: Sequence,
    keyframes: KeyframeStore,
    preset: ExportPreset,
    video_encoder: &'static str,
    size: (usize, usize),
    frame_rate: f64,
    range: ExportRange,
    output: PathBuf,
    cache_dir: PathBuf,
    total_frames: u64,
) {
    let emit = |frame: u64, stage: &str| {
        let _ = app.emit(
            "export://progress",
            ExportProgress {
                job_id: job_id.clone(),
                frame,
                total_frames,
                eta_ms: 0.0,
                stage: stage.to_string(),
            },
        );
    };

    // —— 音频：把范围内所有带音轨的片段混成一条 PCM 临时文件 —— //
    emit(0, "混音中");
    let pcm_path = cache_dir.join(format!("export-mix-{job_id}.pcm"));
    let has_audio = mix_audio(&project, &sequence, range, &pcm_path);

    // —— 字幕：先生成 ASS，编码时用 subtitles 滤镜烧进画面 —— //
    let ass_path = cache_dir.join(format!("sub-{job_id}.ass"));
    let _ass_guard = TempFile(ass_path.clone());
    let has_subtitles = match subtitle::write_ass(
        &sequence,
        range.start_ms,
        range.end_ms,
        size.0,
        size.1,
        &ass_path,
    ) {
        Ok(v) => v,
        Err(e) => {
            emit(0, &format!("提示：字幕烧录已跳过（{e}）"));
            false
        }
    };

    // —— 起 ffmpeg：视频裸流走 stdin，音频有就多挂一路输入 —— //
    emit(0, "编码中");
    let Some(ffmpeg) = decode::locate_ffmpeg() else {
        let _ = std::fs::remove_file(&pcm_path);
        emit(0, "失败：没找到 ffmpeg，无法编码导出");
        return;
    };
    let mut command = Command::new(&ffmpeg);
    command
        .args(["-y", "-v", "error"])
        .args([
            "-f", "rawvideo",
            "-pix_fmt", "rgba",
            "-s", &format!("{}x{}", size.0, size.1),
            "-r", &format!("{frame_rate:.6}"),
            "-i", "pipe:0",
        ]);
    if has_audio {
        command.args([
            "-f", "f32le",
            "-ar", &MIX_SAMPLE_RATE.to_string(),
            "-ac", "2",
            "-i",
        ]);
        command.arg(&pcm_path);
        command.args(["-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]);
    }
    command.args(["-c:v", video_encoder, "-pix_fmt", "yuv420p"]);
    if video_encoder.starts_with("libx26") {
        // 源码编码器走 CRF 恒定质量。
        command.args(["-preset", "veryfast", "-crf", "20"]);
    } else {
        // 硬件编码器只认码率，`-preset` / `-crf` 对它们只会打印警告。
        let bitrate = preset.bitrate_kbps.max(500);
        command.args(["-b:v", &format!("{bitrate}k")]);
        if video_encoder.ends_with("_nvenc") {
            command.args(["-rc", "vbr"]);
        }
    }
    if has_subtitles {
        // 切到缓存目录 + 只用文件名：Windows 路径里的冒号和反斜杠
        // 传给 subtitles 滤镜要经过两层转义，极容易写坏。
        command.current_dir(&cache_dir);
        command.args(["-vf", &format!("subtitles=sub-{job_id}.ass")]);
    }
    command
        .args(["-movflags", "+faststart"])
        .arg(&output)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_file(&pcm_path);
            emit(0, &format!("失败：启动 ffmpeg 编码器失败：{e}"));
            return;
        }
    };
    let mut stdin = child.stdin.take().expect("ffmpeg stdin 必须可写");

    // —— 逐帧渲染 —— //
    let frame_ms = 1000.0 / frame_rate;
    let started = std::time::Instant::now();
    let mut done: u64 = 0;
    let mut failure: Option<String> = None;

    for index in 0..total_frames {
        // 取消 / 暂停查的是权威任务表，命令层改的就是同一份。
        loop {
            let (cancelled, paused) = {
                let managed = app.state::<AppState>();
                let exports = managed.exports.lock().unwrap();
                let job = exports.get(&job_id);
                (
                    job.map(|j| j.cancelled).unwrap_or(false),
                    job.map(|j| j.paused).unwrap_or(false),
                )
            };
            if cancelled {
                finish_cancelled(child, &output, &pcm_path, &emit);
                return;
            }
            if !paused {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(120));
        }

        let time_ms = range.start_ms + index as f64 * frame_ms;
        let plan = {
            match render::plan_frame(&project, &sequence.id, time_ms, size, &keyframes) {
                Ok(p) => p,
                Err(e) => {
                    failure = Some(e);
                    break;
                }
            }
        };
        // 与预览共用同一条渲染路径：解码 → 效果栈 → 入场转场混合。
        let frame = match render::render_plan(&plan) {
            Ok(f) => f,
            Err(e) => {
                failure = Some(e);
                break;
            }
        };
        let rgba = render::frame_to_rgba8(&frame);
        if stdin.write_all(&rgba).is_err() {
            failure = Some("编码器提前退出，无法继续写入画面".to_string());
            break;
        }

        done += 1;
        {
            let managed = app.state::<AppState>();
            let mut exports = managed.exports.lock().unwrap();
            if let Some(job) = exports.get_mut(&job_id) {
                job.frame = done;
            }
        }
        let elapsed = started.elapsed().as_secs_f64();
        let eta = if done > 0 {
            elapsed / done as f64 * (total_frames - done) as f64 * 1000.0
        } else {
            0.0
        };
        let _ = app.emit(
            "export://progress",
            ExportProgress {
                job_id: job_id.clone(),
                frame: done,
                total_frames,
                eta_ms: eta,
                stage: "导出中".into(),
            },
        );
    }

    if let Some(err) = failure {
        let _ = stdin.write_all(&[]);
        drop(stdin);
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_file(&pcm_path);
        let _ = std::fs::remove_file(&output);
        emit(done, &format!("失败：{err}"));
        return;
    }

    drop(stdin);
    match child.wait() {
        Ok(status) if status.success() => {
            let _ = std::fs::remove_file(&pcm_path);
            let managed = app.state::<AppState>();
            let mut exports = managed.exports.lock().unwrap();
            if let Some(job) = exports.get_mut(&job_id) {
                job.frame = total_frames;
            }
            emit(total_frames, "已完成");
        }
        Ok(_) => {
            let _ = std::fs::remove_file(&output);
            emit(done, "失败：编码器异常退出，请检查磁盘空间后重试");
        }
        Err(e) => emit(done, &format!("失败：等待编码器退出出错：{e}")),
    }
}

/// 取消收尾：杀编码器、删半成品、删临时混音，进度报「已取消」。
fn finish_cancelled(
    mut child: Child,
    output: &Path,
    pcm_path: &Path,
    emit: &dyn Fn(u64, &str),
) {
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_file(output);
    let _ = std::fs::remove_file(pcm_path);
    emit(0, "已取消");
}

/// 临时文件守卫：函数从任何分支返回都会顺手清掉，字幕文件不会越积越多。
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// 片段内某一时刻的音频增益（0～1）。
///
/// `local_ms` 是片段内的时间线偏移，`duration_ms` 是片段在时间线上的时长。
/// `fade_in_ms` / `fade_out_ms` 为 `None` 或不大于 0 时视为无淡变；
/// 淡入与淡出区间重叠时两段增益相乘，最后夹到 0～1。
fn clip_audio_gain(
    local_ms: f64,
    duration_ms: f64,
    fade_in_ms: Option<f64>,
    fade_out_ms: Option<f64>,
) -> f32 {
    let mut gain = 1.0f64;
    if let Some(fi) = fade_in_ms.filter(|v| *v > 0.0) {
        if local_ms < fi {
            gain *= (local_ms / fi).max(0.0);
        }
    }
    if let Some(fo) = fade_out_ms.filter(|v| *v > 0.0) {
        let remaining = duration_ms - local_ms;
        if remaining < fo {
            gain *= (remaining / fo).max(0.0);
        }
    }
    gain.clamp(0.0, 1.0) as f32
}

/// 把范围内所有带音轨的片段混成一条立体声 PCM，落临时文件。
///
/// 覆盖范围只算片段与导出区间的交集；交叠的片段直接叠相加（上限 1.0 交给
/// 编码器软限幅）。没有任何可混的音频时返回假，编码端就不挂音频输入。
fn mix_audio(
    project: &Project,
    sequence: &Sequence,
    range: ExportRange,
    pcm_path: &Path,
) -> bool {
    let span_ms = range.end_ms - range.start_ms;
    let total_samples = ((span_ms / 1000.0) * MIX_SAMPLE_RATE as f64).ceil() as usize * 2;
    if total_samples == 0 {
        return false;
    }
    let mut mix = vec![0.0f32; total_samples];
    let mut any = false;

    for track in &sequence.tracks {
        if track.kind == TrackKind::Camera || track.hidden || track.muted {
            continue;
        }
        for clip in &track.clips {
            let clip_end = clip.end_ms();
            let from = clip.start_ms.max(range.start_ms);
            let to = clip_end.min(range.end_ms);
            if to <= from {
                continue;
            }
            let Some(asset) = project.assets.iter().find(|a| a.id == clip.asset_id) else {
                continue;
            };
            if !asset.has_audio || asset.missing {
                continue;
            }
            let speed = if clip.speed.abs() < f64::EPSILON { 1.0 } else { clip.speed };
            // 曲线变速：按曲线积分算源区间，输出长度仍是时间线占位（∫speed）；
            // 恒定变速走老路（atempo 保调 / 重采样变调）。
            let pcm = if clip.has_speed_curve() {
                let from_local = from - clip.start_ms;
                let to_local = to - clip.start_ms;
                audio::decode_segment_stereo_curved(
                    Path::new(&asset.path),
                    clip,
                    from_local,
                    to_local,
                )
            } else {
                // 交叠段在素材内的起点：入点加上（交叠起点 - 片段起点）× 速度。
                let local_in = if clip.reversed {
                    clip.in_ms
                } else {
                    clip.in_ms + (from - clip.start_ms) * speed
                };
                let duration_ms = (to - from) * speed;
                audio::decode_segment_stereo(
                    Path::new(&asset.path),
                    local_in,
                    duration_ms,
                    speed,
                    clip.audio_pitch_shift,
                )
            };
            let Ok(pcm) = pcm else {
                continue;
            };
            let offset = (((from - range.start_ms) / 1000.0) * MIX_SAMPLE_RATE as f64).round()
                as usize
                * 2;
            let avail = pcm.len().min(mix.len().saturating_sub(offset));
            if avail == 0 {
                continue;
            }
            // 按立体声帧算片段内偏移：淡入淡出只与时间线位置有关，
            // 与解码速度无关，所以直接用交叠起点减去片段起点。
            let segment_start_local = from - clip.start_ms;
            for (frame, pair) in pcm[..avail].chunks_exact(2).enumerate() {
                let local_ms =
                    segment_start_local + frame as f64 * 1000.0 / MIX_SAMPLE_RATE as f64;
                let gain = clip_audio_gain(
                    local_ms,
                    clip.duration_ms,
                    clip.audio_fade_in_ms,
                    clip.audio_fade_out_ms,
                );
                mix[offset + frame * 2] += pair[0] * gain;
                mix[offset + frame * 2 + 1] += pair[1] * gain;
            }
            any = true;
        }
    }

    if !any {
        return false;
    }
    if let Some(parent) = pcm_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let bytes: Vec<u8> = mix
        .iter()
        .flat_map(|s| s.clamp(-1.0, 1.0).to_le_bytes())
        .collect();
    std::fs::write(pcm_path, bytes).is_ok()
}

/// 取消导出。
#[tauri::command]
pub fn cancel_export(job_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let mut exports = lock(&state.exports)?;
    let job = exports
        .get_mut(&job_id)
        .ok_or_else(|| "找不到该导出任务".to_string())?;
    job.cancelled = true;
    job.paused = false;
    job.stage = "已取消".into();
    Ok(true)
}

/// 暂停导出。
#[tauri::command]
pub fn pause_export(job_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let mut exports = lock(&state.exports)?;
    let job = exports
        .get_mut(&job_id)
        .ok_or_else(|| "找不到该导出任务".to_string())?;
    if job.cancelled {
        return Err("任务已取消，无法暂停".to_string());
    }
    job.paused = true;
    job.stage = "已暂停".into();
    Ok(true)
}

/// 继续导出。
#[tauri::command]
pub fn resume_export(job_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let mut exports = lock(&state.exports)?;
    let job = exports
        .get_mut(&job_id)
        .ok_or_else(|| "找不到该导出任务".to_string())?;
    if job.cancelled {
        return Err("任务已取消，无法继续".to_string());
    }
    job.paused = false;
    job.stage = "导出中".into();
    Ok(true)
}

/// 取导出预设列表。
#[tauri::command]
pub fn list_export_presets() -> Result<Vec<ExportPreset>, String> {
    Ok(export_presets()
        .into_iter()
        .map(|mut p| {
            p.available = codec_available(&p.video_codec);
            p
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sequence(width: u32, height: u32) -> Sequence {
        let mut project = crate::project::serialize::new_project("导出画幅");
        let seq = &mut project.sequences[0];
        seq.width = width;
        seq.height = height;
        seq.clone()
    }

    /// 1080p 序列进 4K 预设：不许硬放大，保持序列原画幅。
    #[test]
    fn export_size_never_upscales_beyond_preset_fit() {
        let seq = sequence(1920, 1080);
        assert_eq!(export_size(&seq, 3840, 2160), (1920, 1080));
    }

    /// 竖屏序列进横屏预设：等比收进框里，两边都不超。
    #[test]
    fn export_size_fits_portrait_into_landscape_box() {
        let seq = sequence(1080, 1920);
        let (w, h) = export_size(&seq, 1920, 1080);
        assert_eq!((w, h), (608, 1080));
    }

    /// yuv420p 要求宽高都是偶数。
    #[test]
    fn export_size_snaps_to_even_dimensions() {
        let seq = sequence(1001, 601);
        let (w, h) = export_size(&seq, 1920, 1080);
        assert_eq!(w % 2, 0);
        assert_eq!(h % 2, 0);
    }

    /// 没有淡变设置时增益恒为 1。
    #[test]
    fn audio_gain_is_unity_without_fades() {
        assert_eq!(clip_audio_gain(0.0, 1000.0, None, None), 1.0);
        assert_eq!(clip_audio_gain(500.0, 1000.0, None, None), 1.0);
        assert_eq!(clip_audio_gain(1000.0, 1000.0, None, None), 1.0);
    }

    /// 淡入：片段内偏移走到淡入时长一半时，增益是一半。
    #[test]
    fn audio_gain_ramps_up_during_fade_in() {
        assert_eq!(clip_audio_gain(0.0, 1000.0, Some(400.0), None), 0.0);
        assert_eq!(clip_audio_gain(200.0, 1000.0, Some(400.0), None), 0.5);
        assert_eq!(clip_audio_gain(400.0, 1000.0, Some(400.0), None), 1.0);
        assert_eq!(clip_audio_gain(800.0, 1000.0, Some(400.0), None), 1.0);
    }

    /// 淡出：距离片段结束还剩淡出时长一半时，增益是一半。
    #[test]
    fn audio_gain_ramps_down_during_fade_out() {
        assert_eq!(clip_audio_gain(0.0, 1000.0, None, Some(400.0)), 1.0);
        assert_eq!(clip_audio_gain(600.0, 1000.0, None, Some(400.0)), 1.0);
        assert_eq!(clip_audio_gain(800.0, 1000.0, None, Some(400.0)), 0.5);
        assert_eq!(clip_audio_gain(1000.0, 1000.0, None, Some(400.0)), 0.0);
    }

    /// 淡入淡出时长不大于 0 时视为没有设置。
    #[test]
    fn audio_gain_ignores_non_positive_fades() {
        assert_eq!(clip_audio_gain(10.0, 1000.0, Some(0.0), Some(-5.0)), 1.0);
    }

    /// 淡入与淡出重叠时两段增益相乘，并且始终夹在 0～1。
    #[test]
    fn audio_gain_multiplies_overlapping_fades() {
        let gain = clip_audio_gain(500.0, 1000.0, Some(1000.0), Some(1000.0));
        assert!((gain - 0.25).abs() < 1e-6, "重叠中点应为 0.5 × 0.5");

        // 片段外（负偏移 / 超出结尾）也不能算出负增益。
        assert_eq!(clip_audio_gain(-100.0, 1000.0, Some(400.0), None), 0.0);
        assert_eq!(clip_audio_gain(2000.0, 1000.0, None, Some(400.0)), 0.0);
    }
}
