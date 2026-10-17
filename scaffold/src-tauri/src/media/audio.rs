//! 音频的纯逻辑：解 PCM、算波形峰值。
//!
//! 波形渲染的分工：这里把音频压成「每桶一个峰值」的小数组，
//! 前端拿到就能画条，不做任何解码。导出混音也用这里的解码函数。
//!
//! 这个模块不碰 tauri，`reelix-mcp` 与命令层共用同一份实现。

use std::path::Path;
use std::process::Command;

use crate::compositor::decode::locate_ffmpeg;

/// 导出混音用的采样率。AAC 与绝大多数素材都吃 48kHz。
pub const MIX_SAMPLE_RATE: u32 = 48_000;

/// 起 ffmpeg 不弹黑框的公共收尾。
fn spawn_quiet(command: &mut Command) -> Result<std::process::Output, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .output()
        .map_err(|e| format!("调用 ffmpeg 失败：{e}"))
}

/// 解一段音频成单声道 f32（8kHz），给波形峰值用。
///
/// 波形不需要保真：8kHz 单声道对画条绰绰有余，数据量小两个数量级。
/// `speed` 在 0.5 ~ 2 之间走 atempo 变速，范围外按原速解（波形只求形似）。
pub fn decode_mono(
    input: &Path,
    in_ms: f64,
    out_ms: f64,
    speed: f64,
) -> Result<Vec<f32>, String> {
    let ffmpeg = locate_ffmpeg().ok_or_else(|| "没找到 ffmpeg，无法读取音频".to_string())?;
    let start = (in_ms.max(0.0) / 1000.0).to_string();
    let dur = ((out_ms - in_ms).max(0.0) / 1000.0).to_string();

    let mut command = Command::new(&ffmpeg);
    command.args(["-v", "error", "-ss", &start, "-t", &dur, "-i"]);
    command.arg(input.to_string_lossy().into_owned());
    if (0.5..=2.0).contains(&speed) && (speed - 1.0).abs() > f64::EPSILON {
        command.args(["-filter:a", &format!("atempo={speed:.6}")]);
    }
    command.args([
        "-f",
        "f32le",
        "-ac",
        "1",
        "-ar",
        "8000",
        "-",
    ]);

    let output = spawn_quiet(&mut command)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(2).collect::<Vec<_>>().join("；");
        return Err(format!("音频解码失败：{tail}"));
    }
    Ok(f32_le_bytes(&output.stdout))
}

/// 解一段音频成立体声交织 f32（48kHz），给导出混音用。
///
/// 返回长度必为偶数（左右声道成对），调用方直接按帧下标落位混音。
pub fn decode_segment_stereo(
    input: &Path,
    in_ms: f64,
    duration_ms: f64,
    speed: f64,
) -> Result<Vec<f32>, String> {
    let ffmpeg = locate_ffmpeg().ok_or_else(|| "没找到 ffmpeg，无法读取音频".to_string())?;
    let start = (in_ms.max(0.0) / 1000.0).to_string();
    let dur = (duration_ms.max(0.0) / 1000.0).to_string();

    let mut command = Command::new(&ffmpeg);
    command.args(["-v", "error", "-ss", &start, "-t", &dur, "-i"]);
    command.arg(input.to_string_lossy().into_owned());
    if (0.5..=2.0).contains(&speed) && (speed - 1.0).abs() > f64::EPSILON {
        command.args(["-filter:a", &format!("atempo={speed:.6}")]);
    }
    command.args([
        "-f",
        "f32le",
        "-ac",
        "2",
        "-ar",
        &MIX_SAMPLE_RATE.to_string(),
        "-",
    ]);

    let output = spawn_quiet(&mut command)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(2).collect::<Vec<_>>().join("；");
        return Err(format!("音频解码失败：{tail}"));
    }
    Ok(f32_le_bytes(&output.stdout))
}

/// 小端字节流转 f32。长度不对齐时截掉尾巴。
fn f32_le_bytes(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// 把采样压成 `buckets` 个峰值，取每桶绝对值最大者。
///
/// 全静音或空输入返回全零数组；峰值夹到 0 ~ 1，超过 1 的视为过载照样压到 1。
pub fn peaks_from_pcm(samples: &[f32], buckets: usize) -> Vec<f32> {
    if buckets == 0 {
        return Vec::new();
    }
    if samples.is_empty() {
        return vec![0.0; buckets];
    }
    let mut peaks = vec![0.0f32; buckets];
    let per = samples.len() as f64 / buckets as f64;
    for (i, peak) in peaks.iter_mut().enumerate() {
        let from = (i as f64 * per).floor() as usize;
        let to = (((i + 1) as f64 * per).ceil() as usize).min(samples.len());
        let mut max = 0.0f32;
        for s in &samples[from..to.max(from + 1).min(samples.len())] {
            let a = s.abs();
            if a > max {
                max = a;
            }
        }
        *peak = max.min(1.0);
    }
    peaks
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 峰值取每桶最大绝对值：中间夹一个 0.8 的峰要被找到。
    #[test]
    fn peaks_capture_local_maxima() {
        let mut samples = vec![0.0f32; 1000];
        samples[500] = 0.8;
        samples[999] = -0.3;
        let peaks = peaks_from_pcm(&samples, 10);
        assert_eq!(peaks.len(), 10);
        assert!((peaks[5] - 0.8).abs() < 1e-6, "第 6 桶应有 0.8 的峰");
        assert!((peaks[9] - 0.3).abs() < 1e-6, "最后一桶应有 0.3 的峰");
        assert!(peaks[0] == 0.0, "静音桶必须是 0");
    }

    /// 桶数比采样还多时不能除零，也不能漏桶。
    #[test]
    fn peaks_handle_more_buckets_than_samples() {
        let peaks = peaks_from_pcm(&[0.5, -0.25], 4);
        assert_eq!(peaks.len(), 4);
        assert!(peaks.iter().any(|p| (*p - 0.5).abs() < 1e-6));
        assert!(peaks.iter().any(|p| (*p - 0.25).abs() < 1e-6));
    }

    /// 空输入给全零，不给 panic。
    #[test]
    fn peaks_of_empty_input_are_all_zero() {
        assert_eq!(peaks_from_pcm(&[], 8), vec![0.0; 8]);
        assert!(peaks_from_pcm(&[0.1], 0).is_empty());
    }

    /// 过载夹到 1，不能溢出。
    #[test]
    fn peaks_clamp_overload() {
        let peaks = peaks_from_pcm(&[4.0, -9.0], 1);
        assert_eq!(peaks[0], 1.0);
    }
}
