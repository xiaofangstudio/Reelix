//! 空间识别命令：调用 COLMAP sidecar 做一遍运动恢复结构（SfM）。
//!
//! 路线 A（`docs/10-特效合成与空间识别.md`）：COLMAP 以独立进程跑，主程序
//! 只负责抽帧、编排三步、解析文本结果。全链路本机完成，不联网。
//!
//! 流水线：
//! 1. ffmpeg 按固定间隔抽帧（0–10%）；
//! 2. `feature_extractor` 提特征（10–40%）；
//! 3. `exhaustive_matcher` 穷举匹配（40–65%）；
//! 4. `mapper` 增量重建（65–90%）；
//! 5. 解析 `sparse/0/*.txt`，写统一相机 JSON（90–100%）。
//!
//! 组件缺失只让这一条链路不可用，不影响剪辑、特效与导出。

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::compositor::decode;
use crate::project::serialize::{new_id, now_ms};
use crate::state::{lock, AppState, ReconstructJob};
use crate::tracking::model::{
    parse_cameras, parse_images, parse_points, CameraIntrinsics, CameraPose, ColmapStatus,
    SceneCamera, ScenePoint, SOLVER_COLMAP,
};

const COLMAP_MISSING: &str =
    "未找到 COLMAP 空间识别组件（reference/tracking/colmap-bin），空间解算暂不可用";

/// 一次解算的启动结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconstructStart {
    pub job_id: String,
}

/// 解算进度事件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconstructProgress {
    pub job_id: String,
    /// 0 ~ 1
    pub progress: f64,
    pub stage: String,
    pub detail: String,
}

/// 解算完成事件：直接带完整场景，前端不用再读文件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconstructDone {
    pub job_id: String,
    pub scene: SceneCamera,
}

/// 解算失败事件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconstructFailed {
    pub job_id: String,
    pub text: String,
}

/// COLMAP 二进制的定位结果。
struct ColmapBundle {
    binary: PathBuf,
}

/// 从 exe 所在目录逐级往上找 COLMAP。
///
/// 开发时在仓库的 `reference/tracking/colmap-bin/`，打包后可选组件装在
/// `resources/colmap/` 或 exe 同级的 `colmap/`。两种布局都认。
///
/// 可选 GPU 包由 `reference/tracking/fetch-colmap-cuda.ps1` 装到
/// `reference/tracking/colmap-gpu/`（也认 `colmap-cuda/`），排在 CPU 版前面：
/// 同一个搜索根下先找到 CUDA 版就用它，找不到自然落到 CPU 版。
fn locate_colmap() -> Option<ColmapBundle> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(Path::to_path_buf);
        for _ in 0..8 {
            let Some(current) = dir else { break };
            roots.push(current.join("colmap"));
            roots.push(current.join("colmap-gpu"));
            roots.push(current.join("colmap-cuda"));
            roots.push(current.join("reference").join("tracking").join("colmap-gpu"));
            roots.push(current.join("reference").join("tracking").join("colmap-cuda"));
            roots.push(current.join("reference").join("tracking").join("colmap-bin"));
            roots.push(current.join("resources").join("colmap"));
            roots.push(current.join("tracking").join("colmap-bin"));
            dir = current.parent().map(Path::to_path_buf);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join("colmap"));
        roots.push(cwd.join("colmap-gpu"));
        roots.push(cwd.join("reference").join("tracking").join("colmap-gpu"));
        roots.push(cwd.join("reference").join("tracking").join("colmap-bin"));
    }

    let exe_name = if cfg!(windows) {
        "colmap.exe"
    } else {
        "colmap"
    };
    for root in roots {
        for candidate in [root.join("bin").join(exe_name), root.join(exe_name)] {
            if candidate.is_file() {
                return Some(ColmapBundle { binary: candidate });
            }
        }
    }
    None
}

/// 读版本号。输出形如
/// `COLMAP 4.2.1 (Commit ... without GPU support, boost hash maps)`。
fn probe_version(binary: &Path) -> (String, bool) {
    let mut command = Command::new(binary);
    command.arg("--version");
    command.stdin(Stdio::null());
    no_window(&mut command);
    let output = match command.output() {
        Ok(out) => out,
        Err(_) => return (String::new(), false),
    };
    let text = if output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr).into_owned()
    } else {
        String::from_utf8_lossy(&output.stdout).into_owned()
    };
    let first = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string();
    let cuda = first.to_lowercase().contains("with cuda");
    (first, cuda)
}

