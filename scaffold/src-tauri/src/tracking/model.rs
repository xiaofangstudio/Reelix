//! 相机 JSON 数据模型 + COLMAP 文本结果解析。
//!
//! 字段名即契约，与 `src/types/camera.ts` 一致（`serde(rename_all = "camelCase")`）。
//! 解析只认 COLMAP 的 `cameras.txt / images.txt / points3D.txt` 三个文本文件，
//! 不碰数据库，也不依赖 COLMAP 的 C++ 库。

use serde::{Deserialize, Serialize};

/// 解算器标识。路线 A（COLMAP sidecar）固定为 `colmap`。
pub const SOLVER_COLMAP: &str = "colmap";

/// 单台相机的内参。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraIntrinsics {
    pub camera_id: u32,
    /// COLMAP 相机模型名，如 `OPENCV` / `PINHOLE` / `SIMPLE_RADIAL`
    pub model: String,
    pub width: u32,
    pub height: u32,
    /// COLMAP 原始参数数组，顺序随模型而变
    pub params: Vec<f64>,
    /// 像素焦距与主点（已按模型归一化，前端不必再区分模型）
    pub fx: f64,
    pub fy: f64,
    pub cx: f64,
    pub cy: f64,
}

/// 一帧的相机位姿。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraPose {
    /// COLMAP 里的图像名，抽帧后形如 `frame_00001.jpg`
    pub name: String,
    pub image_id: u32,
    pub camera_id: u32,
    /// 该帧在源视频里的时间（毫秒）。按抽帧间隔从文件名序号换算
    pub time_ms: f64,
    /// 世界 → 相机的旋转四元数，顺序 `[qw, qx, qy, qz]`
    pub quaternion: [f64; 4],
    /// 世界 → 相机的平移
    pub translation: [f64; 3],
    /// 相机中心（世界坐标），`C = -Rᵀ · t`
    pub center: [f64; 3],
}

/// 稀疏点云里的一个 3D 点。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenePoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub r: u8,
    pub g: u8,
    pub b: u8,
    /// 重投影误差（像素）
    pub error: f64,
}

/// 一次解算的完整结果，落到工作目录的 `camera.json`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneCamera {
    pub solver: String,
    /// 参与解算的图像总数
    pub image_count: usize,
    /// 成功注册的图像数
    pub registered_count: usize,
    /// 稀疏点数量
    pub point_count: usize,
    /// 平均重投影误差（像素）
    pub mean_error: f64,
    /// 抽帧间隔（秒）
    pub frame_interval_s: f64,
    pub cameras: Vec<CameraIntrinsics>,
    pub poses: Vec<CameraPose>,
    pub points: Vec<ScenePoint>,
    /// 工作目录：数据库、图像与 sparse 都在这里
    pub workspace: String,
    pub created_at: i64,
}

/// COLMAP 组件探测结果，前端用它决定按钮是否可点。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColmapStatus {
    pub available: bool,
    pub binary: String,
    pub version: String,
    /// 是否带 CUDA 加速（可选组件）
    pub cuda: bool,
    pub detail: String,
}

/// 四元数转旋转矩阵（行主序，世界 → 相机）。
pub fn quat_to_rot(q: [f64; 4]) -> [[f64; 3]; 3] {
    let [w, x, y, z] = q;
    let norm = (w * w + x * x + y * y + z * z).sqrt();
    let (w, x, y, z) = if norm < f64::EPSILON {
        (1.0, 0.0, 0.0, 0.0)
    } else {
        (w / norm, x / norm, y / norm, z / norm)
    };
    [
        [
            1.0 - 2.0 * (y * y + z * z),
            2.0 * (x * y - w * z),
            2.0 * (x * z + w * y),
        ],
        [
            2.0 * (x * y + w * z),
            1.0 - 2.0 * (x * x + z * z),
            2.0 * (y * z - w * x),
        ],
        [
            2.0 * (x * z - w * y),
            2.0 * (y * z + w * x),
            1.0 - 2.0 * (x * x + y * y),
        ],
    ]
}

/// 相机中心：`C = -Rᵀ · t`。
fn camera_center(rot: &[[f64; 3]; 3], t: [f64; 3]) -> [f64; 3] {
    [
        -(rot[0][0] * t[0] + rot[1][0] * t[1] + rot[2][0] * t[2]),
        -(rot[0][1] * t[0] + rot[1][1] * t[1] + rot[2][1] * t[2]),
        -(rot[0][2] * t[0] + rot[1][2] * t[1] + rot[2][2] * t[2]),
    ]
}

/// 按 COLMAP 相机模型把参数数组拆成 `fx / fy / cx / cy`。
fn intrinsics_from_params(model: &str, p: &[f64]) -> (f64, f64, f64, f64) {
    let at = |i: usize| p.get(i).copied().unwrap_or(0.0);
    match model {
        // f, cx, cy
        "SIMPLE_PINHOLE" | "SIMPLE_RADIAL" | "RADIAL" | "SIMPLE_RADIAL_FISHEYE"
        | "RADIAL_FISHEYE" => (at(0), at(0), at(1), at(2)),
        // fx, fy, cx, cy, ...
        _ => (at(0), at(1), at(2), at(3)),
    }
}

