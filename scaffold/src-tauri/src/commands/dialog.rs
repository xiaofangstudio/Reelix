//! 系统文件对话框：选素材、选项目文件、选保存位置。
//!
//! 对话框只由用户主动动作触发，没有任何网络行为。
//! 放在 Rust 侧有两个理由：前端不必为此再引一个 npm 包，
//! 且路径从头到尾不经手 JS，界面拿到的永远是已经确定下来的绝对路径。

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// 素材选择器认得的扩展名。与 `kind_from_path` 的判定表保持一致。
const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "flv", "mxf", //
    "mp3", "wav", "aac", "flac", "m4a", "ogg", //
    "png", "jpg", "jpeg", "bmp", "tif", "tiff", "webp", "gif", //
    "exr", "dpx", "psd",
];

/// 弹出素材选择框，可多选。用户取消时返回空数组。
#[tauri::command]
pub async fn pick_media_files(app: AppHandle) -> Result<Vec<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("导入素材")
        .add_filter("媒体文件", MEDIA_EXTENSIONS)
        .add_filter("所有文件", &["*"])
        .blocking_pick_files();

    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

/// 弹出项目打开框。用户取消时返回 None。
#[tauri::command]
pub async fn pick_project_file(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("打开项目")
        .add_filter("Reelix 项目", &["reelix"])
        .blocking_pick_file();

    Ok(picked
        .and_then(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned()))
}

/// 弹出保存框，返回落盘路径。用户取消时返回 None。
#[tauri::command]
pub async fn pick_save_path(
    app: AppHandle,
    default_name: String,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("保存项目")
        .set_file_name(default_name)
        .add_filter("Reelix 项目", &["reelix"])
        .blocking_save_file();

    Ok(picked
        .and_then(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned()))
}
