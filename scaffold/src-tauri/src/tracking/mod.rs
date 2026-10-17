//! 空间识别（运动恢复结构）的数据模型与结果解析。
//!
//! 这一层不依赖 tauri：COLMAP 的文本输出在这里被翻译成前端与合成器都能
//! 直接用的统一相机 JSON（见 `docs/10-特效合成与空间识别.md`）。
//! 坐标约定沿用 COLMAP：位姿是**世界 → 相机**，`X_cam = R · X_world + t`，
//! 相机中心 `C = -Rᵀ · t`。前端 three.js 用 `C` 与 `R` 就能摆出视锥。

pub mod model;

pub use model::{
    parse_cameras, parse_images, parse_points, quat_to_rot, CameraIntrinsics, CameraPose,
    ColmapStatus, SceneCamera, ScenePoint,
};