/// COLMAP 组件是否就绪。
#[tauri::command]
pub fn colmap_status() -> Result<ColmapStatus, String> {
    match locate_colmap() {
        Some(bundle) => {
            let (version, cuda) = probe_version(&bundle.binary);
            Ok(ColmapStatus {
                available: true,
                binary: bundle.binary.to_string_lossy().into_owned(),
                version: version.clone(),
                cuda,
                detail: if version.is_empty() {
                    "COLMAP 已就绪（未能读取版本号）".into()
                } else {
                    format!("COLMAP 已就绪：{version}")
                },
            })
        }
        None => Ok(ColmapStatus {
            available: false,
            binary: String::new(),
            version: String::new(),
            cuda: false,
            detail: COLMAP_MISSING.into(),
        }),
    }
}

/// 给子进程加 CREATE_NO_WINDOW，解算时绝不弹黑窗。
#[cfg(windows)]
fn no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn no_window(_command: &mut Command) {}

/// 任务是否已被用户取消。
fn is_cancelled(app: &AppHandle, job_id: &str) -> bool {
    let state = app.state::<AppState>();
    let cancelled = match lock(&state.reconstruct) {
        Ok(jobs) => jobs.get(job_id).map(|j| j.cancelled).unwrap_or(false),
        Err(_) => false,
    };
    cancelled
}

/// 写进任务表 + 发进度事件。
fn report(app: &AppHandle, job_id: &str, progress: f64, stage: &str, detail: &str) {
    let state = app.state::<AppState>();
    if let Ok(mut jobs) = lock(&state.reconstruct) {
        if let Some(job) = jobs.get_mut(job_id) {
            job.progress = progress;
            job.stage = stage.to_string();
        }
    }
    drop(state);
    let _ = app.emit(
        "reconstruct://progress",
        ReconstructProgress {
            job_id: job_id.to_string(),
            progress,
            stage: stage.to_string(),
            detail: detail.to_string(),
        },
    );
}

/// 日志尾部若干行，失败时给人看的原因。
fn log_tail(path: &Path, lines: usize) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let tail: Vec<&str> = text.lines().rev().take(lines).collect();
    tail.into_iter().rev().collect::<Vec<_>>().join("；")
}

/// 跑一个子进程：轮询退出、可取消、超时杀掉，stdout/stderr 落日志。
fn run_tool(
    app: &AppHandle,
    job_id: &str,
    program: &Path,
    args: &[String],
    cwd: &Path,
    log_path: &Path,
    timeout: Duration,
) -> Result<(), String> {
    if is_cancelled(app, job_id) {
        return Err("已取消".into());
    }
    let log = std::fs::File::create(log_path).map_err(|e| format!("创建日志失败：{e}"))?;
    let log_err = log.try_clone().map_err(|e| format!("创建日志失败：{e}"))?;

    let mut command = Command::new(program);
    command.args(args);
    command.current_dir(cwd);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    no_window(&mut command);

    let mut child: Child = command
        .spawn()
        .map_err(|e| format!("启动 {} 失败：{e}", program.display()))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let tail = log_tail(log_path, 8);
                    if tail.is_empty() {
                        return Err(format!("{} 退出码 {}", program.display(), status));
                    }
                    return Err(tail);
                }
                return Ok(());
            }
            Ok(None) => {
                if is_cancelled(app, job_id) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("已取消".into());
                }
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{} 超过 {} 秒未完成，已终止", program.display(), timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("等待 {} 退出失败：{e}", program.display())),
        }
    }
}