/// 解析 `cameras.txt`。空行与 `#` 注释跳过；格式不认识的行也跳过，不炸整次解算。
pub fn parse_cameras(text: &str) -> Vec<CameraIntrinsics> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(camera_id) = parts.next().and_then(|v| v.parse::<u32>().ok()) else {
            continue;
        };
        let Some(model) = parts.next() else { continue };
        let Some(width) = parts.next().and_then(|v| v.parse::<u32>().ok()) else {
            continue;
        };
        let Some(height) = parts.next().and_then(|v| v.parse::<u32>().ok()) else {
            continue;
        };
        let params: Vec<f64> = parts.filter_map(|v| v.parse::<f64>().ok()).collect();
        let (fx, fy, cx, cy) = intrinsics_from_params(model, &params);
        out.push(CameraIntrinsics {
            camera_id,
            model: model.to_string(),
            width,
            height,
            params,
            fx,
            fy,
            cx,
            cy,
        });
    }
    out
}

/// 从 `frame_00007.jpg` 这种名字里取序号，换算成毫秒。
fn frame_time_ms(name: &str, interval_s: f64) -> f64 {
    let digits: String = name
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let index = digits.parse::<u32>().unwrap_or(1).max(1);
    (index as f64 - 1.0) * interval_s.max(0.0) * 1000.0
}

/// 解析 `images.txt`。
///
/// 格式是两行一组：第一行位姿，第二行该图上的 2D 观测（可能为空行）。
/// 只认位姿行，观测行直接跳过。
pub fn parse_images(text: &str, frame_interval_s: f64) -> Vec<CameraPose> {
    let mut out = Vec::new();
    // 不能先过滤空行：空行是「该图没有 2D 观测」的占位，过滤掉会把下一张图的位姿行当成观测行吞掉。
    let raw: Vec<&str> = text.lines().collect();
    let mut index = 0usize;
    while index < raw.len() {
        let line = raw[index].trim();
        index += 1;
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 9 {
            continue;
        }
        let Ok(image_id) = fields[0].parse::<u32>() else {
            continue;
        };
        let nums: Option<Vec<f64>> = fields[1..8]
            .iter()
            .map(|v| v.parse::<f64>().ok())
            .collect();
        let Some(nums) = nums else { continue };
        let Ok(camera_id) = fields[8].parse::<u32>() else {
            continue;
        };
        let name = fields[9..].join(" ");
        let quaternion = [nums[0], nums[1], nums[2], nums[3]];
        let translation = [nums[4], nums[5], nums[6]];
        let rot = quat_to_rot(quaternion);
        let center = camera_center(&rot, translation);
        out.push(CameraPose {
            name: name.clone(),
            image_id,
            camera_id,
            time_ms: frame_time_ms(&name, frame_interval_s),
            quaternion,
            translation,
            center,
        });
        // 消费掉紧随其后的 2D 观测行（可能是空行）
        if index < raw.len() {
            index += 1;
        }
    }
    out
}

/// 解析 `points3D.txt`。`POINT3D_ID X Y Z R G B ERROR TRACK[]`。
pub fn parse_points(text: &str) -> Vec<ScenePoint> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 8 {
            continue;
        }
        let (Ok(x), Ok(y), Ok(z)) = (
            f[1].parse::<f64>(),
            f[2].parse::<f64>(),
            f[3].parse::<f64>(),
        ) else {
            continue;
        };
        let (Ok(r), Ok(g), Ok(b)) = (
            f[4].parse::<u8>(),
            f[5].parse::<u8>(),
            f[6].parse::<u8>(),
        ) else {
            continue;
        };
        let Ok(error) = f[7].parse::<f64>() else {
            continue;
        };
        out.push(ScenePoint {
            x,
            y,
            z,
            r,
            g,
            b,
            error,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAMERAS: &str = "# Camera list with one line of data per camera:\n\
#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n\
1 OPENCV 1920 1080 1500.5 1499.5 960 540 -0.02 0.01 0.0001 -0.0002\n";

    const IMAGES: &str = "# Image list with two lines of data per image:\n\
1 0.5 0.5 0.5 0.5 1.2 -0.4 2.5 1 frame_00001.jpg\n\
10 20 1 30 40 2\n\
2 0.5 0.5 0.5 0.5 1.4 -0.6 2.8 1 frame_00003.jpg\n\
\n";

    const POINTS: &str = "# 3D point list\n\
7 0.1 0.2 0.3 120 130 140 0.85 1 2 3 4\n\
8 -1.0 0.5 2.0 255 0 0 1.25\n";

    #[test]
    fn parses_camera_intrinsics_by_model() {
        let cams = parse_cameras(CAMERAS);
        assert_eq!(cams.len(), 1);
        assert_eq!(cams[0].model, "OPENCV");
        assert!((cams[0].fx - 1500.5).abs() < 1e-9);
        assert!((cams[0].cx - 960.0).abs() < 1e-9);
    }

    #[test]
    fn parses_poses_and_converts_time() {
        let poses = parse_images(IMAGES, 2.0);
        assert_eq!(poses.len(), 2);
        assert!((poses[0].time_ms - 0.0).abs() < 1e-9);
        assert!((poses[1].time_ms - 4000.0).abs() < 1e-9);
        // 四元数 (0.5,0.5,0.5,0.5) 的相机中心应等于 -Rᵀt
        let rot = quat_to_rot(poses[0].quaternion);
        let expected = camera_center(&rot, poses[0].translation);
        assert!((poses[0].center[0] - expected[0]).abs() < 1e-9);
    }

    #[test]
    fn parses_points_and_skips_bad_lines() {
        let pts = parse_points(POINTS);
        assert_eq!(pts.len(), 2);
        assert_eq!(pts[0].r, 120);
        assert!((pts[1].error - 1.25).abs() < 1e-9);
    }
}
