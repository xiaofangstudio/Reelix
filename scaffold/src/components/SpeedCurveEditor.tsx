/**
 * 曲线变速编辑器（剪映同款）。
 *
 * 横轴 = 片段内时刻（0 ~ 片段时长），纵轴 = 倍速（0.1× ~ 4×），
 * 两点之间线性插值。拖圆点改速度；空白处双击加点；圆点上双击删点
 * （至少保留两个，否则退化成恒定速度）。
 *
 * 所有改动都落后端（set_clip_speed_curve）再回拉快照——
 * 片段时长会按曲线积分重算，时间线上的占位随之变长/变短。
 */

import { useCallback, useRef, useState } from "react";
import type { Clip, SpeedKey } from "../types/project";
import { setClipSpeedCurve } from "../services/timeline";
import { refreshProject } from "../store/projectActions";
import { useAppStore } from "../store/appStore";

/** 与速度滑条同档：0.1× ~ 4× */
const SPEED_MIN = 0.1;
const SPEED_MAX = 4;

/** 剪映式预设：名字 + 关键点（tMs 由调用方按片段时长缩放） */
const PRESETS: Array<{ name: string; keys: Array<[number, number]> }> = [
  { name: "子弹时间", keys: [[0, 1], [0.5, 0.2], [1, 1]] },
  { name: "英雄时刻", keys: [[0, 1], [0.5, 3], [1, 1]] },
  { name: "蒙太奇", keys: [[0, 0.5], [0.25, 2], [0.5, 0.5], [0.75, 2], [1, 0.5]] },
  { name: "跳接", keys: [[0, 1], [0.25, 3], [0.5, 1], [0.75, 3], [1, 1]] },
];

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 把片段的当前曲线取成可编辑状态；没有曲线时摊成恒速两点。 */
function editableCurve(clip: Clip): SpeedKey[] {
  const dur = Math.max(1, clip.durationMs);
  const keys = clip.speedCurve;
  if (keys && keys.length >= 2) {
    return keys.map((k) => ({ ...k }));
  }
  const s = clamp(clip.speed || 1, SPEED_MIN, SPEED_MAX);
  return [
    { tMs: 0, speed: s },
    { tMs: dur, speed: s },
  ];
}

