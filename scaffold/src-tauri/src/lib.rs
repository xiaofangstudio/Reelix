//! Reelix 后端入口。
//!
//! 职责边界：所有重活（解码、合成、导出、文件读写）都在这一侧；
//! 前端只通过 `commands` 里的命令与这里交互，拿到的永远是算好的结果。
//!
//! 模块划分见 `docs/03-技术架构.md` 第三节。
//!
//! 本库有两种用法：
//! - **桌面外壳**（默认 feature `desktop`）：`commands` + [`run`] 走 tauri。
//! - **纯逻辑**（`default-features = false`）：只导出 `project / timeline / graph /
//!   keyframe / compositor / history / storage / media` 这些不依赖 tauri 的模块，
//!   供 `reelix-mcp` 复用，避免把 webview2 的 C++ 符号拖进命令行进程。

#[cfg(feature = "desktop")]
pub mod commands;
pub mod compositor;
pub mod graph;
pub mod history;
pub mod keyframe;
pub mod media;
pub mod project;
pub mod state;
pub mod storage;
pub mod timeline;
pub mod tracking;
pub mod gpu;
pub mod expr;

/// 端到端验真（只在 cargo test 下编译）：拿真实素材证明链路走得通。
#[cfg(test)]
mod e2e;

#[cfg(feature = "desktop")]
use state::AppState;

/// 启动 Tauri：装配全局状态、注册系统对话框插件、挂上全部命令。
#[cfg(feature = "desktop")]

pub fn run() {
    // —— 无窗口导出模式 —— //
    // MCP / 脚本用这条路径导出成片：
    //   reelix.exe --export --project <工程> --out <mp4> [--preset id] [--start ms] [--end ms]
    // 它不创建窗口、不起事件循环，跑完直接按退出码退出。
    // 渲染走的是与界面导出同一份 export_sync，画质完全一致。
    {
        let argv: Vec<String> = std::env::args().collect();
        if argv.get(1).map(|s| s.as_str()) == Some("--export") {
            std::process::exit(commands::export::run_export_cli(&argv));
        }
    }

    tauri::Builder::default()
        // 只在用户主动保存/打开项目时弹系统对话框，没有网络行为。
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            // 双击 .reelix 打开
            commands::project::pending_open_path,
            // 项目
            commands::project::new_project,
            commands::project::open_project,
            commands::project::save_project,
            commands::project::get_project,
            commands::project::get_project_path,
            commands::project::project_is_dirty,
            commands::project::adapt_sequence_to_asset,
            commands::media::make_proxy,
            commands::project::close_project,
            // 系统文件对话框
            commands::dialog::pick_media_files,
            commands::dialog::pick_project_file,
            commands::dialog::pick_save_path,
            // 素材
            commands::media::import_media,
            commands::media::probe_media,
            commands::media::relink_media,
            commands::media::remove_media,
            commands::media::generate_thumbnail,
            commands::generators::new_generator,
            commands::generators::default_media_dir,
            commands::interop::import_dropbox,
            commands::interop::dropbox_path,
            commands::project::home_dir,
            crate::expr::eval_expr,
            commands::project::write_text_file,
            commands::generators::list_default_media,
            // 音频：波形 / 录音 / 资源管理器定位
            commands::audio::extract_waveform,
            commands::audio::save_recording,
            commands::audio::reveal_path,
            // 时间线
            commands::timeline::add_clip,
            commands::timeline::move_clip,
            commands::timeline::trim_clip,
            commands::timeline::split_clip,
            commands::timeline::delete_clips,
            commands::timeline::set_clip_speed,
            commands::timeline::set_clip_speed_curve,
            commands::timeline::set_clip_pitch_shift,
            commands::timeline::set_clip_flags,
            commands::timeline::set_clip_transform_3d,
            commands::timeline::unlink_compound,
            commands::timeline::add_track,
            commands::timeline::remove_track,
            commands::timeline::set_track_flags,
            // 时间线：转场 / 音频淡入淡出 / 标记 / 素材箱
            commands::timeline::set_transition,
            commands::timeline::set_clip_transition_out,
            commands::timeline::set_audio_dsp,
            commands::timeline::set_clip_reversed,
            commands::timeline::set_audio_fade,
            commands::timeline::add_marker,
            commands::timeline::remove_marker,
            commands::timeline::move_marker,
            commands::timeline::create_bin,
            commands::timeline::rename_bin,
            commands::timeline::remove_bin,
            commands::timeline::set_asset_bin,
            // 字幕：本地离线识别 / 字幕轨 / 文字编辑
            commands::subtitle::asr_status,
            commands::subtitle::generate_subtitles,
            commands::subtitle::apply_subtitles,
            commands::subtitle::add_subtitle_clip,
            commands::subtitle::set_clip_text,
            // 空间识别：COLMAP sidecar 解算 / 取消 / 能力探测
            commands::reconstruct::colmap_status,
            commands::reconstruct::start_reconstruct,
            commands::reconstruct::cancel_reconstruct,
            // 图
            commands::graph::add_node,
            commands::graph::remove_node,
            commands::graph::connect,
            commands::graph::disconnect,
            commands::graph::set_node_param,
            commands::graph::collapse_compound,
            commands::graph::enter_compound,
            commands::graph::get_node_catalog,
            commands::graph::evaluate_graph,
            // 关键帧
            commands::keyframe::set_keyframe,
            commands::keyframe::remove_keyframe,
            commands::keyframe::move_keyframe,
            commands::keyframe::set_curve_tangent,
            commands::keyframe::set_easing_preset,
            commands::keyframe::evaluate_param,
            // 渲染
            commands::render::request_frame,
            commands::render::start_preview,
            commands::render::stop_preview,
            commands::render::set_preview_quality,
            commands::render::invalidate_node,
            commands::render::get_cache_stats,
            commands::render::clear_cache,
            // 导出
            commands::export::start_export,
            commands::export::cancel_export,
            commands::export::pause_export,
            commands::export::resume_export,
            commands::export::list_export_presets,
            commands::export::export_capabilities,
            commands::export::export_edl,
            // 历史与设置
            commands::history::undo,
            commands::history::redo,
            commands::history::get_history,
            commands::history::jump_history,
            commands::settings::get_settings,
            commands::settings::set_settings,
        ])
        .run(tauri::generate_context!())
        .expect("Reelix 启动失败：Tauri 运行时未能初始化");
}
