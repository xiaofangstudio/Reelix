/**
 * 节点类型注册表（前端侧）。
 *
 * 与 Rust 侧 `commands::graph::get_node_catalog` 返回的结构一致：
 * 前端拿它做出「+ 效果」菜单、分类配色与默认参数回填。M0/M1 阶段先在前端保留一份，
 * 保证界面在没有后端时也能渲染；后端接上后按 `type` 合并即可。
 *
 * 效果类节点**不在这里另写一遍**——直接由 `core/effectCatalog.ts` 派生，
 * 保证「+ 效果」菜单、效果栈卡片、内部节点注册表三者永远同源。
 * 这里只额外补上三个非效果的节点：3D 合成、摄像机、复合片段。
 *
 * 摄像机参数与 3D 规则见 docs/09-3D摄像机与素材库.md 第 2.3、2.4 节。
 */

import type { NodeCategory, NodeTypeInfo } from "../types/graph";
import type { EffectParamSpec } from "./effectCatalog";
import { EFFECT_CATALOG } from "./effectCatalog";
import { CAMERA_DEFAULTS } from "../types/project";
import type { ParamValue } from "../types/graph";

/** 分类 → 英文短名，用于给节点卡片加 CSS 类（避免中文类名）。 */
export const CATEGORY_SLUG: Record<NodeCategory, string> = {
  输入: "input",
  变换: "transform",
  颜色: "color",
  滤镜: "filter",
  抠像: "key",
  蒙版: "mask",
  粒子: "particle",
  合成: "composite",
  摄像机: "camera",
  输出: "output",
};

/** 把效果参数规格折叠成「参数名 → 默认值」。 */
function paramDefaults(params: EffectParamSpec[]): Record<string, ParamValue> {
  const defaults: Record<string, ParamValue> = {};
  for (const p of params) {
    defaults[p.key] = p.value;
  }
  return defaults;
}

/** 效果清单派生出的节点：插槽与默认参数一份不落。 */
const EFFECT_NODES: NodeTypeInfo[] = EFFECT_CATALOG.map((effect) => ({
  type: effect.type,
  label: effect.label,
  category: effect.category,
  inputs: effect.inputs.map((plug) => ({ ...plug })),
  outputs: effect.outputs.map((plug) => ({ ...plug })),
  defaults: paramDefaults(effect.params),
}));

/** 非效果类的结构 / 3D 节点。 */
const EXTRA_NODES: NodeTypeInfo[] = [
  {
    type: "composite3d",
    label: "3D 合成",
    category: "合成",
    // 输入来自勾选了「启用 3D」的图层节点，其插槽带 is3D 标记
    inputs: [
      { key: "layer1", label: "3D 图层 1", dataType: "image" },
      { key: "layer2", label: "3D 图层 2", dataType: "image" },
      { key: "layer3", label: "3D 图层 3", dataType: "image" },
    ],
    outputs: [{ key: "out", label: "3D 场景", dataType: "image" }],
    defaults: { zSort: true },
  },
  {
    type: "camera",
    label: "摄像机",
    category: "摄像机",
    inputs: [{ key: "scene", label: "3D 场景", dataType: "image" }],
    outputs: [{ key: "out", label: "画面", dataType: "image" }],
    // 参数表见 docs/09 第 2.3 节，默认值取自 types/project.ts 的 CAMERA_DEFAULTS
    defaults: { ...CAMERA_DEFAULTS },
  },
  {
    type: "compound",
    label: "复合片段",
    category: "合成",
    inputs: [{ key: "in", label: "输入", dataType: "image" }],
    outputs: [{ key: "out", label: "输出", dataType: "image" }],
    defaults: {},
  },
];

/** 内置节点类型：效果类 + 结构 / 3D 类。 */
export const NODE_CATALOG: NodeTypeInfo[] = [...EFFECT_NODES, ...EXTRA_NODES];

/** 按类型取注册信息。 */
export function findNodeType(type: string): NodeTypeInfo | undefined {
  return NODE_CATALOG.find((info) => info.type === type);
}

/** 按类型取分类短名，取不到时归到「输入」。 */
export function categorySlugOf(type: string): string {
  const info = findNodeType(type);
  return info ? CATEGORY_SLUG[info.category] : "input";
}