/// ffmpeg 按固定间隔抽帧到 `images/`，返回帧数。
fn extract_frames(
    app: &AppHandle,
    job_id: &str,
    ffmpeg: &Path,
    source: &Path,
    interval_s: f64,
    images: &Path,
    log_path: &Path,
) -> Result<usize, String> {
    std::fs::create_dir_all(images).map_err(|e| format!("创建抽帧目录失败：{e}"))?;
    let pattern = images.join("frame_%05d.jpg");
    let filter = format!("fps=1/{interval_s:.4},scale=w='min(1920,iw)':h=-2");
    let args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-v".into(),
        "error".into(),
        "-nostdin".into(),
        "-i".into(),
        source.to_string_lossy().into_owned(),
        "-vf".into(),
        filter,
        "-q:v".into(),
        "2".into(),
        "-start_number".into(),
        "1".into(),
        pattern.to_string_lossy().into_owned(),
    ];
    run_tool(
        app,
        job_id,
        ffmpeg,
        &args,
        images,
        log_path,
        Duration::from_secs(600),
    )?;
    let count = std::fs::read_dir(images)
        .map(|dir| {
            dir.filter_map(|e| e.ok())
                .filter(|e| {
                    e.path()
                        .extension()
                        .map(|ext| ext.eq_ignore_ascii_case("jpg"))
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0);
    if count < 3 {
        return Err(format!(
            "只抽到 {count} 帧，至少需要 3 帧才能解算；请换一段更长或运动更明显的视频"
        ));
    }
    Ok(count)
}

/// 在 `sparse/` 下找第一个含 `cameras.txt` 的子目录。
fn find_sparse_model(sparse: &Path) -> Option<PathBuf> {
    let direct = sparse.join("0");
    if direct.join("cameras.txt").is_file() {
        return Some(direct);
    }
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(sparse)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.join("cameras.txt").is_file())
        .collect();
    candidates.sort();
    candidates.into_iter().next()
}

/// 把场景写进 `camera.json` 并返回解析结果。
fn build_scene(
    app: &AppHandle,
    job_id: &str,
    model_dir: &Path,
    workspace: &Path,
    frame_interval_s: f64,
    image_count: usize,
) -> Result<SceneCamera, String> {
    let cameras_text = std::fs::read_to_string(model_dir.join("cameras.txt"))
        .map_err(|e| format!("读取 cameras.txt 失败：{e}"))?;
    let images_text = std::fs::read_to_string(model_dir.join("images.txt"))
        .map_err(|e| format!("读取 images.txt 失败：{e}"))?;
    let points_text = std::fs::read_to_string(model_dir.join("points3D.txt"))
        .map_err(|e| format!("读取 points3D.txt 失败：{e}"))?;

    let cameras: Vec<CameraIntrinsics> = parse_cameras(&cameras_text);
    let mut poses: Vec<CameraPose> = parse_images(&images_text, frame_interval_s);
    let points: Vec<ScenePoint> = parse_points(&points_text);

    poses.sort_by(|a, b| a.time_ms.partial_cmp(&b.time_ms).unwrap_or(std::cmp::Ordering::Equal));
    if poses.is_empty() {
        return Err("COLMAP 没有注册出任何相机；画面可能缺少纹理或运动不足".into());
    }

    let mean_error = if points.is_empty() {
        0.0
    } else {
        points.iter().map(|p| p.error).sum::<f64>() / points.len() as f64
    };

    let scene = SceneCamera {
        solver: SOLVER_COLMAP.into(),
        image_count,
        registered_count: poses.len(),
        point_count: points.len(),
        mean_error,
        frame_interval_s,
        cameras,
        poses,
        points,
        workspace: workspace.to_string_lossy().into_owned(),
        created_at: now_ms(),
    };

    let json = serde_json::to_string_pretty(&scene)
        .map_err(|e| format!("相机 JSON 序列化失败：{e}"))?;
    std::fs::write(workspace.join("camera.json"), json)
        .map_err(|e| format!("写入 camera.json 失败：{e}"))?;

    report(
        app,
        job_id,
        1.0,
        "已完成",
        &format!(
            "注册 {}/{} 帧，{} 个稀疏点",
            scene.registered_count, scene.image_count, scene.point_count
        ),
    );
    Ok(scene)
}

/// 后台流水线。任何一步失败都带着中文原因回前端。
fn run_pipeline(
    app: &AppHandle,
    job_id: &str,
    colmap: &Path,
    ffmpeg: &Path,
    source: &Path,
    interval_s: f64,
    workspace: &Path,
) -> Result<SceneCamera, String> {
    let images = workspace.join("images");
    let db = workspace.join("database.db");
    let sparse = workspace.join("sparse");

    report(app, job_id, 0.01, "抽帧", "正在从视频里按间隔抽帧");
    let image_count = extract_frames(
        app,
        job_id,
        ffmpeg,
        source,
        interval_s,
        &images,
        &workspace.join("extract.log"),
    )?;
    report(app, job_id, 0.10, "抽帧", &format!("已抽出 {image_count} 帧"));

    report(app, job_id, 0.12, "特征提取", "正在提取 SIFT 特征");
    let feature_args = vec![
        "feature_extractor".to_string(),
        "--database_path".to_string(),
        db.to_string_lossy().into_owned(),
        "--image_path".to_string(),
        images.to_string_lossy().into_owned(),
        "--ImageReader.single_camera".to_string(),
        "1".to_string(),
        "--ImageReader.camera_model".to_string(),
        "OPENCV".to_string(),
    ];
    run_tool(
        app,
        job_id,
        colmap,
        &feature_args,
        workspace,
        &workspace.join("features.log"),
        Duration::from_secs(900),
    )?;
    report(app, job_id, 0.40, "特征提取", "特征提取完成");

    report(app, job_id, 0.42, "特征匹配", "正在做穷举匹配");
    let match_args = vec![
        "exhaustive_matcher".to_string(),
        "--database_path".to_string(),
        db.to_string_lossy().into_owned(),
    ];
    run_tool(
        app,
        job_id,
        colmap,
        &match_args,
        workspace,
        &workspace.join("match.log"),
        Duration::from_secs(900),
    )?;
    report(app, job_id, 0.65, "特征匹配", "匹配完成");

    report(app, job_id, 0.67, "光束法平差", "正在增量重建与优化位姿");
    std::fs::create_dir_all(&sparse).map_err(|e| format!("创建 sparse 目录失败：{e}"))?;
    let mapper_args = vec![
        "mapper".to_string(),
        "--database_path".to_string(),
        db.to_string_lossy().into_owned(),
        "--image_path".to_string(),
        images.to_string_lossy().into_owned(),
        "--output_path".to_string(),
        sparse.to_string_lossy().into_owned(),
    ];
    run_tool(
        app,
        job_id,
        colmap,
        &mapper_args,
        workspace,
        &workspace.join("mapper.log"),
        Duration::from_secs(1800),
    )?;
    report(app, job_id, 0.90, "光束法平差", "重建完成，正在整理相机 JSON");

    let model_dir = find_sparse_model(&sparse)
        .ok_or_else(|| "COLMAP 没有产出 sparse 模型；画面可能纹理不足".to_string())?;
    build_scene(app, job_id, &model_dir, workspace, interval_s, image_count)
}

/// 开始一次空间解算。
#[tauri::command(async)]
pub fn start_reconstruct(
    asset_id: String,
    keyframe_interval_s: Option<f64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ReconstructStart, String> {
    let bundle = locate_colmap().ok_or_else(|| COLMAP_MISSING.to_string())?;
    let ffmpeg = decode::locate_ffmpeg()
        .ok_or_else(|| "没找到 ffmpeg，无法抽帧".to_string())?;

    let (source, duration_ms) = {
        let guard = lock(&state.project)?;
        let project = guard.as_ref().ok_or_else(|| "还没有打开项目".to_string())?;
        let asset = project
            .assets
            .iter()
            .find(|a| a.id == asset_id)
            .ok_or_else(|| "找不到该素材".to_string())?;
        if asset.missing {
            return Err("素材文件丢失，请重新链接后再试".to_string());
        }
        (PathBuf::from(&asset.path), asset.duration_ms)
    };
    if !source.is_file() {
        return Err("素材文件不存在，请重新链接后再试".to_string());
    }
    if duration_ms < 2000.0 {
        return Err("素材太短，至少需要 2 秒才能解算".to_string());
    }

    // 抽帧间隔：默认 2 秒一帧，夹在 0.25–10 秒之间；短素材自动加密。
    let interval = keyframe_interval_s
        .unwrap_or(2.0)
        .clamp(0.25, 10.0);

    let cache_dir = PathBuf::from(lock(&state.settings)?.cache_dir.clone());
    let job_id = new_id("reconstruct");
    let workspace = cache_dir.join("reconstruct").join(&job_id);
    std::fs::create_dir_all(&workspace).map_err(|e| format!("创建解算目录失败：{e}"))?;

    {
        let mut jobs = lock(&state.reconstruct)?;
        jobs.insert(
            job_id.clone(),
            ReconstructJob {
                id: job_id.clone(),
                cancelled: false,
                stage: "准备中".into(),
                progress: 0.0,
            },
        );
    }

    let thread_job = job_id.clone();
    let thread_workspace = workspace.clone();
    let thread_app = app.clone();
    std::thread::Builder::new()
        .name(format!("reconstruct-{job_id}"))
        .spawn(move || {
            let result = run_pipeline(
                &thread_app,
                &thread_job,
                &bundle.binary,
                &ffmpeg,
                &source,
                interval,
                &thread_workspace,
            );
            match result {
                Ok(scene) => {
                    let _ = thread_app.emit(
                        "reconstruct://done",
                        ReconstructDone {
                            job_id: thread_job.clone(),
                            scene,
                        },
                    );
                }
                Err(text) => {
                    let cancelled = text == "已取消";
                    if let Some(state) = thread_app.try_state::<AppState>() {
                        if let Ok(mut jobs) = lock(&state.reconstruct) {
                            if let Some(job) = jobs.get_mut(&thread_job) {
                                job.stage = if cancelled { "已取消" } else { "失败" }.into();
                            }
                        }
                    }
                    let _ = thread_app.emit(
                        "reconstruct://error",
                        ReconstructFailed {
                            job_id: thread_job.clone(),
                            text: if cancelled {
                                "已取消解算".to_string()
                            } else {
                                text
                            },
                        },
                    );
                }
            }
        })
        .map_err(|e| format!("启动解算线程失败：{e}"))?;

    Ok(ReconstructStart { job_id })
}

/// 取消一次解算：置标志，轮询循环会把子进程杀掉。
#[tauri::command]
pub fn cancel_reconstruct(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut jobs = lock(&state.reconstruct)?;
    let job = jobs
        .get_mut(&job_id)
        .ok_or_else(|| "找不到该解算任务".to_string())?;
    job.cancelled = true;
    job.stage = "正在取消".into();
    Ok(true)
}
