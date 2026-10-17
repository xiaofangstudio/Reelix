//! 字幕命令：本地离线语音转写、字幕轨写入、导出烧录。
//!
//! 整条链路都在本机跑完，不联网：
//! 1. ffmpeg 把片段对应的一段声音抽成 16kHz 单声道 WAV；
//! 2. sherpa-onnx（silero VAD + SenseVoice）切句并识别，输出
//!    `0.742 -- 5.568: 开饭时间早上九点至下午五点`；
//! 3. 把识别结果按片段速度映射回时间线，写进序列的字幕轨；
//! 4. 导出时生成 ASS，交给 ffmpeg 的 `subtitles` 滤镜烧进画面。
//!
//! 组件是可选依赖：`asr/bin` + `asr/models` 不在就返回一句中文提示，
//! 不影响剪辑、特效、导出这些主链路。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::compositor::decode;
use crate::history::record;
use crate::project::serialize::new_id;
use crate::state::{lock, AppState};
use crate::timeline::model::{Clip, Track, TrackKind};

const ASR_MISSING: &str =
    "未找到本地语音识别组件（asr/bin + asr/models），字幕生成暂不可用";

/// 一条识别出来的字幕，时间已经映射到时间线。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleSegment {
    pub start_ms: f64,
    pub end_ms: f64,
    pub text: String,
}

/// 语音识别组件的探测结果，前端用来决定按钮是否可点。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrStatus {
    pub available: bool,
    pub binary: String,
    pub model_dir: String,
    pub detail: String,
}

struct AsrBundle {
    binary: PathBuf,
    model: PathBuf,
    vad: PathBuf,
    tokens: PathBuf,
}

/// 从 exe 所在目录逐级往上找 `asr/`、`reference/asr/`、`resources/asr/`。
///
/// 开发时组件放在仓库的 `reference/asr`，打包后放 `resources/asr`；
/// 两种位置都认，省得每次构建完还要手动搬。
fn locate_asr() -> Option<AsrBundle> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(Path::to_path_buf);
        for _ in 0..8 {
            let Some(current) = dir else { break };
            roots.push(current.join("asr"));
            roots.push(current.join("reference").join("asr"));
            roots.push(current.join("resources").join("asr"));
            dir = current.parent().map(Path::to_path_buf);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join("asr"));
        roots.push(cwd.join("reference").join("asr"));
    }

    let exe_name = if cfg!(windows) {
        "sherpa-onnx-vad-with-offline-asr.exe"
    } else {
        "sherpa-onnx-vad-with-offline-asr"
    };
    for root in roots {
        let binary = root.join("bin").join(exe_name);
        let models = root.join("models");
        let model = models.join("model.int8.onnx");
        let vad = models.join("silero_vad.onnx");
        let tokens = models.join("tokens.txt");
        if binary.is_file() && model.is_file() && vad.is_file() && tokens.is_file() {
            return Some(AsrBundle {
                binary,
                model,
                vad,
                tokens,
            });
        }
    }
    None
}

/// 语音识别组件是否就绪。
#[tauri::command]
pub fn asr_status() -> Result<AsrStatus, String> {
    match locate_asr() {
        Some(bundle) => Ok(AsrStatus {
            available: true,
            binary: bundle.binary.to_string_lossy().into_owned(),
            model_dir: bundle
                .model
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            detail: "本地离线识别已就绪（silero VAD + SenseVoice）".into(),
        }),
        None => Ok(AsrStatus {
            available: false,
            binary: String::new(),
            model_dir: String::new(),
            detail: ASR_MISSING.into(),
        }),
    }
}

/// 给子进程加 CREATE_NO_WINDOW，抽音、识别都不能弹黑窗。
#[cfg(windows)]
fn no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn no_window(_command: &mut Command) {}

