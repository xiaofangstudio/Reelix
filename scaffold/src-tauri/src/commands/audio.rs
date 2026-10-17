//! 音频命令：波形峰值 / 麦克风录音落盘 / 在资源管理器里显示文件。
//!
//! 波形：后端把素材解成 8kHz 单声道再压成峰值桶，前端只画条不解码。
//! 录音：浏览器侧 MediaRecorder 采集，字节交给这里转成标准 WAV，
//! 再走 `import_media` 全套逻辑进素材箱——录音和普通素材不分家。
//!
//! 波形的解码实现在 `crate::media::audio`（纯逻辑，可单测）。

use std::path::{Path, PathBuf};

use tauri::State;

use crate::commands::media::import_media;
use crate::media::audio::{decode_mono, peaks_from_pcm};
use crate::state::{lock, AppState};

/// 取一段素材的波形峰值，长度恒等于 `buckets`。
///
/// 只认音频与带音轨的视频；`in_ms` / `out_ms` 是素材内的时间窗
/// （与片段的入出点同一口径），变速片段传片段的 `speed`。
#[tauri::command(async)]
pub fn extract_waveform(
    asset_id: String,
    in_ms: f64,
    out_ms: f64,
    speed: Option<f64>,
    buckets: u32,
    state: State<'_, AppState>,
) -> Result<Vec<f32>, String> {
    let buckets = buckets.clamp(1, 4096) as usize;
    let asset_path = {
        let guard = lock(&state.project)?;
        let project = guard.as_ref().ok_or_else(|| "还没有打开项目".to_string())?;
        let asset = project
            .assets
            .iter()
            .find(|a| a.id == asset_id)
            .ok_or_else(|| "找不到该素材".to_string())?;
        asset.path.clone()
    };
    if !Path::new(&asset_path).exists() {
        return Err("素材文件丢失，请重新链接后再试".to_string());
    }

    let speed = speed.filter(|s| *s > 0.0).unwrap_or(1.0);
    let samples = decode_mono(Path::new(&asset_path), in_ms, out_ms, speed)?;
    Ok(peaks_from_pcm(&samples, buckets))
}

/// 把前端录的一段音频字节存盘并转成 WAV，按普通素材导入，返回素材。
///
/// MediaRecorder 在 WebView2 里给的是 webm/opus；ffmpeg 一条命令转
/// 48kHz 16 位 WAV，之后与手动导入的素材走完全同一条路。
#[tauri::command(async)]
pub fn save_recording(
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<crate::project::model::Asset, String> {
    if data.is_empty() {
        return Err("录音内容为空".to_string());
    }

    let cache_dir = PathBuf::from(lock(&state.settings)?.cache_dir.clone());
    let dir = cache_dir.join("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建录音目录失败：{e}"))?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let raw = dir.join(format!("录音-{stamp}.webm"));
    std::fs::write(&raw, &data).map_err(|e| format!("写入录音失败：{e}"))?;

    let wav = dir.join(format!("录音-{stamp}.wav"));
    convert_to_wav(&raw, &wav)?;
    let _ = std::fs::remove_file(&raw);

    let added = import_media(vec![wav.to_string_lossy().into_owned()], state)?;
    added
        .into_iter()
        .next_back()
        .ok_or_else(|| "录音导入失败".to_string())
}

/// webm/opus → WAV（48kHz 立体声 16 位），走 ffmpeg 独立进程。
fn convert_to_wav(input: &Path, output: &Path) -> Result<(), String> {
    let ffmpeg = crate::compositor::decode::locate_ffmpeg()
        .ok_or_else(|| "没找到 ffmpeg，无法转换录音".to_string())?;

    let mut command = std::process::Command::new(&ffmpeg);
    command.args(["-y", "-v", "error", "-i"]);
    command.arg(input.to_string_lossy().into_owned());
    command.args(["-ar", "48000", "-ac", "2"]);
    command.arg(output.to_string_lossy().into_owned());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let out = command
        .output()
        .map_err(|e| format!("调用 ffmpeg 失败：{e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr.lines().rev().take(2).collect::<Vec<_>>().join("；");
        return Err(format!("录音转码失败：{tail}"));
    }
    Ok(())
}

/// 在资源管理器里定位一个文件（导出完成后「打开所在文件夹」用）。
#[tauri::command]
pub fn reveal_path(path: String) -> Result<bool, String> {
    let path = Path::new(&path);
    if !path.exists() {
        return Err("文件不存在，可能已被移动或删除".to_string());
    }

    let mut command = std::process::Command::new("explorer");
    // `/select,` 后面不能有空格，逗号本身就是分隔符。
    command.arg(format!("/select,{}", path.to_string_lossy()));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map_err(|e| format!("打开资源管理器失败：{e}"))?;
    Ok(true)
}
