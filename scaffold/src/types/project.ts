/**
 * 项目数据模型。字段名即契约，与 docs/03-技术架构.md 第五节一致。
 *
 * 注意：`export *` 只做转出，不会把名字带进本文件作用域，
 * 所以下面必须显式 import Graph，否则 `graphs: Record<Id, Graph>` 会解析失败、
 * 连锁导致所有 `project.graphs` 访问退化成 any。
 */

import type { Graph } from "./graph";

export type Id = string;

export interface Project {
  id: Id;
  name: string;
  createdAt: number;
  modifiedAt: number;
  assets: Asset[];
  sequences: Sequence[];
  graphs: Record<Id, Graph>;
  /** 素材箱文件夹。后端 serde default，旧工程读不到时按 [] 容错 */
  bins?: Array<{ id: Id; name: string }>;
}

export interface Asset {
  id: Id;
  path: string;
  name: string;
  kind: "video" | "audio" | "image" | "imageSequence";
  durationMs: number;
  width: number;
  height: number;
  frameRate: number;
  codec: string;
  hasAudio: boolean;
  missing: boolean;
  /** 所属文件夹 id；null 或缺省 = 未归类（「全部」） */
  binId?: Id | null;
}

export interface Sequence {
  id: Id;
  name: string;
  width: number;
  height: number;
  frameRate: number;
  colorSpace: string;
  durationMs: number;
  tracks: Track[];
  rootGraphId: Id;
  /** 时间线标记。后端 serde default，旧工程读不到时按 [] 容错 */
  markers?: Array<{ id: Id; timeMs: number; name: string | null }>;
}

export interface Track {
  id: Id;
  /** camera 轨道承载摄像机节点，见 docs/09-3D摄像机与素材库.md；
   *  subtitle 轨道只存文字片段，导出时烧进画面 */
  kind: "video" | "audio" | "camera" | "subtitle";
  index: number;
  muted: boolean;
  solo: boolean;
  locked: boolean;
  hidden: boolean;
  height: number;
  clips: Clip[];
}

/** 图层方向：朝向相机自动转向 / 自由朝向（docs/09 第 2.3 节） */
export type Layer3DOrientation = "camera" | "free";

/** 图层 3D 变换。仅当 Clip.enable3D 为真时生效。 */
export interface Transform3D {
  /** 位置 XYZ，单位 px，Z 支持负数 */
  position: { x: number; y: number; z: number };
  /** 旋转 XYZ，单位度 */
  rotation: { x: number; y: number; z: number };
  /** 统一缩放 */
  scale: number;
  orientation: Layer3DOrientation;
  /** 锚点，0~1 归一化 */
  anchor: { x: number; y: number };
  /** 是否接受光照 */
  receiveLight: boolean;
}

/** 图层勾选「启用 3D」时的默认变换：老实待在 Z=0 平面。 */
export const DEFAULT_TRANSFORM_3D: Transform3D = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: 1,
  orientation: "camera",
  anchor: { x: 0.5, y: 0.5 },
  receiveLight: false,
};

/** 摄像机方向模式：单节点（用旋转控制朝向）/ 双节点（看向目标点），docs/09 第 2.3 节。 */
export type CameraOrientationMode = "oneNode" | "twoNode";

/** 摄像机视角预设，对应监视器四视图标签，docs/09 第 2.5 节。 */
export type CameraViewPreset = "active" | "front" | "top" | "left" | "custom";

/** 摄像机节点参数键，与 Rust 侧 Camera 节点注册表一一对应。 */
export type CameraParamKey =
  | "posX"
  | "posY"
  | "posZ"
  | "targetX"
  | "targetY"
  | "targetZ"
  | "focalLength"
  | "orientationMode"
  | "depthOfField"
  | "aperture"
  | "focusDistance"
  | "blurLevel"
  | "motionBlur"
  | "shutterAngle"
  | "viewPreset";

/**
 * 摄像机节点参数默认值，严格照抄 docs/09 第 2.3 节表格。
 * 焦距等效 35mm、默认 50mm；位置默认在 Z=-1000 处看向原点。
 */
export const CAMERA_DEFAULTS: Record<CameraParamKey, number | string | boolean> = {
  posX: 0,
  posY: 0,
  posZ: -1000,
  targetX: 0,
  targetY: 0,
  targetZ: 0,
  focalLength: 50,
  orientationMode: "twoNode",
  depthOfField: false,
  aperture: 5.6,
  focusDistance: 1000,
  blurLevel: 1,
  motionBlur: false,
  shutterAngle: 180,
  viewPreset: "active",
};

export interface Clip {
  id: Id;
  assetId: Id;
  trackId: Id;
  /** 在序列上的起点 */
  startMs: number;
  durationMs: number;
  /** 素材内的入点出点 */
  inMs: number;
  outMs: number;
  speed: number;
  reversed: boolean;
  /** 对应的图节点。这一条就是剪辑与特效融合的接口 */
  nodeId: Id;
  compoundId?: Id;
  /** 勾选「启用 3D」后为真；未勾选的图层老实待在 Z=0 平面 */
  enable3D?: boolean;
  /** 3D 变换属性，未启用 3D 时缺省 */
  transform3D?: Transform3D;
  /** 字幕轨片段的文字内容；普通视频/音频片段为空 */
  text?: string;
  /** 右键「启用」勾选状态；禁用的片段不参与预览与导出 */
  enabled?: boolean;
  /** 右键「标签」颜色名（PR 式标签色，界面用高饱和渲染） */
  label?: string;
  /** 入场转场：与前一片段衔接处的叠化，见 Rust `Transition` */
  transitionIn?: { kind: TransitionKind; durationMs: number } | null;
  /** 音频淡入 / 淡出时长（毫秒），仅音频片段使用 */
  audioFadeInMs?: number | null;
  /** 高通/低通截止 Hz、回声 ms（混音时真滤波） */
  audioHighpassHz?: number | null;
  audioLowpassHz?: number | null;
  audioDelayMs?: number | null;
  audioFadeOutMs?: number | null;
}

/** 转场类型：由 Rust 合成器实现 */
export type TransitionKind =
  | "crossDissolve"
  | "dipToBlack"
  | "dipToWhite"
  | "slidePush"
  | "slidePull"
  | "wipeLinear"
  | "wipeRadial"
  | "wipeBlinds"
  | "zoomCross";

// 从 ./graph 再导出，方便只引 project 的地方也能拿到图类型
export * from "./graph";