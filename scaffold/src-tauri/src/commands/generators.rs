//! 生成器命令：白底 / 黑场 / 彩条与音调 / 颜色遮罩。
//!
//! FC 参考 的新建 ▸ 生成器一族（`file.newColorMatte` 等）在 Reelix 的落地方式：
//! 用 ffmpeg lavfi 真的生成一张 PNG 落到缓存目录，再作为图片素材进工程。
//! 这样预览 / 合成 / 导出管线天然支持（就是普通图片素材），不用给渲染链开后门。

use std::path::PathBuf;
use std::process::Command;

use tauri::State;

use crate::compositor::decode::locate_ffmpeg;
use crate::media::probe::probe_path;
use crate::project::model::{Asset, AssetKind};
use crate::project::serialize::new_id;
use crate::state::{lock, AppState};

/// 生成器种类 → (素材名, lavfi 源, 颜色)
fn generator_spec(kind: &str) -> Option<(&'static str, String, &'static str)> {
    match kind {
        "white" => Some(("白底", "color=c=white".to_string(), "white")),
        "black" => Some(("黑场", "color=c=black".to_string(), "black")),
        "bars" => Some(("彩条与音调", "smptebars".to_string(), "white")),
        // 颜色遮罩：#rrggbb
        other if other.starts_with('#') && other.len() == 7 => {
            Some(("颜色遮罩", format!("color=c={other}"), "white"))
        }
        _ => None,
    }
}

/// 新建一个生成器素材（白底 / 黑场 / 彩条 / 颜色遮罩），返回素材元数据。
/// 调用方拿到后再决定放到哪条轨、什么时刻。
#[tauri::command]
pub fn new_generator(
    kind: String,
    seconds: f64,
    state: State<'_, AppState>,
) -> Result<Asset, String> {
    let spec = generator_spec(&kind).ok_or_else(|| format!("不认识的生成器：{kind}"))?;
    let settings = lock(&state.settings)?;
    let cache_dir = PathBuf::from(&settings.cache_dir);
    drop(settings);

    // 生成器 PNG 放缓存目录下，同 kind 复用（白底永远长一样）
    let gen_dir = cache_dir.join("generators");
    std::fs::create_dir_all(&gen_dir).map_err(|e| format!("建缓存目录失败：{e}"))?;
    let safe_kind = kind.replace('#', "").replace(',', "_");
    let png_path = gen_dir.join(format!("{safe_kind}.png"));

    if !png_path.exists() {
        let ffmpeg =
            locate_ffmpeg().ok_or_else(|| "没找到 ffmpeg，无法生成素材".to_string())?;
        let mut command = Command::new(&ffmpeg);
        command.args([
            "-v".as_ref(),
            "error".as_ref(),
            "-f".as_ref(),
            "lavfi".as_ref(),
            "-i".as_ref(),
            spec.1.as_str(),
            "-frames:v".as_ref(),
            "1".as_ref(),
            "-y".as_ref(),
            png_path.to_string_lossy().as_ref(),
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
            return Err(format!("生成素材失败：{tail}"));
        }
    }

    // 走真实探测拿宽高帧率（png 也是合法媒体文件）
    let info = probe_path(&png_path.to_string_lossy());
    let width = info.width.max(1920);
    let height = info.height.max(1080);
    let name = if kind.starts_with('#') {
        format!("颜色遮罩 {}", kind)
    } else {
        spec.0.to_string()
    };

    Ok(Asset {
        id: new_id("asset"),
        path: png_path.to_string_lossy().into_owned(),
        name,
        kind: AssetKind::Image,
        duration_ms: (seconds.max(0.5) * 1000.0).min(600_000.0),
        width,
        height,
        frame_rate: info.frame_rate,
        codec: "png".to_string(),
        has_audio: false,
        missing: false,
        bin_id: None,
    })
}

/// 生成器素材的默认时长（秒）——图片素材在时间线上随拉随长
pub fn default_seconds(kind: &str) -> f64 {
    match kind {
        "bars" => 10.0,
        _ => 3.0,
    }
}

/// 默认媒体库的系统目录（唯一增删入口：用户手动往里放/删文件，界面不上传）。
/// 位置：`%LOCALAPPDATA%\Reelix\default\<kind>\`，kind ∈ audio / music / stills / transitions。
#[tauri::command]
pub fn default_media_dir(kind: String) -> Result<String, String> {
    let base = default_base_dir().ok_or("定位不到本机数据目录")?;
    let dir = base.join(&kind);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 列出系统默认媒体目录里的文件（界面只读列；不支持界面上传，用户自行放文件）。
#[tauri::command]
pub fn list_default_media(kind: String) -> Result<Vec<(String, String)>, String> {
    let base = default_base_dir().ok_or("定位不到本机数据目录")?;
    let dir = base.join(&kind);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("读取目录失败：{e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !matches!(
            ext.as_str(),
            "mp3" | "wav" | "aac" | "m4a" | "ogg" | "flac" | "png" | "jpg" | "jpeg" | "webp" | "mp4" | "mov"
        ) {
            continue;
        }
        let name = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "未命名".to_string());
        out.push((name, path.to_string_lossy().into_owned()));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// 本机数据根目录：`%LOCALAPPDATA%\Reelix\default`（Windows）。
fn default_base_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(std::path::PathBuf::from))?;
    Some(base.join("Reelix").join("default"))
}
