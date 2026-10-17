//! 取一帧真像素：调用 ffmpeg 解出原始 RGBA 缓冲。
//!
//! 为什么走独立进程：FFmpeg 是 LGPL-2.1，仓库红线要求**只动态调用、不并入**，
//! 所以这里只用 `Command` 起一个 sidecar 进程，崩溃或缺失都不传染主程序
//! （见 `docs/06-参考项目与许可边界.md`）。
//!
//! 输出固定为 `-f rawvideo -pix_fmt rgba`，字节数必然等于 `宽 × 高 × 4`，
//! 拿到就能直接灌进 [`crate::graph::Frame`]，中间不落中间文件。

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::graph::Frame;

/// ffmpeg 可执行文件名。Windows 带 `.exe` 后缀。
#[cfg(windows)]
const FFMPEG: &str = "ffmpeg.exe";
#[cfg(not(windows))]
const FFMPEG: &str = "ffmpeg";

/// 找一个可执行文件：先看随包目录，再扫 PATH。
///
/// 随包候选顺序与 `commands/media.rs` 里找 ffprobe 的规则保持一致：
/// 1. 可执行文件同目录；
/// 2. 同目录下的 `ffmpeg/` 子目录（安装包会把 resources 放到这里）；
/// 3. 源码树里 `src-tauri/ffmpeg/`（开发期直接跑 `cargo tauri dev` 的情形）。
pub fn locate(tool: &str) -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidates = [
                dir.join(tool),
                dir.join("ffmpeg").join(tool),
                dir.join("..").join("..").join("ffmpeg").join(tool),
            ];
            if let Some(found) = candidates.into_iter().find(|p| p.is_file()) {
                return Some(found);
            }
        }
    }
    let raw = std::env::var_os("PATH")?;
    std::env::split_paths(&raw)
        .map(|dir| dir.join(tool))
        .find(|p| p.is_file())
}

/// 找 ffmpeg。找不到返回 `None`，由 [`decode_frame`] 转成中文错误交给上层提示。
pub fn locate_ffmpeg() -> Option<PathBuf> {
    locate(FFMPEG)
}

