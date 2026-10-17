//! 素材探测：读文件的真实元数据（时长 / 画幅 / 帧率 / 编码 / 有无音轨）。
//!
//! 探测走 ffprobe：先看随包目录（可执行文件同级的 `ffmpeg/ffprobe.exe`），
//! 再退回系统 PATH。两条路都找不到时，只按扩展名给一份保守的元数据——
//! 界面照常能用、不会崩，只是时长分辨率显示为 0。
//!
//! 这个模块**只放纯逻辑**：不碰 tauri、不碰全局状态。命令层与 `reelix-mcp`
//! 共用同一份实现，探测口径不会两处各写一套。

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::project::model::AssetKind;

/// 只探测不导入时返回的素材信息，与 `src/services/media.ts` 的 `MediaInfo` 对齐。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub kind: AssetKind,
    pub duration_ms: f64,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    pub codec: String,
    pub has_audio: bool,
}

/// 按扩展名判断素材类型，认不出时按视频处理。
pub fn kind_from_path(path: &str) -> AssetKind {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp3" | "wav" | "aac" | "flac" | "m4a" | "ogg" => AssetKind::Audio,
        "png" | "jpg" | "jpeg" | "bmp" | "tif" | "tiff" | "webp" | "gif" => AssetKind::Image,
        "exr" | "dpx" => AssetKind::ImageSequence,
        _ => AssetKind::Video,
    }
}

/// 这种素材默认是否带音轨（探不到真数据时的保守估计）。
pub fn has_audio_for(kind: AssetKind) -> bool {
    matches!(kind, AssetKind::Video | AssetKind::Audio)
}

