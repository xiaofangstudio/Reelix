/**
 * 空间识别结果类型。与 `src-tauri/src/tracking/model.rs` 一一对应。
 *
 * 坐标约定沿用 COLMAP：位姿是世界 → 相机，`X_cam = R · X_world + t`，
 * `center = -Rᵀ · t`。三维预览把 y 轴翻成向上后直接渲染。
 */

/** 单台相机内参 */
export interface CameraIntrinsics {
  cameraId: number;
  /** COLMAP 相机模型名，如 OPENCV / PINHOLE / SIMPLE_RADIAL */
  model: string;
  width: number;
  height: number;
  /** COLMAP 原始参数数组，顺序随模型而变 */
  params: number[];
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

/** 一帧的相机位姿 */
export interface CameraPose {
  name: string;
  imageId: number;
  cameraId: number;
  /** 该帧在源视频里的时间（毫秒） */
  timeMs: number;
  /** 世界 → 相机四元数，顺序 [w, x, y, z] */
  quaternion: [number, number, number, number];
  translation: [number, number, number];
  /** 相机中心（世界坐标） */
  center: [number, number, number];
}

/** 稀疏点云中的一个点 */
export interface ScenePoint {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  /** 重投影误差（像素） */
  error: number;
}

/** 一次解算的完整结果，同时落盘为工作目录的 camera.json */
export interface SceneCamera {
  solver: string;
  imageCount: number;
  registeredCount: number;
  pointCount: number;
  meanError: number;
  frameIntervalS: number;
  cameras: CameraIntrinsics[];
  poses: CameraPose[];
  points: ScenePoint[];
  workspace: string;
  createdAt: number;
}

/** COLMAP 组件探测结果 */
export interface ColmapStatus {
  available: boolean;
  binary: string;
  version: string;
  /** 是否带 CUDA 加速（可选组件） */
  cuda: boolean;
  detail: string;
}

/** 解算进度事件 */
export interface ReconstructProgressPayload {
  jobId: string;
  /** 0 ~ 1 */
  progress: number;
  stage: string;
  detail: string;
}

/** 解算完成事件 */
export interface ReconstructDonePayload {
  jobId: string;
  scene: SceneCamera;
}

/** 解算失败事件 */
export interface ReconstructFailedPayload {
  jobId: string;
  text: string;
}
