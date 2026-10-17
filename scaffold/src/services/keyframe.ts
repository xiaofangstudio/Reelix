/**
 * 关键帧服务。
 *
 * 一套关键帧引擎同时服务剪辑层与合成层：片段参数与节点参数走的是同一批命令。
 * 前端只负责发命令与显示，曲线求值的权威实现与预览在 Rust 侧。
 */

import { invoke } from "@tauri-apps/api/core";
import type { EasingPreset, Keyframe } from "../types/keyframe";

/** 在某时刻打一个关键帧，已存在则覆盖 */
export function setKeyframe(
  targetId: string,
  param: string,
  timeMs: number,
  value: number
): Promise<Keyframe> {
  return invoke<Keyframe>("set_keyframe", { targetId, param, timeMs, value });
}

/** 删除关键帧 */
export function removeKeyframe(keyframeId: string): Promise<boolean> {
  return invoke<boolean>("remove_keyframe", { keyframeId });
}

/** 移动关键帧的时间与值 */
export function moveKeyframe(
  keyframeId: string,
  timeMs: number,
  value: number
): Promise<boolean> {
  return invoke<boolean>("move_keyframe", { keyframeId, timeMs, value });
}

/** 调整贝塞尔手柄 */
export function setCurveTangent(
  keyframeId: string,
  side: "in" | "out",
  x: number,
  y: number
): Promise<boolean> {
  return invoke<boolean>("set_curve_tangent", { keyframeId, side, x, y });
}

/** 套用缓动预设 */
export function setEasingPreset(
  keyframeId: string,
  preset: EasingPreset
): Promise<boolean> {
  return invoke<boolean>("set_easing_preset", { keyframeId, preset });
}

/** 求某时刻的参数值，用于属性面板实时回显 */
export function evaluateParam(
  targetId: string,
  param: string,
  timeMs: number
): Promise<number> {
  return invoke<number>("evaluate_param", { targetId, param, timeMs });
}