/// 把片段对应的源音轨抽成 16kHz 单声道 WAV。
fn extract_wav(
    ffmpeg: &Path,
    source: &Path,
    in_ms: f64,
    span_ms: f64,
    output: &Path,
) -> Result<(), String> {
    let mut command = Command::new(ffmpeg);
    command.args(["-y", "-hide_banner", "-v", "error", "-nostdin"]);
    command.args(["-ss", &format!("{:.3}", in_ms.max(0.0) / 1000.0)]);
    command.args(["-t", &format!("{:.3}", span_ms.max(0.0) / 1000.0)]);
    command.arg("-i");
    command.arg(source);
    command.args(["-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"]);
    command.arg(output);
    no_window(&mut command);

    let out = command
        .output()
        .map_err(|e| format!("调用 ffmpeg 抽取音频失败：{e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr.lines().rev().take(2).collect::<Vec<_>>().join("；");
        return Err(format!("抽取音频失败：{tail}"));
    }
    Ok(())
}

/// 跑 VAD + 识别，超时十分钟就杀掉，避免坏文件把任务挂死。
fn run_asr(bundle: &AsrBundle, wav: &Path, log_path: &Path) -> Result<String, String> {
    let log = std::fs::File::create(log_path)
        .map_err(|e| format!("创建识别日志失败：{e}"))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("创建识别日志失败：{e}"))?;

    let mut command = Command::new(&bundle.binary);
    command.args(["--silero-vad-model"]);
    command.arg(&bundle.vad);
    command.args(["--tokens"]);
    command.arg(&bundle.tokens);
    command.args(["--sense-voice-model"]);
    command.arg(&bundle.model);
    command.args(["--num-threads", "2"]);
    command.arg(wav);
    // DLL 就在 bin 目录里，工作目录必须切过去。
    if let Some(dir) = bundle.binary.parent() {
        command.current_dir(dir);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    no_window(&mut command);

    let mut child = command
        .spawn()
        .map_err(|e| format!("启动语音识别失败：{e}"))?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed().as_secs() > 600 {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("语音识别超时（超过 10 分钟），请换一段更短的片段".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => return Err(format!("等待语音识别退出失败：{e}")),
        }
    }

    std::fs::read_to_string(log_path).map_err(|e| format!("读取识别结果失败：{e}"))
}

/// 解析识别输出。识别器可能混入加载日志，只认带 `--` 与时间戳的行。
pub(crate) fn parse_asr_output(raw: &str) -> Vec<(f64, f64, String)> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let Some((left, right)) = line.split_once("--") else {
            continue;
        };
        let Ok(start) = left.trim().parse::<f64>() else {
            continue;
        };
        let Some((end_text, text)) = right.split_once(':') else {
            continue;
        };
        let Ok(end) = end_text.trim().parse::<f64>() else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() || end <= start {
            continue;
        }
        out.push((start, end, text.to_string()));
    }
    out
}

