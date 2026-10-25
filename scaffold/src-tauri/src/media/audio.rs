//! 音频的纯逻辑：解 PCM、算波形峰值。
//!
//! 波形渲染的分工：这里把音频压成「每桶一个峰值」的小数组，
//! 前端拿到就能画条，不做任何解码。导出混音也用这里的解码函数。
//!
//! 这个模块不碰 tauri，`reelix-mcp` 与命令层共用同一份实现。

use std::path::Path;
use std::process::Command;

use crate::compositor::decode::locate_ffmpeg;
use crate::timeline::model::Clip;

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

/// 把任意倍速拆成 atempo 过滤器链（单个 atempo 只吃 0.5 ~ 2，链式可叠）。
///
/// 0.01× ~ 100× 全覆盖；返回 None 表示不需要过滤（原速）。
/// atempo 是 WSOLA 时域拉伸：只改速度不改音高，这就是「变速不变调」。
fn atempo_chain(speed: f64) -> Option<String> {
    // 非有限 / 非正 / 原速：不过滤（0 速是非法输入，调用方已兜成 1）
    if !speed.is_finite() || speed <= 0.0 || (speed - 1.0).abs() < 1e-6 {
        return None;
    }
    let mut factor = speed.clamp(0.01, 100.0);
    let mut parts: Vec<String> = Vec::new();
    // 大速度逐段除 2，小速度逐段除 0.5，余数进最后一段
    while factor > 2.0 {
        parts.push("atempo=2.0".to_string());
        factor /= 2.0;
    }
    while factor < 0.5 {
        parts.push("atempo=0.5".to_string());
        factor /= 0.5;
    }
    if (factor - 1.0).abs() > 1e-6 {
        parts.push(format!("atempo={factor:.6}"));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

/// 「声音变调」模式的过滤器：按倍速重采样，音高随速度一起变（剪映同款）。
///
/// 原理是黑胶模型：以 `sr × speed` 的速率送样、再采回 `sr`，
/// 速度与音高同向变化（加速变尖、减速变沉）。
fn pitch_shift_filter(speed: f64) -> Option<String> {
    if !speed.is_finite() || speed <= 0.0 || (speed - 1.0).abs() < 1e-6 {
        return None;
    }
    let rate = (MIX_SAMPLE_RATE as f64 * speed.clamp(0.01, 100.0)).round() as u32;
    Some(format!("asetrate={rate},aresample={MIX_SAMPLE_RATE}"))
}

/// 按「变速设置」选过滤器：变调开 → 重采样；变调关 → atempo 保调。
fn speed_filter(speed: f64, pitch_shift: bool) -> Option<String> {
    if pitch_shift {
        pitch_shift_filter(speed)
    } else {
        atempo_chain(speed)
    }
}

/// 解一段音频成单声道 f32（8kHz），给波形峰值用。
///
/// 波形不需要保真：8kHz 单声道对画条绰绰有余，数据量小两个数量级。
/// 变速走 atempo 链（0.01× ~ 100× 都支持，且不改音高——波形只求形似，
/// 但长度必须对，否则片段上的波形会和声音对不上）。
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
    if let Some(filter) = atempo_chain(speed) {
        command.args(["-filter:a", &filter]);
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
/// `pitch_shift` = 声音变调（剪映同款）：开 → 音高随速度变；关 → atempo 保调。
pub fn decode_segment_stereo(
    input: &Path,
    in_ms: f64,
    duration_ms: f64,
    speed: f64,
    pitch_shift: bool,
) -> Result<Vec<f32>, String> {
    let ffmpeg = locate_ffmpeg().ok_or_else(|| "没找到 ffmpeg，无法读取音频".to_string())?;
    let start = (in_ms.max(0.0) / 1000.0).to_string();
    let dur = (duration_ms.max(0.0) / 1000.0).to_string();

    let mut command = Command::new(&ffmpeg);
    command.args(["-v", "error", "-ss", &start, "-t", &dur, "-i"]);
    command.arg(input.to_string_lossy().into_owned());
    if let Some(filter) = speed_filter(speed, pitch_shift) {
        command.args(["-filter:a", &filter]);
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

/// 曲线变速：解 `[from_local, to_local]`（片段内时刻）覆盖的音频。
///
/// 输出长度 = 区间时长（时间线上占多少就出多少），源区间按曲线积分算。
/// - 变调开：黑胶模型，按 σ(t) 逐样本重采样，音高随瞬时速度变；
/// - 变调关：按曲线拐点切段，每段用 atempo 以段内均速拉伸，段内音高不变，
///   时长按积分精确对齐（线性斜坡的均速 = 两端均值，积分无近似）。
pub fn decode_segment_stereo_curved(
    input: &Path,
    clip: &Clip,
    from_local_ms: f64,
    to_local_ms: f64,
) -> Result<Vec<f32>, String> {
    let from = from_local_ms.max(0.0);
    let to = to_local_ms.max(from);
    if to <= from {
        return Ok(Vec::new());
    }

    if !clip.audio_pitch_shift {
        return decode_curved_pitch_preserved(input, clip, from, to);
    }
    decode_curved_pitch_shifted(input, clip, from, to)
}

/// 变调模式：整段按 1× 解出，再按曲线积分逐样本重采样。
fn decode_curved_pitch_shifted(
    input: &Path,
    clip: &Clip,
    from: f64,
    to: f64,
) -> Result<Vec<f32>, String> {
    // 源区间：正放 [in+F(from), in+F(to)]；倒放镜像到 [out-F(to), out-F(from)]
    let f_from = clip.source_offset(from);
    let f_to = clip.source_offset(to);
    let (src_lo, src_hi) = if clip.reversed {
        (clip.out_ms - f_to, clip.out_ms - f_from)
    } else {
        (clip.in_ms + f_from, clip.in_ms + f_to)
    };
    let src = decode_segment_stereo(input, src_lo, (src_hi - src_lo).max(0.0), 1.0, false)?;
    if src.len() < 4 {
        return Ok(Vec::new());
    }

    let sr = MIX_SAMPLE_RATE as f64;
    let out_frames = ((to - from) / 1000.0 * sr).round() as usize;
    let src_frames = src.len() / 2;
    let mut out = Vec::with_capacity(out_frames * 2);
    for j in 0..out_frames {
        let local = from + j as f64 * 1000.0 / sr;
        let f = clip.source_offset(local);
        let src_ms = if clip.reversed {
            clip.out_ms - f
        } else {
            clip.in_ms + f
        };
        let pos = ((src_ms - src_lo) / 1000.0 * sr).clamp(0.0, (src_frames - 1) as f64);
        let i0 = pos.floor() as usize;
        let i1 = (i0 + 1).min(src_frames - 1);
        let frac = (pos - i0 as f64) as f32;
        for ch in 0..2 {
            let a = src[i0 * 2 + ch];
            let b = src[i1 * 2 + ch];
            out.push(a + (b - a) * frac);
        }
    }
    Ok(out)
}

/// 保调模式：按曲线拐点切段（长段再细分），每段 atempo 到段内均速后拼接。
fn decode_curved_pitch_preserved(
    input: &Path,
    clip: &Clip,
    from: f64,
    to: f64,
) -> Result<Vec<f32>, String> {
    // 切点：曲线拐点落在区间内的 + 区间两端；超过 250ms 的段再等分，
    // 让线性斜坡的音高阶梯足够细（时长仍按积分精确，不会漂移）。
    let mut cuts: Vec<f64> = vec![from];
    if let Some(keys) = clip.speed_curve.as_ref() {
        for k in keys {
            let t = k.t_ms;
            if t > from && t < to {
                cuts.push(t);
            }
        }
    }
    cuts.push(to);
    let mut pieces: Vec<(f64, f64)> = Vec::new();
    for pair in cuts.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let span = b - a;
        if span <= 1e-6 {
            continue;
        }
        let steps = (span / 250.0).ceil().max(1.0) as usize;
        for s in 0..steps {
            let pa = a + span * s as f64 / steps as f64;
            let pb = a + span * (s + 1) as f64 / steps as f64;
            pieces.push((pa, pb));
        }
    }

    let sr = MIX_SAMPLE_RATE as f64;
    let mut out: Vec<f32> = Vec::new();
    for (pa, pb) in pieces {
        // 段内均速：源长 ÷ 时长。线性斜坡两端均值即精确均速
        let f0 = clip.source_offset(pa);
        let f1 = clip.source_offset(pb);
        let avg = if pb - pa > 1e-9 {
            ((f1 - f0) / (pb - pa)).max(0.01)
        } else {
            clip.speed_at(pa)
        };
        let (src_lo, src_hi) = if clip.reversed {
            (clip.out_ms - f1, clip.out_ms - f0)
        } else {
            (clip.in_ms + f0, clip.in_ms + f1)
        };
        // atempo=avg 后输出时长 = 源长 ÷ avg = 段时长，时序严格对齐
        let pcm = decode_segment_stereo(input, src_lo, (src_hi - src_lo).max(0.0), avg, false)?;
        let want = ((pb - pa) / 1000.0 * sr).round() as usize * 2;
        out.extend(pcm.into_iter().take(want));
    }
    Ok(out)
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

    /// atempo 链：0.5 ~ 2 单段，超出就叠段；原速不过滤。
    #[test]
    fn atempo_chain_covers_full_speed_range() {
        assert!(atempo_chain(1.0).is_none(), "原速不需要过滤");
        assert_eq!(atempo_chain(2.0).as_deref(), Some("atempo=2.000000"));
        assert_eq!(atempo_chain(0.5).as_deref(), Some("atempo=0.500000"));
        // 4× = 两段 2×；0.25× = 两段 0.5×；3× = 2× 再 1.5×
        assert_eq!(atempo_chain(4.0).as_deref(), Some("atempo=2.0,atempo=2.000000"));
        assert_eq!(atempo_chain(0.25).as_deref(), Some("atempo=0.5,atempo=0.500000"));
        assert_eq!(atempo_chain(3.0).as_deref(), Some("atempo=2.0,atempo=1.500000"));
        // 0.1×（滑条最小值）也要能拆：三段 0.5× 再 0.8×
        assert_eq!(atempo_chain(0.1).as_deref(), Some("atempo=0.5,atempo=0.5,atempo=0.5,atempo=0.800000"));
        // 非法值不过滤
        assert!(atempo_chain(0.0).is_none());
        assert!(atempo_chain(f64::NAN).is_none());
    }

    /// 变调过滤器按倍速重采样：4× → 192kHz 送样采回 48kHz。
    #[test]
    fn pitch_shift_filter_resamples_by_speed() {
        assert!(pitch_shift_filter(1.0).is_none(), "原速不需要过滤");
        assert_eq!(
            pitch_shift_filter(4.0).as_deref(),
            Some("asetrate=192000,aresample=48000")
        );
        assert_eq!(
            pitch_shift_filter(0.5).as_deref(),
            Some("asetrate=24000,aresample=48000")
        );
    }

    /// 过滤器选择：变调开走重采样，关走 atempo。
    #[test]
    fn speed_filter_switches_by_pitch_shift() {
        assert_eq!(speed_filter(2.0, false).as_deref(), Some("atempo=2.000000"));
        assert_eq!(
            speed_filter(2.0, true).as_deref(),
            Some("asetrate=96000,aresample=48000")
        );
    }
}
