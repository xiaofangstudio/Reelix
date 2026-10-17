/**
 * 效果清单（权威）。
 *
 * 范围严格照 docs/02-功能规格.md 第 D3 节「首版效果清单」：输入 / 变换 / 颜色 /
 * 滤镜 / 抠像 / 蒙版 / 粒子 / 合成 / 输出 九类，共 27 个效果（含不透明度与输出）。
 * 每一个效果都写清中文名、分类、输入输出插槽与参数默认值——
 * 界面上的「+ 效果」菜单、效果栈卡片、节点注册表都由这一份派生，
 * Rust 侧 `graph/catalog.rs` 与它保持同一份内容（键与默认值一一对应）。
 *
 * **没有液态 / 流体这一回事**——那是早期把一次语音识别错误当成需求，现已彻底删除，
 * 详见 docs/10 第〇节、docs/02 第 D3 节末尾。这里不得再出现液态相关条目。
 * 空间追踪类 8 个（含摄像机与 2D→3D 转换）不在首版，见 docs/08。
 *
 * 参数范围（min / max / step）是界面数值框的取值范围，不是物理常量。
 */

import type { EffectCategory, EffectParamValue, EffectType } from "../types/effect";
import type { PlugDataType } from "../types/graph";

/** 一条效果参数规格，不含运行时才有的 animated。 */
export interface EffectParamSpec {
  key: string;
  label: string;
  value: EffectParamValue;
  min?: number;
  max?: number;
  step?: number;
}

/** 一个输入 / 输出插槽规格。插槽只在内部图里用，效果栈界面不显示连线。 */
export interface EffectPlugSpec {
  key: string;
  label: string;
  dataType: PlugDataType;
}

/** 注册表里的一条效果。 */
export interface EffectCatalogEntry {
  type: EffectType;
  label: string;
  category: EffectCategory;
  /** 能否从「+ 效果」菜单加到片段上；序列 / 片段 / 输出是结构性节点，不参与。 */
  addable: boolean;
  inputs: EffectPlugSpec[];
  outputs: EffectPlugSpec[];
  params: EffectParamSpec[];
}

// 常用插槽，避免逐条重复书写。
const IN: EffectPlugSpec = { key: "in", label: "输入", dataType: "image" };
const OUT: EffectPlugSpec = { key: "out", label: "输出", dataType: "image" };
const OUT_FRAME: EffectPlugSpec = { key: "out", label: "画面", dataType: "image" };

/** 三种蒙版（形状 / 钢笔 / 跟踪）共用的一批参数，键名与 Rust 侧分派一一对应。 */
const MASK_BASE: EffectParamSpec[] = [
  { key: "centerX", label: "中心 X", value: 50, min: 0, max: 100, step: 1 },
  { key: "centerY", label: "中心 Y", value: 50, min: 0, max: 100, step: 1 },
  { key: "width", label: "宽度", value: 60, min: 0, max: 200, step: 1 },
  { key: "height", label: "高度", value: 60, min: 0, max: 200, step: 1 },
  { key: "roundness", label: "圆角", value: 0, min: 0, max: 100, step: 1 },
  { key: "rotation", label: "旋转", value: 0, min: -180, max: 180, step: 1 },
  { key: "feather", label: "羽化", value: 0, min: 0, max: 100, step: 1 },
  { key: "invert", label: "反转", value: false },
];

/** 分类顺序，界面按这个顺序排列。 */
export const EFFECT_CATEGORY_ORDER: EffectCategory[] = [
  "输入",
  "变换",
  "颜色",
  "滤镜",
  "抠像",
  "蒙版",
  "粒子",
  "合成",
  "输出",
];