/// 对片段做一次离线转写，返回已经映射到时间线的字幕。
#[tauri::command(async)]
pub fn generate_subtitles(
    clip_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<SubtitleSegment>, String> {
    let bundle = locate_asr().ok_or_else(|| ASR_MISSING.to_string())?;
    let ffmpeg = decode::locate_ffmpeg()
        .ok_or_else(|| "没找到 ffmpeg，无法抽取音频".to_string())?;

    // 先把片段需要的信息全部拷出来，后面跑识别时不再占着工程锁。
    let (source, clip_start, clip_end, in_ms, out_ms, speed) = {
        let guard = lock(&state.project)?;
        let project = guard.as_ref().ok_or_else(|| "还没有打开项目".to_string())?;
        let clip = project
            .sequences
            .iter()
            .flat_map(|s| s.tracks.iter())
            .flat_map(|t| t.clips.iter())
            .find(|c| c.id == clip_id)
            .ok_or_else(|| "找不到该片段".to_string())?;
        let asset = project
            .assets
            .iter()
            .find(|a| a.id == clip.asset_id)
            .ok_or_else(|| "该片段没有可识别的音频素材".to_string())?;
        if asset.missing {
            return Err("素材文件丢失，请重新链接后再试".to_string());
        }
        let speed = if clip.speed.abs() < f64::EPSILON {
            1.0
        } else {
            clip.speed.abs()
        };
        (
            asset.path.clone(),
            clip.start_ms,
            clip.start_ms + clip.duration_ms,
            clip.in_ms.min(clip.out_ms).max(0.0),
            clip.out_ms.max(clip.in_ms),
            speed,
        )
    };

    let span_ms = out_ms - in_ms;
    if span_ms < 200.0 {
        return Err("片段太短，至少需要 0.2 秒的素材范围".to_string());
    }
    if !Path::new(&source).exists() {
        return Err("素材文件不存在，请重新链接后再试".to_string());
    }

    let cache_dir = PathBuf::from(lock(&state.settings)?.cache_dir.clone());
    let dir = cache_dir.join("subtitle");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建字幕缓存目录失败：{e}"))?;
    let stamp = new_id("asr");
    let wav = dir.join(format!("{stamp}.wav"));
    let log = dir.join(format!("{stamp}.log"));

    let result = extract_wav(&ffmpeg, Path::new(&source), in_ms, span_ms, &wav)
        .and_then(|_| run_asr(&bundle, &wav, &log));

    let _ = std::fs::remove_file(&wav);
    let _ = std::fs::remove_file(&log);
    let raw = result?;

    let mut segments = Vec::new();
    for (start_s, end_s, text) in parse_asr_output(&raw) {
        // 素材时间 → 时间线时间：片段内的源时间除以速度。
        let start = clip_start + start_s * 1000.0 / speed;
        let end = clip_start + end_s * 1000.0 / speed;
        let start = start.max(clip_start);
        let end = end.min(clip_end);
        if end - start < 40.0 {
            continue;
        }
        segments.push(SubtitleSegment {
            start_ms: (start * 10.0).round() / 10.0,
            end_ms: (end * 10.0).round() / 10.0,
            text,
        });
    }

    if segments.is_empty() {
        return Err("没有识别到语音，请确认片段里有清晰的人声".to_string());
    }
    Ok(segments)
}

/// 把一批字幕写进序列的字幕轨：没有字幕轨就建一条，旧字幕先清掉。
#[tauri::command]
pub fn apply_subtitles(
    sequence_id: String,
    segments: Vec<SubtitleSegment>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let mut guard = lock(&state.project)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let sequence = project
        .sequences
        .iter_mut()
        .find(|s| s.id == sequence_id)
        .ok_or_else(|| "找不到该序列".to_string())?;

    let track_index = sequence
        .tracks
        .iter()
        .position(|t| t.kind == TrackKind::Subtitle);
    let track_index = match track_index {
        Some(i) => i,
        None => {
            let index = sequence
                .tracks
                .iter()
                .filter(|t| t.kind == TrackKind::Subtitle)
                .count() as i32;
            sequence.tracks.push(Track {
                id: new_id("track"),
                kind: TrackKind::Subtitle,
                index,
                muted: false,
                solo: false,
                locked: false,
                hidden: false,
                height: 40.0,
                clips: Vec::new(),
            });
            sequence.tracks.len() - 1
        }
    };

    let track = &mut sequence.tracks[track_index];
    let track_id = track.id.clone();
    track.clips.clear();

    let mut count = 0usize;
    for segment in segments {
        let text = segment.text.trim();
        if text.is_empty() || segment.end_ms <= segment.start_ms {
            continue;
        }
        let duration = segment.end_ms - segment.start_ms;
        track.clips.push(Clip {
            id: new_id("clip"),
            // 字幕不需要素材，asset_id 留空，渲染时按 text 处理。
            asset_id: String::new(),
            track_id: track_id.clone(),
            start_ms: segment.start_ms.max(0.0),
            duration_ms: duration,
            in_ms: 0.0,
            out_ms: duration,
            speed: 1.0,
            reversed: false,
            node_id: String::new(),
            compound_id: None,
            enable_3d: false,
            transform_3d: None,
            text: Some(text.to_string()),
        });
        count += 1;
    }
    track
        .clips
        .sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap_or(std::cmp::Ordering::Equal));

    record(&state, &format!("生成字幕（{count} 条）"), project)?;
    *lock(&state.project_dirty)? = true;
    Ok(count)
}