export function SpeedCurveEditor({ clip }: { clip: Clip }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const hasCurve = !!clip.speedCurve && clip.speedCurve.length >= 2;
  const [draft, setDraft] = useState<SpeedKey[]>(() => editableCurve(clip));

  // 换片段时重置草稿
  const clipKey = `${clip.id}:${clip.durationMs}`;
  const lastKeyRef = useRef(clipKey);
  if (lastKeyRef.current !== clipKey) {
    lastKeyRef.current = clipKey;
    setDraft(editableCurve(clip));
    setDragIdx(null);
  }

  const dur = Math.max(1, clip.durationMs);
  const W = 100;
  const H = 34;
  const padY = 4;
  const xOf = (tMs: number) => (tMs / dur) * W;
  const yOf = (speed: number) =>
    H - padY - ((clamp(speed, SPEED_MIN, SPEED_MAX) - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)) * (H - padY * 2);
  const speedOfY = (y: number) =>
    SPEED_MIN + ((H - padY - y) / (H - padY * 2)) * (SPEED_MAX - SPEED_MIN);

  const commit = useCallback(
    async (keys: SpeedKey[]) => {
      setDraft(keys);
      try {
        await setClipSpeedCurve(clip.id, keys);
        await refreshProject();
      } catch (err) {
        useAppStore.getState().pushNotice("error", err instanceof Error ? err.message : String(err));
      }
    },
    [clip.id]
  );

  /** 指针坐标 → SVG 用户坐标 */
  const toLocal = (e: PointerEvent | React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    };
  };

  const onPointDown = (idx: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragIdx(idx);
    const move = (ev: PointerEvent) => {
      const { x, y } = toLocal(ev);
      setDraft((prev) =>
        prev.map((k, i) =>
          i === idx
            ? { tMs: clamp((x / W) * dur, 0, dur), speed: clamp(speedOfY(y), SPEED_MIN, SPEED_MAX) }
            : k
        )
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragIdx(null);
      // 松手才落盘：拖的过程中不打断后端
      setDraft((prev) => {
        const sorted = [...prev].sort((a, b) => a.tMs - b.tMs);
        void commit(sorted);
        return sorted;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onCanvasDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = toLocal(e.nativeEvent as unknown as PointerEvent);
    const tMs = clamp((x / W) * dur, 0, dur);
    const speed = clamp(speedOfY(y), SPEED_MIN, SPEED_MAX);
    const next = [...draft, { tMs, speed }].sort((a, b) => a.tMs - b.tMs);
    void commit(next);
  };

  const onPointDoubleClick = (idx: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (draft.length <= 2) return; // 至少留两个点
    const next = draft.filter((_, i) => i !== idx);
    void commit(next);
  };

  const applyPreset = (keys: Array<[number, number]>) => {
    const next = keys.map(([r, s]) => ({ tMs: r * dur, speed: clamp(s, SPEED_MIN, SPEED_MAX) }));
    void commit(next);
  };

  const clearCurve = () => {
    void (async () => {
      try {
        await setClipSpeedCurve(clip.id, null);
        await refreshProject();
      } catch (err) {
        useAppStore.getState().pushNotice("error", err instanceof Error ? err.message : String(err));
      }
    })();
  };

  const linePath = draft
    .map((k, i) => `${i === 0 ? "M" : "L"}${xOf(k.tMs).toFixed(2)},${yOf(k.speed).toFixed(2)}`)
    .join(" ");

  return (
    <div className="speed-curve">
      <div className="prop-row" style={{ gridTemplateColumns: "auto 1fr auto" }}>
        <span className="label">曲线变速</span>
        <span className="prop-hint">
          {hasCurve ? "折线变速中" : "未启用（恒定速度）"}
        </span>
        {hasCurve && (
          <button type="button" className="ctl-btn" onClick={clearCurve} title="删掉曲线，回到恒定速度">
            清除
          </button>
        )}
      </div>

      <svg
        ref={svgRef}
        className="speed-curve-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onDoubleClick={onCanvasDoubleClick}
      >
        {/* 网格：1× 基准线 + 上下各一条 */}
        <line x1={0} y1={yOf(1)} x2={W} y2={yOf(1)} className="speed-curve-base" />
        <line x1={0} y1={yOf(SPEED_MIN)} x2={W} y2={yOf(SPEED_MIN)} className="speed-curve-grid" />
        <line x1={0} y1={yOf(SPEED_MAX)} x2={W} y2={yOf(SPEED_MAX)} className="speed-curve-grid" />
        <line x1={0} y1={yOf(2)} x2={W} y2={yOf(2)} className="speed-curve-grid" />
        {/* 变速折线 */}
        <path d={linePath} className="speed-curve-line" />
        {/* 关键点 */}
        {draft.map((k, i) => (
          <circle
            key={`${clip.id}-${i}`}
            cx={xOf(k.tMs)}
            cy={yOf(k.speed)}
            r={dragIdx === i ? 1.6 : 1.2}
            className={`speed-curve-kf${dragIdx === i ? " dragging" : ""}`}
            onPointerDown={onPointDown(i)}
            onDoubleClick={onPointDoubleClick(i)}
          />
        ))}
      </svg>

      <div className="speed-curve-scale">
        <span>0.1×</span>
        <span>1×</span>
        <span>4×</span>
      </div>

      <div className="speed-curve-presets">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            className="ctl-btn"
            onClick={() => applyPreset(p.keys)}
            title={`套用「${p.name}」速度曲线`}
          >
            {p.name}
          </button>
        ))}
      </div>

      <div className="prop-hint speed-curve-tip">
        双击曲线空白处加点，双击圆点删点；片段时长随曲线积分自动重算。
      </div>
    </div>
  );
}