/// 拼解码一帧的命令行参数。
///
/// `-ss` 放在 `-i` 之前是**关键帧快速定位**：只解到最近的关键帧再往后找，
/// 比放到后面（逐帧解码到目标点）快一个数量级。预览允许画质与绝对精确帧让位，
/// 导出时才需要逐帧精确（走另一条管线）。
/// `scale + pad` 保证输出严格是目标画幅：等比缩放进画面内，四周补黑，不拉伸变形。
pub fn decode_args(input: &Path, at_ms: f64, width: usize, height: usize) -> Vec<String> {
    let seconds = (at_ms.max(0.0)) / 1000.0;
    let filter = format!(
        "scale={width}:{height}:force_original_aspect_ratio=decrease,\
         pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black"
    );
    vec![
        "-v".into(),
        "error".into(),
        "-ss".into(),
        format!("{seconds:.3}"),
        "-i".into(),
        input.to_string_lossy().into_owned(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        filter,
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        "rgba".into(),
        "-".into(),
    ]
}

/// 解一帧，返回浮点 RGBA 帧。
pub fn decode_frame(input: &Path, at_ms: f64, width: usize, height: usize) -> Result<Frame, String> {
    let ffmpeg = locate_ffmpeg().ok_or_else(|| "没找到 ffmpeg，无法解码画面".to_string())?;
    let args = decode_args(input, at_ms, width, height);

    let mut command = Command::new(&ffmpeg);
    command.args(&args);
    // Windows 上别弹出黑框闪一下。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
        .output()
        .map_err(|e| format!("调用 ffmpeg 失败：{e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(3).collect::<Vec<_>>().join("；");
        let tail = if tail.is_empty() { "无更多信息".to_string() } else { tail };
        return Err(format!("ffmpeg 解码失败：{tail}"));
    }

    let expected = width * height * 4;
    if output.stdout.len() < expected {
        return Err("该时间点取不到画面".to_string());
    }

    let mut pixels = Vec::with_capacity(expected);
    for byte in &output.stdout[..expected] {
        pixels.push(*byte as f32 / 255.0);
    }
    Ok(Frame {
        width,
        height,
        pixels,
    })
}

/// 抽一帧存成 PNG 字节，给素材箱缩略图用。
///
/// 与 [`decode_frame`] 的差别：这里让 ffmpeg 直接编 PNG 回标准输出，
/// 不经过浮点帧，省一次像素搬运；长边收到 `max_side`，等比缩放不补边——
/// 缩略图本来就显示在等比框里，补黑边是浪费。
pub fn extract_frame_png(input: &Path, at_ms: f64, max_side: u32) -> Result<Vec<u8>, String> {
    let ffmpeg = locate_ffmpeg().ok_or_else(|| "没找到 ffmpeg，无法生成缩略图".to_string())?;
    let seconds = at_ms.max(0.0) / 1000.0;

    let mut command = Command::new(&ffmpeg);
    command.args([
        "-v".to_string(),
        "error".to_string(),
        "-ss".to_string(),
        format!("{seconds:.3}"),
        "-i".to_string(),
        input.to_string_lossy().into_owned(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-vf".to_string(),
        format!("scale={max_side}:{max_side}:force_original_aspect_ratio=decrease"),
        "-f".to_string(),
        "image2".to_string(),
        "-vcodec".to_string(),
        "png".to_string(),
        "-".to_string(),
    ]);
    // Windows 上别弹出黑框闪一下。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
        .output()
        .map_err(|e| format!("调用 ffmpeg 失败：{e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(2).collect::<Vec<_>>().join("；");
        return Err(format!("缩略图抽帧失败：{tail}"));
    }
    if output.stdout.is_empty() {
        return Err("该时间点取不到画面".to_string());
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(input: &str, at_ms: f64, w: usize, h: usize) -> Vec<String> {
        decode_args(Path::new(input), at_ms, w, h)
    }

    /// 定位参数必须在 `-i` 之前，否则每帧都要从头逐帧解，预览必然卡。
    #[test]
    fn seek_comes_before_input_for_fast_seek() {
        let a = args("C:/片子.mp4", 2500.0, 960, 540);
        let ss = a.iter().position(|s| s == "-ss").expect("必须带 -ss");
        let i = a.iter().position(|s| s == "-i").expect("必须带 -i");
        assert!(ss < i, "-ss 必须在 -i 之前才是关键帧快速定位");
        assert_eq!(a[ss + 1], "2.500", "毫秒要换算成秒");
    }

    /// 只取一帧、且必须是原始 RGBA，长度才等于 宽×高×4。
    #[test]
    fn requests_single_raw_rgba_frame_on_stdout() {
        let a = args("C:/片子.mp4", 0.0, 1280, 720);
        let frames = a.iter().position(|s| s == "-frames:v").unwrap();
        assert_eq!(a[frames + 1], "1", "只解一帧");
        let pix = a.iter().position(|s| s == "-pix_fmt").unwrap();
        assert_eq!(a[pix + 1], "rgba");
        assert!(a.contains(&"rawvideo".to_string()), "原始裸流");
        assert_eq!(a.last().unwrap(), "-", "输出到标准输出");
    }

    /// 画幅必须严格等于目标尺寸：等比缩放进画面内再补黑，不能拉伸变形。
    #[test]
    fn filter_scales_inside_and_pads_to_exact_size() {
        let a = args("C:/片子.mp4", 0.0, 960, 540);
        let vf = a.iter().position(|s| s == "-vf").unwrap();
        let filter = &a[vf + 1];
        assert!(filter.contains("scale=960:540"), "缩放目标要对：{filter}");
        assert!(filter.contains("force_original_aspect_ratio=decrease"), "等比缩放到画面内");
        assert!(filter.contains("pad=960:540"), "补到精确画幅");
        assert!(filter.contains("color=black"), "补边用黑色");
    }

    /// 负时间夹到 0，避免 ffmpeg 收到怪值。
    #[test]
    fn negative_time_is_clamped() {
        let a = args("C:/片子.mp4", -500.0, 64, 64);
        let ss = a.iter().position(|s| s == "-ss").unwrap();
        assert_eq!(a[ss + 1], "0.000");
    }
}