/// 手动新建一条字幕片段。
#[tauri::command]
pub fn add_subtitle_clip(
    sequence_id: String,
    start_ms: f64,
    duration_ms: f64,
    text: String,
    state: State<'_, AppState>,
) -> Result<Clip, String> {
    let duration = duration_ms.max(200.0);
    let mut guard = lock(&state.project)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let sequence = project
        .sequences
        .iter_mut()
        .find(|s| s.id == sequence_id)
        .ok_or_else(|| "找不到该序列".to_string())?;

    let track_id = match sequence
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Subtitle)
    {
        Some(t) => t.id.clone(),
        None => {
            let index = sequence
                .tracks
                .iter()
                .filter(|t| t.kind == TrackKind::Subtitle)
                .count() as i32;
            let track = Track {
                id: new_id("track"),
                kind: TrackKind::Subtitle,
                index,
                muted: false,
                solo: false,
                locked: false,
                hidden: false,
                height: 40.0,
                clips: Vec::new(),
            };
            let id = track.id.clone();
            sequence.tracks.push(track);
            id
        }
    };

    let clip = Clip {
        id: new_id("clip"),
        asset_id: String::new(),
        track_id: track_id.clone(),
        start_ms: start_ms.max(0.0),
        duration_ms: duration,
        in_ms: 0.0,
        out_ms: duration,
        speed: 1.0,
        reversed: false,
        node_id: String::new(),
        compound_id: None,
        enable_3d: false,
        transform_3d: None,
        text: Some(if text.trim().is_empty() {
            "新字幕".to_string()
        } else {
            text.trim().to_string()
        }),
    };

    let track = sequence
        .tracks
        .iter_mut()
        .find(|t| t.id == track_id)
        .ok_or_else(|| "找不到字幕轨".to_string())?;
    track.clips.push(clip.clone());
    track
        .clips
        .sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap_or(std::cmp::Ordering::Equal));

    record(&state, "添加字幕", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(clip)
}