/** 全部内置效果。 */
export const EFFECT_CATALOG: EffectCatalogEntry[] = [
  // ---- 输入 / 生成 ----
  {
    type: "sequence",
    label: "序列",
    category: "输入",
    addable: false,
    inputs: [IN],
    outputs: [OUT],
    params: [],
  },
  {
    type: "clip",
    label: "片段",
    category: "输入",
    addable: false,
    inputs: [],
    outputs: [OUT_FRAME],
    params: [
      { key: "opacity", label: "不透明度", value: 100, min: 0, max: 100, step: 1 },
    ],
  },
  {
    type: "color",
    label: "颜色",
    category: "输入",
    addable: true,
    inputs: [],
    outputs: [OUT_FRAME],
    params: [
      { key: "color", label: "颜色", value: "#FFFFFF" },
      { key: "opacity", label: "不透明度", value: 100, min: 0, max: 100, step: 1 },
    ],
  },
  {
    type: "text",
    label: "文字",
    category: "输入",
    addable: true,
    inputs: [],
    outputs: [OUT_FRAME],
    params: [
      { key: "text", label: "文字", value: "文字" },
      { key: "fontSize", label: "字号", value: 72, min: 8, max: 400, step: 1 },
      { key: "color", label: "颜色", value: "#FFFFFF" },
      { key: "align", label: "对齐", value: "center" },
      { key: "opacity", label: "不透明度", value: 100, min: 0, max: 100, step: 1 },
    ],
  },
  {
    type: "image",
    label: "图片",
    category: "输入",
    addable: true,
    inputs: [],
    outputs: [OUT_FRAME],
    params: [
      { key: "source", label: "素材", value: "" },
      { key: "opacity", label: "不透明度", value: 100, min: 0, max: 100, step: 1 },
    ],
  },

  // ---- 变换 ----
  {
    type: "transform",
    label: "变换",
    category: "变换",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [
      { key: "posX", label: "位置 X", value: 0, min: -2000, max: 2000, step: 1 },
      { key: "posY", label: "位置 Y", value: 0, min: -2000, max: 2000, step: 1 },
      { key: "scale", label: "缩放", value: 100, min: 1, max: 400, step: 1 },
      { key: "rotation", label: "旋转", value: 0, min: -360, max: 360, step: 0.1 },
      { key: "anchorX", label: "锚点 X", value: 0, min: -2000, max: 2000, step: 1 },
      { key: "anchorY", label: "锚点 Y", value: 0, min: -2000, max: 2000, step: 1 },
      { key: "skew", label: "倾斜", value: 0, min: -45, max: 45, step: 0.1 },
    ],
  },
  {
    type: "crop",
    label: "裁剪",
    category: "变换",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [
      { key: "top", label: "上", value: 0, min: 0, max: 100, step: 1 },
      { key: "bottom", label: "下", value: 0, min: 0, max: 100, step: 1 },
      { key: "left", label: "左", value: 0, min: 0, max: 100, step: 1 },
      { key: "right", label: "右", value: 0, min: 0, max: 100, step: 1 },
    ],
  },
  {
    type: "mirror",
    label: "镜像",
    category: "变换",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [{ key: "mode", label: "方向", value: "horizontal" }],
  },

  // ---- 颜色 ----
  {
    type: "grade",
    label: "调色",
    category: "颜色",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [
      { key: "exposure", label: "曝光", value: 0, min: -5, max: 5, step: 0.1 },
      { key: "contrast", label: "对比度", value: 0, min: -100, max: 100, step: 1 },
      { key: "saturation", label: "饱和度", value: 0, min: -100, max: 100, step: 1 },
      { key: "temperature", label: "色温", value: 0, min: -100, max: 100, step: 1 },
      { key: "tint", label: "色调", value: 0, min: -100, max: 100, step: 1 },
      { key: "highlights", label: "高光", value: 0, min: -100, max: 100, step: 1 },
      { key: "shadows", label: "阴影", value: 0, min: -100, max: 100, step: 1 },
    ],
  },
  {
    type: "curves",
    label: "曲线",
    category: "颜色",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [
      { key: "channel", label: "通道", value: "rgb" },
      { key: "strength", label: "强度", value: 100, min: 0, max: 100, step: 1 },
    ],
  },
  {
    type: "lut",
    label: "LUT",
    category: "颜色",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [
      { key: "file", label: "载入 LUT", value: "" },
      { key: "strength", label: "强度", value: 100, min: 0, max: 100, step: 1 },
    ],
  },
  {
    type: "keyer",
    label: "色度抠图",
    category: "抠像",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [
      { key: "keyColor", label: "键色", value: "#00FF00" },
      { key: "tolerance", label: "容差", value: 20, min: 0, max: 100, step: 1 },
      { key: "feather", label: "边缘羽化", value: 4, min: 0, max: 100, step: 1 },
      { key: "spill", label: "溢色抑制", value: 30, min: 0, max: 100, step: 1 },
      { key: "edge", label: "边缘收缩/扩展", value: 0, min: -50, max: 50, step: 1 },
      { key: "view", label: "视图", value: "result" },
    ],
  },
  {
    type: "mono",
    label: "单色",
    category: "颜色",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [
      { key: "grayscale", label: "转灰度", value: true },
      { key: "hue", label: "着色色相", value: 0, min: 0, max: 360, step: 1 },
      { key: "strength", label: "强度", value: 100, min: 0, max: 100, step: 1 },
    ],
  },

  // ---- 滤镜 ----
  {
    type: "blur",
    label: "模糊",
    category: "滤镜",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [
      { key: "radius", label: "半径", value: 12, min: 0, max: 100, step: 1 },
      { key: "type", label: "类型", value: "gaussian" },
    ],
  },
  {
    type: "sharpen",
    label: "锐化",
    category: "滤镜",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [
      { key: "strength", label: "强度", value: 50, min: 0, max: 200, step: 1 },
      { key: "radius", label: "半径", value: 3, min: 1, max: 50, step: 1 },
    ],
  },
  {
    type: "glow",
    label: "发光",
    category: "滤镜",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [
      { key: "threshold", label: "阈值", value: 70, min: 0, max: 100, step: 1 },
      { key: "radius", label: "半径", value: 24, min: 0, max: 200, step: 1 },
      { key: "strength", label: "强度", value: 60, min: 0, max: 200, step: 1 },
    ],
  },
  {
    type: "noise",
    label: "噪点",
    category: "滤镜",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [
      { key: "strength", label: "强度", value: 20, min: 0, max: 100, step: 1 },
      { key: "scale", label: "缩放", value: 1, min: 0.1, max: 10, step: 0.1 },
      { key: "speed", label: "动画速度", value: 0, min: 0, max: 10, step: 0.1 },
    ],
  },
  {
    type: "mosaic",
    label: "马赛克",
    category: "滤镜",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [{ key: "blockSize", label: "块大小", value: 16, min: 2, max: 200, step: 1 }],
  },

  // ---- 合成 / 图层 ----
  {
    type: "blend",
    label: "混合",
    category: "合成",
    addable: true,
    inputs: [
      { key: "base", label: "下层", dataType: "image" },
      { key: "top", label: "上层", dataType: "image" },
    ],
    outputs: [OUT],
    params: [
      { key: "mode", label: "混合模式", value: "normal" },
      { key: "opacity", label: "不透明度", value: 100, min: 0, max: 100, step: 1 },
    ],
  },
  {
    type: "mask",
    label: "遮罩",
    category: "合成",
    addable: true,
    inputs: [
      IN,
      { key: "mask", label: "遮罩", dataType: "mask" },
    ],
    outputs: [OUT],
    params: [
      { key: "invert", label: "反转", value: false },
      { key: "feather", label: "羽化", value: 0, min: 0, max: 100, step: 1 },
    ],
  },
  {
    type: "merge",
    label: "合并",
    category: "合成",
    addable: true,
    inputs: [
      { key: "in1", label: "输入 1", dataType: "image" },
      { key: "in2", label: "输入 2", dataType: "image" },
    ],
    outputs: [OUT],
    params: [{ key: "mode", label: "模式", value: "add" }],
  },
  {
    type: "opacity",
    label: "不透明度",
    category: "合成",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [
      { key: "opacity", label: "不透明度", value: 100, min: 0, max: 100, step: 1 },
    ],
  },

  // ---- 蒙版 / 形状遮罩（用户点名要，不准少）----
  {
    type: "maskShape",
    label: "形状蒙版",
    category: "蒙版",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [
      { key: "shape", label: "形状", value: "rect" },
      ...MASK_BASE,
    ],
  },
  {
    type: "maskPen",
    label: "钢笔蒙版",
    category: "蒙版",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [
      { key: "shape", label: "形状", value: "pen" },
      { key: "points", label: "路径点", value: 6, min: 3, max: 32, step: 1 },
      ...MASK_BASE,
    ],
  },
  {
    type: "maskTrack",
    label: "蒙版跟踪",
    category: "蒙版",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [
      { key: "shape", label: "形状", value: "track" },
      { key: "trackId", label: "追踪轨迹", value: "" },
      ...MASK_BASE,
    ],
  },

  // ---- 粒子系统（用户点名要，不准少）----
  {
    type: "particles",
    label: "粒子系统",
    category: "粒子",
    addable: true,
    inputs: [IN],
    outputs: [OUT],
    params: [
      { key: "emitter", label: "发射器", value: "point" },
      { key: "rate", label: "发射速率", value: 60, min: 0, max: 600, step: 1 },
      { key: "lifetime", label: "寿命（秒）", value: 2, min: 0.1, max: 20, step: 0.1 },
      { key: "speed", label: "初速度", value: 120, min: 0, max: 1000, step: 1 },
      { key: "direction", label: "方向", value: 90, min: 0, max: 360, step: 1 },
      { key: "spread", label: "扩散角", value: 30, min: 0, max: 360, step: 1 },
      { key: "gravity", label: "重力", value: 200, min: -1000, max: 1000, step: 1 },
      { key: "drag", label: "阻力", value: 0, min: 0, max: 10, step: 0.1 },
      { key: "turbulence", label: "湍流", value: 0, min: 0, max: 100, step: 1 },
      { key: "sizeStart", label: "初始尺寸", value: 20, min: 0, max: 500, step: 1 },
      { key: "sizeEnd", label: "最终尺寸", value: 0, min: 0, max: 500, step: 1 },
      { key: "opacityEnd", label: "最终透明度", value: 0, min: 0, max: 100, step: 1 },
      { key: "color", label: "颜色", value: "#57c08f" },
      { key: "blendMode", label: "混合模式", value: "normal" },
      { key: "maxParticles", label: "最大粒子数", value: 1000, min: 1, max: 100000, step: 1 },
      { key: "texture", label: "贴图", value: "" },
    ],
  },

  // ---- 输出 ----
  {
    type: "output",
    label: "输出",
    category: "输出",
    addable: false,
    inputs: [IN],
    outputs: [],
    params: [],
  },
];

/** 按类型取注册信息。 */
export function findEffect(type: string): EffectCatalogEntry | undefined {
  return EFFECT_CATALOG.find((entry) => entry.type === type);
}

/** 只取能加到片段上的效果（「+ 效果」菜单用）。 */
export function addableEffects(): EffectCatalogEntry[] {
  return EFFECT_CATALOG.filter((entry) => entry.addable);
}

/** 按分类分组，顺序照 EFFECT_CATEGORY_ORDER，空分类不出现。 */
export function effectsByCategory(): Array<{
  category: EffectCategory;
  effects: EffectCatalogEntry[];
}> {
  return EFFECT_CATEGORY_ORDER.map((category) => ({
    category,
    effects: EFFECT_CATALOG.filter((entry) => entry.category === category),
  })).filter((group) => group.effects.length > 0);
}
