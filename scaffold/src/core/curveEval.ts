/**
 * 曲线求值。前端这份与 Rust 侧 keyframe/curve.rs 的算法必须一致，
 * 否则拖动播放头时前端预览的数值会和实际渲染结果对不上。
 */

import type { Keyframe } from "../types/keyframe";

/** 缓动预设 → 三次贝塞尔控制点，与 CSS 的 cubic-bezier 同构 */
const EASING_TANGENTS: Record<string, [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
  bounce: [0.34, 1.56, 0.64, 1],
  elastic: [0.22, 1.4, 0.36, 1],
};

/** 求某时刻的参数值。keyframes 必须按 timeMs 升序 */
export function evaluateCurve(keyframes: Keyframe[], timeMs: number): number | null {
  if (keyframes.length === 0) return null;
  if (keyframes.length === 1) return keyframes[0].value;

  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];

  // 曲线两端之外保持端点值，不外推
  if (timeMs <= first.timeMs) return first.value;
  if (timeMs >= last.timeMs) return last.value;

  const i = findSegment(keyframes, timeMs);
  const a = keyframes[i];
  const b = keyframes[i + 1];

  const span = b.timeMs - a.timeMs;
  if (span <= 0) return b.value;

  const t = (timeMs - a.timeMs) / span;
  const eased = applyEasing(t, a.easing);
  return a.value + (b.value - a.value) * eased;
}

function findSegment(keyframes: Keyframe[], timeMs: number): number {
  let lo = 0;
  let hi = keyframes.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keyframes[mid].timeMs <= timeMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 把归一化时间 t 按缓动预设映射成缓动后的进度 */
function applyEasing(t: number, easing: string): number {
  const c = EASING_TANGENTS[easing] ?? EASING_TANGENTS.linear;
  return cubicBezierY(c[0], c[1], c[2], c[3], t);
}

/**
 * 给定 x 求三次贝塞尔的 y。
 * 用牛顿迭代 + 二分兜底，20 次迭代足够到 1e-6。
 */
function cubicBezierY(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const sampleX = (t: number) => bezier(t, 0, x1, x2, 1);
  const sampleY = (t: number) => bezier(t, 0, y1, y2, 1);
  const sampleDx = (t: number) =>
    3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);

  let t = x;
  for (let i = 0; i < 8; i++) {
    const dx = sampleX(t) - x;
    if (Math.abs(dx) < 1e-6) return sampleY(t);
    const d = sampleDx(t);
    if (Math.abs(d) < 1e-6) break;
    t -= dx / d;
  }

  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 20; i++) {
    const cur = sampleX(t);
    if (Math.abs(cur - x) < 1e-6) break;
    if (cur < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return sampleY(t);
}

function bezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const mt = 1 - t;
  return (
    mt * mt * mt * p0 +
    3 * mt * mt * t * p1 +
    3 * mt * t * t * p2 +
    t * t * t * p3
  );
}

/** 在某时刻插入或更新关键帧，返回新的升序数组 */
export function upsertKeyframe(
  keyframes: Keyframe[],
  next: Keyframe,
  toleranceMs = 1
): Keyframe[] {
  const hit = keyframes.findIndex(
    (k) => k.param === next.param && Math.abs(k.timeMs - next.timeMs) <= toleranceMs
  );
  const out = keyframes.slice();
  if (hit >= 0) out[hit] = { ...out[hit], ...next, id: out[hit].id };
  else out.push(next);
  return out.sort((a, b) => a.timeMs - b.timeMs);
}