/// 随包目录里的 ffprobe：可执行文件同级，或同级的 `ffmpeg/` 子目录，
/// 以及开发期 `target/debug` 往上的仓库 `src-tauri/ffmpeg/`。
pub fn bundled_ffprobe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidates = [
        dir.join("ffprobe.exe"),
        dir.join("ffmpeg").join("ffprobe.exe"),
        dir.join("..").join("..").join("ffmpeg").join("ffprobe.exe"),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

/// 系统 PATH 里的 ffprobe。
pub fn path_ffprobe() -> Option<PathBuf> {
    let raw = std::env::var_os("PATH")?;
    std::env::split_paths(&raw)
        .map(|dir| dir.join("ffprobe.exe"))
        .find(|path| path.is_file())
}

/// 定位 ffprobe：随包目录优先，找不到再扫 PATH。
pub fn find_ffprobe() -> Option<PathBuf> {
    bundled_ffprobe().or_else(path_ffprobe)
}

/// 解析 ffprobe 输出的 `25/1` 这类分式帧率。
pub fn parse_ratio(raw: &str) -> Option<f64> {
    let (num, den) = raw.split_once('/')?;
    let num: f64 = num.trim().parse().ok()?;
    let den: f64 = den.trim().parse().ok()?;
    if den == 0.0 {
        return None;
    }
    Some(num / den)
}

/// 编解码器名转成界面上好读的写法。
pub fn display_codec(raw: &str) -> String {
    match raw {
        "" => String::new(),
        "h264" => "H.264".into(),
        "hevc" => "H.265".into(),
        "prores" => "ProRes".into(),
        "dnxhd" => "DNxHD".into(),
        "vp9" => "VP9".into(),
        "av1" => "AV1".into(),
        "aac" => "AAC".into(),
        "mp3" => "MP3".into(),
        "flac" => "FLAC".into(),
        "pcm_s16le" | "pcm_s24le" | "pcm_f32le" => "PCM".into(),
        other => other.to_ascii_uppercase(),
    }
}

/// 取流的类型（`video` / `audio` …），缺失时给空串。
pub fn stream_type(value: &serde_json::Value) -> &str {
    value
        .get("codec_type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
}

/// 用 ffprobe 读真实元数据。任何一步失败都返回 None，由调用方回落到保守值。
pub fn probe_with_ffprobe(ffprobe: &Path, path: &str) -> Option<MediaInfo> {
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;

    let seconds_from = |value: Option<&serde_json::Value>| -> Option<f64> {
        value
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|secs| *secs >= 0.0)
    };

    let duration_ms = seconds_from(json.get("format").and_then(|f| f.get("duration")))
        .or_else(|| {
            json.get("streams")
                .and_then(|s| s.as_array())
                .and_then(|arr| arr.iter().find_map(|st| seconds_from(st.get("duration"))))
        })
        .map_or(0.0, |secs| secs * 1000.0);

    let streams = json.get("streams").and_then(|s| s.as_array());
    let video = streams.and_then(|arr| arr.iter().find(|s| stream_type(s) == "video"));
    let audio = streams.and_then(|arr| arr.iter().find(|s| stream_type(s) == "audio"));

    let width = video
        .and_then(|v| v.get("width"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let height = video
        .and_then(|v| v.get("height"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let frame_rate = video
        .and_then(|v| v.get("avg_frame_rate"))
        .and_then(|v| v.as_str())
        .and_then(parse_ratio)
        .unwrap_or(0.0);
    let codec = video
        .or(audio)
        .and_then(|s| s.get("codec_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    Some(MediaInfo {
        path: path.to_string(),
        kind: kind_from_path(path),
        duration_ms,
        width,
        height,
        frame_rate,
        codec: display_codec(codec),
        has_audio: audio.is_some(),
    })
}

/// 由路径造一份素材元数据。真机上有 ffprobe 就用真数据，否则按扩展名保守填。
pub fn probe_path(path: &str) -> MediaInfo {
    let kind = kind_from_path(path);
    let fallback = MediaInfo {
        path: path.to_string(),
        kind,
        duration_ms: 0.0,
        width: 0,
        height: 0,
        frame_rate: 0.0,
        codec: String::new(),
        has_audio: has_audio_for(kind),
    };

    if !Path::new(path).is_file() {
        return fallback;
    }
    match find_ffprobe().and_then(|probe| probe_with_ffprobe(&probe, path)) {
        Some(info) => info,
        None => fallback,
    }
}

/// 从路径里取文件名，取不到就原样返回。
pub fn file_name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_follows_extension() {
        assert_eq!(kind_from_path("a/b/song.MP3"), AssetKind::Audio);
        assert_eq!(kind_from_path("shot.png"), AssetKind::Image);
        assert_eq!(kind_from_path("plate.exr"), AssetKind::ImageSequence);
        assert_eq!(kind_from_path("take.mov"), AssetKind::Video);
        assert_eq!(kind_from_path("noext"), AssetKind::Video, "认不出按视频处理");
    }

    #[test]
    fn ratio_parses_and_rejects_zero_denominator() {
        assert_eq!(parse_ratio("25/1"), Some(25.0));
        assert_eq!(parse_ratio("30000/1001"), Some(30000.0 / 1001.0));
        assert_eq!(parse_ratio("25"), None, "没有分式应当解析失败");
        assert_eq!(parse_ratio("25/0"), None, "分母为零应当拒绝");
    }

    #[test]
    fn codec_names_are_readable() {
        assert_eq!(display_codec("h264"), "H.264");
        assert_eq!(display_codec("hevc"), "H.265");
        assert_eq!(display_codec("pcm_s16le"), "PCM");
        assert_eq!(display_codec(""), "");
        assert_eq!(display_codec("xyz"), "XYZ", "陌生编码统一大写");
    }

    #[test]
    fn file_name_falls_back_to_input() {
        assert_eq!(file_name_of("C:/clips/镜一号.mp4"), "镜一号.mp4");
        assert_eq!(file_name_of(""), "");
    }

    /// 路径不存在时不能 panic，也不能去起 ffprobe。
    #[test]
    fn missing_file_gives_conservative_fallback() {
        let info = probe_path("C:/definitely/not/here.mp4");
        assert_eq!(info.kind, AssetKind::Video);
        assert_eq!(info.duration_ms, 0.0);
        assert_eq!(info.width, 0);
        assert!(info.has_audio, "视频默认保守估计为带音轨");
    }

    /// 音频不该被估成带视频画幅。
    #[test]
    fn audio_kind_has_audio_but_no_size() {
        let info = probe_path("C:/definitely/not/here.wav");
        assert_eq!(info.kind, AssetKind::Audio);
        assert!(info.has_audio);
        assert_eq!(info.width, 0);
    }
}
