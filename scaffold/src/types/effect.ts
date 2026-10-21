/**
 * 效果栈数据模型。
 *
 * 图层式界面里，一个片段（图层）挂一串效果，从上到下就是渲染顺序——
 * 不再有节点连线的概念。效果参数与关键帧仍然走同一套曲线引擎，
 * 所以效果栈（参数）和曲线编辑器（关键帧）是同一份数据的两个视角。
 */

import type { EasingPreset } from "./keyframe";
import type { Id } from "./project";

/** 效果参数值。与节点参数保持同样的三类，数值型才会出现可拖动的数值框。 */
export type EffectParamValue = number | string | boolean;

/** 效果分类。与节点分类同义，见 docs/02 第 D3 节的首版效果清单。 */
export type EffectCategory =
  | "输入"
  | "变换"
  | "颜色"
  | "滤镜"
  | "抠像"
  | "蒙版"
  | "粒子"
  | "合成"
  | "GPU"
  | "生成"
  | "风格化"
  | "输出";

/**
 * 内置效果类型键。范围严格照 docs/02-功能规格.md 第 D3 节「首版效果清单」：
 * 输入 / 变换 / 颜色 / 滤镜 / 抠像 / 蒙版 / 粒子 / 合成 / 输出 九类，共 27 个
 * （含 `opacity` 不透明度与 `output` 输出，它们是既有工程与关键帧数据在用的内置效果）。
 * 权威清单（含参数与默认值）在 `src/core/effectCatalog.ts`，此处只列键。
 *
 * 注意：早期文档里的「液态 / 流体类」已彻底删除（那是把一次语音识别错误当成需求），
 * 详见 docs/10 第〇节与 docs/02 第 D3 节末尾的说明。这里不得再出现液态相关键。
 */
export type EffectType =
  // 输入 / 生成
  | "sequence"
  | "clip"
  | "color"
  | "text"
  | "image"
  // 变换
  | "transform"
  | "crop"
  | "mirror"
  // 颜色
  | "grade"
  | "curves"
  | "lut"
  | "mono"
  // 抠像（色度抠图，用户点名要）
  | "keyer"
  // 滤镜
  | "gpuGrade"
  | "gpuLut"
  | "gradient"
  | "circle"
  | "checkerboard"
  | "grid"
  | "findEdges"
  | "emboss"
  | "posterize"
  | "blur"
  | "sharpen"
  | "glow"
  | "noise"
  | "mosaic"
  // 蒙版 / 形状遮罩（用户点名要，不准少）
  | "maskShape"
  | "maskPen"
  | "maskTrack"
  // 粒子系统（用户点名要，不准少）
  | "particles"
  // 合成 / 图层
  | "blend"
  | "mask"
  | "merge"
  | "opacity"
  // 输出
  | "output";

/** 一条效果参数。 */
export interface EffectParam {
  key: string;
  /** 中文标签，界面不出现英文键 */
  label: string;
  value: EffectParamValue;
  min?: number;
  max?: number;
  /** 鼠标拖动 1px 对应的数值增量 */
  step?: number;
  /** 秒表是否点亮：点亮即该参数参与关键帧动画 */
  animated: boolean;
}

/** 一张效果卡片。 */
export interface Effect {
  id: Id;
  /** 所属片段，效果栈靠它和选中态对齐 */
  clipId: Id;
  type: EffectType;
  /** 中文显示名，用户可改 */
  name: string;
  /** 旁路：保留效果但不参与渲染 */
  bypassed: boolean;
  /** 折叠卡片 */
  collapsed: boolean;
  /** 渲染顺序即数组顺序，第一个最先生效 */
  params: EffectParam[];
}

/**
 * 效果参数关键帧。targetId 语义上等价于 effectId，这里显式用 effectId 便于按效果聚合曲线。
 */
export interface EffectKeyframe {
  id: Id;
  effectId: Id;
  /** 参数键，对应 EffectParam.key */
  param: string;
  timeMs: number;
  value: number;
  easing: EasingPreset;
  inTangent: { x: number; y: number };
  outTangent: { x: number; y: number };
}
