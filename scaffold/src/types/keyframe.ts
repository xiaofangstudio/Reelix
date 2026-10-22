/**
 * 关键帧数据模型。
 *
 * 一套关键帧引擎同时服务于剪辑层与合成层：
 * 片段的透明度能打关键帧，节点的模糊半径也能打关键帧，
 * 用的是同一个 Keyframe 结构、同一个曲线引擎、同一个曲线编辑器。
 * 详见 docs/04-剪辑与特效融合设计.md 第三节。
 */

import type { Id } from "./project";

export type EasingPreset =
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "bounce"
  | "elastic"
  | "bounce-in"
  | "bounce-out"
  | "bounce-in-out"
  | "elastic-in"
  | "elastic-out"
  | "elastic-in-out"
  | (string & {});

export interface Keyframe {
  id: Id;
  /** 片段 id 或节点 id，两者共用 */
  targetId: Id;
  param: string;
  timeMs: number;
  value: number;
  easing: EasingPreset;
  inTangent: { x: number; y: number };
  outTangent: { x: number; y: number };
}

export interface Curve {
  targetId: Id;
  param: string;
  /** 按 timeMs 升序 */
  keyframes: Keyframe[];
}