/// 改一条字幕的文字。传空串等于清掉文字。
#[tauri::command]
pub fn set_clip_text(
    clip_id: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = lock(&state.project)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let mut found = false;
    for sequence in project.sequences.iter_mut() {
        for track in sequence.tracks.iter_mut() {
            if let Some(clip) = track.clips.iter_mut().find(|c| c.id == clip_id) {
                clip.text = if text.trim().is_empty() {
                    None
                } else {
                    Some(text.trim().to_string())
                };
                found = true;
                break;
            }
        }
        if found {
            break;
        }
    }
    if !found {
        return Err("找不到该片段".to_string());
    }

    record(&state, "修改字幕文字", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// ASS 时间：`H:MM:SS.cc`。
fn ass_time(ms: f64) -> String {
    let cs = (ms.max(0.0) / 10.0).round() as u64;
    let h = cs / 360_000;
    let m = (cs % 360_000) / 6_000;
    let s = (cs % 6_000) / 100;
    let c = cs % 100;
    format!("{h}:{m:02}:{s:02}.{c:02}")
}

/// ASS 文本转义：花括号是样式标签，换行要写成 `\N`。
fn ass_escape(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('{', "\\{")
        .replace('}', "\\}")
        .replace(['\r', '\n'], "\\N")
}

/// 把序列里所有字幕写成 ASS，时间轴平移到导出区间。
///
/// 返回是否有字幕事件。没有就不建文件，导出端也不会挂 `subtitles` 滤镜。
pub(crate) fn write_ass(
    sequence: &crate::project::model::Sequence,
    range_start_ms: f64,
    range_end_ms: f64,
    width: usize,
    height: usize,
    path: &Path,
) -> Result<bool, String> {
    let mut events: Vec<(f64, f64, &str)> = Vec::new();
    for track in &sequence.tracks {
        if track.kind != TrackKind::Subtitle || track.hidden {
            continue;
        }
        for clip in &track.clips {
            let Some(text) = clip.text.as_deref() else {
                continue;
            };
            if text.trim().is_empty() {
                continue;
            }
            let from = clip.start_ms.max(range_start_ms);
            let to = clip.end_ms().min(range_end_ms);
            if to <= from {
                continue;
            }
            events.push((from - range_start_ms, to - range_start_ms, text));
        }
    }
    if events.is_empty() {
        return Ok(false);
    }
    events.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    // 字号跟导出高度走：1080p 约 49px，720p 约 32px。
    let font_size = (height as f64 * 0.045).clamp(14.0, 96.0);
    let outline = (font_size * 0.06).clamp(1.0, 4.0);
    let margin_v = (height as f64 * 0.055).round();

    let mut ass = String::new();
    ass.push_str("[Script Info]\n");
    ass.push_str("; Reelix 字幕\n");
    ass.push_str("ScriptType: v4.00+\n");
    ass.push_str(&format!("PlayResX: {width}\n"));
    ass.push_str(&format!("PlayResY: {height}\n"));
    ass.push_str("WrapStyle: 2\n");
    ass.push_str("ScaledBorderAndShadow: yes\n\n");
    ass.push_str("[V4+ Styles]\n");
    ass.push_str("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n");
    ass.push_str(&format!(
        "Style: Reelix,Microsoft YaHei,{font_size:.0},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,{outline:.0},0,2,60,60,{margin_v:.0},1\n\n"
    ));
    ass.push_str("[Events]\n");
    ass.push_str("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");
    for (start, end, text) in events {
        ass.push_str(&format!(
            "Dialogue: 0,{},{},Reelix,,0,0,0,,{}\n",
            ass_time(start),
            ass_time(end),
            ass_escape(text)
        ));
    }

    std::fs::write(path, ass).map_err(|e| format!("写入字幕文件失败：{e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::serialize::new_project;

    /// 识别输出里混着加载日志时，只解析真正带时间戳的行。
    #[test]
    fn parse_asr_output_skips_log_noise() {
        let raw = "Loading model...\n0.742 -- 5.568: 开饭时间早上九点至下午五点\n\
                   7.100 -- 8.000: 第二句\n-- 无效 --\n";
        let parsed = parse_asr_output(raw);
        assert_eq!(parsed.len(), 2);
        assert!((parsed[0].0 - 0.742).abs() < 1e-9);
        assert!((parsed[0].1 - 5.568).abs() < 1e-9);
        assert_eq!(parsed[0].2, "开饭时间早上九点至下午五点");
        assert_eq!(parsed[1].2, "第二句");
    }

    /// ASS 时间用百分秒，且小时不补零、分秒补零。
    #[test]
    fn ass_time_formats_centiseconds() {
        assert_eq!(ass_time(0.0), "0:00:00.00");
        assert_eq!(ass_time(65_430.0), "0:01:05.43");
        assert_eq!(ass_time(3_661_000.0), "1:01:01.00");
    }

    /// 字幕轨只有文字也能写出 ASS 事件；区间外的字幕要被裁掉。
    #[test]
    fn write_ass_emits_only_overlapping_events() {
        let project = new_project("字幕");
        let mut sequence = project.sequences[0].clone();
        sequence.tracks.push(Track {
            id: "sub".into(),
            kind: TrackKind::Subtitle,
            index: 0,
            muted: false,
            solo: false,
            locked: false,
            hidden: false,
            height: 40.0,
            clips: vec![
                Clip {
                    id: "c1".into(),
                    asset_id: String::new(),
                    track_id: "sub".into(),
                    start_ms: 1000.0,
                    duration_ms: 1000.0,
                    in_ms: 0.0,
                    out_ms: 1000.0,
                    speed: 1.0,
                    reversed: false,
                    node_id: String::new(),
                    compound_id: None,
                    enable_3d: false,
                    transform_3d: None,
                    text: Some("第一句".into()),
                },
                Clip {
                    id: "c2".into(),
                    asset_id: String::new(),
                    track_id: "sub".into(),
                    start_ms: 9000.0,
                    duration_ms: 1000.0,
                    in_ms: 0.0,
                    out_ms: 1000.0,
                    speed: 1.0,
                    reversed: false,
                    node_id: String::new(),
                    compound_id: None,
                    enable_3d: false,
                    transform_3d: None,
                    text: Some("区间外".into()),
                },
            ],
        });

        let path = std::env::temp_dir().join(format!("{}.ass", new_id("test")));
        let written = write_ass(&sequence, 0.0, 5000.0, 1920, 1080, &path).unwrap();
        assert!(written, "有落在区间内的字幕就应当写文件");

        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("第一句"), "区间内的字幕要写进去");
        assert!(!body.contains("区间外"), "区间外的字幕不该出现");
        assert!(body.contains("Dialogue: 0,0:00:01.00,0:00:02.00,Reelix"), "时间要相对导出起点");

        std::fs::remove_file(&path).ok();
    }
}
