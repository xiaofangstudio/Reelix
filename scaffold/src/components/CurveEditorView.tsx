/**
 * 曲线编辑器（图层式）。
 *
 * 横轴时间、纵轴参数值。每一条曲线 = 某个效果某个参数的关键帧序列，
 * 曲线形状由关键帧的缓动预设决定（evaluateCurve 内部走三次贝塞尔，
 * 与 Rust 侧 keyframe/curve.rs 同算法），所以这里画出来的是「真实的取景」，
 * 不是装饰性折线。
 *
 * 关键帧是可拖拽的菱形点，支持框选后整体平移。刻意不引入 three / chart，
 * 只用原生 SVG + 指针事件，保证依赖不膨胀。
 *
 * 与效果栈共用 store 里的同一份 effectKeyframes：效果栈的秒表点亮、数值框拖动，
 * 这里立刻多出一条曲线；这里拖点，效果栈的数值也跟着变。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useAppStore, useCurrentSequence } from "../store/appStore";
import type { Effect, EffectKeyframe } from "../types/effect";
import type { Keyframe } from "../types/keyframe";
import type { Id } from "../types/project";
import { evaluateCurve } from "../core/curveEval";
import { msToShort, msToTimecode } from "../core/timecode";

/**
 * 曲线配色。全部落在「浅绿 + 中性灰」families 内，不引入第二强调色、不出现紫色。
 * 第一条永远是主强调色，方便一眼找到当前焦点曲线。
 */
const CURVE_COLORS = [
  "var(--rl-accent)",
  "var(--rl-accent-fill)",
  "var(--rl-text-dim)",
  "var(--rl-text-mute)",
];

/** 绘图区留白：顶部留一条标尺带，底部留给时间标签，左侧留给数值标签。 */
const PAD = { left: 46, right: 16, top: 20, bottom: 22 };

/** 一条待绘制的曲线。 */
interface CurveGroup {
  effectId: Id;
  param: string;
  /** 「效果名 · 参数名」，图例与提示都用它 */
  label: string;
  keyframes: EffectKeyframe[];
  color: string;
}

type Drag =
  | {
      mode: "kf";
      startX: number;
      startY: number;
      origins: Map<Id, { timeMs: number; value: number }>;
      moved: boolean;
    }
  | { mode: "box"; startX: number; startY: number }
  | { mode: "scrub" }
  | null;

export function CurveEditorView() {
  const sequence = useCurrentSequence();
  const effects = useAppStore((s) => s.effects);
  const effectKeyframes = useAppStore((s) => s.effectKeyframes);
  const selectedClipId = useAppStore((s) => s.selectedClipId);
  const selectedKeyframeIds = useAppStore((s) => s.selectedKeyframeIds);
  const playheadMs = useAppStore((s) => s.playheadMs);
  const setPlayhead = useAppStore((s) => s.setPlayhead);
  const selectEffect = useAppStore((s) => s.selectEffect);
  const updateEffectKeyframes = useAppStore((s) => s.updateEffectKeyframes);
  const setSelectedKeyframeIds = useAppStore((s) => s.setSelectedKeyframeIds);

  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<Drag>(null);
  const boxRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const [box, setBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // 拖点期间冻结纵轴值域，避免「点动 → 值域跟着动 → 点又移位」的反馈抖动
  const [frozen, setFrozen] = useState<[number, number] | null>(null);

  // 容器尺寸变化时重新测量，SVG 用 1:1 像素坐标，拖拽换算才准
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 没有工程时退化成 0 时长 / 25 帧，曲线区仍可打开，只是没有时间基准
  const durationMs = sequence?.durationMs ?? 0;
  const frameRate = sequence?.frameRate ?? 25;

  // 只画当前选中片段的效果曲线；没选片段时退化成「全项目」，仍可用
  const groups = useMemo<CurveGroup[]>(() => {
    const visible: Effect[] = selectedClipId
      ? effects[selectedClipId] ?? []
      : Object.keys(effects).reduce<Effect[]>((acc, key) => acc.concat(effects[key]), []);
    const byId = new Map<Id, Effect>();
    visible.forEach((fx) => byId.set(fx.id, fx));

    const map = new Map<string, CurveGroup>();
    for (const kf of effectKeyframes) {
      const fx = byId.get(kf.effectId);
      if (!fx) continue;
      const key = `${kf.effectId}:${kf.param}`;
      let g = map.get(key);
      if (!g) {
        const param = fx.params.find((p) => p.key === kf.param);
        g = {
          effectId: kf.effectId,
          param: kf.param,
          label: `${fx.name} · ${param?.label ?? kf.param}`,
          keyframes: [],
          color: CURVE_COLORS[0],
        };
        map.set(key, g);
      }
      g.keyframes.push(kf);
    }

    const arr = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
    arr.forEach((g, i) => {
      g.color = CURVE_COLORS[i % CURVE_COLORS.length];
      g.keyframes.sort((a, b) => a.timeMs - b.timeMs);
    });
    return arr;
  }, [effects, effectKeyframes, selectedClipId]);

  // 纵轴值域：按可见关键帧自动适配，并左右各留 12% 余量
  const autoDomain = useMemo<[number, number]>(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const g of groups) {
      for (const k of g.keyframes) {
        lo = Math.min(lo, k.value);
        hi = Math.max(hi, k.value);
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 100];
    if (hi - lo < 1e-6) {
      const pad = Math.max(1, Math.abs(hi) * 0.5);
      return [lo - pad, hi + pad];
    }
    const pad = (hi - lo) * 0.12;
    return [lo - pad, hi + pad];
  }, [groups]);

  const [vMin, vMax] = frozen ?? autoDomain;
  const vSpan = vMax - vMin || 1;

  const plotW = Math.max(0, size.w - PAD.left - PAD.right);
  const plotH = Math.max(0, size.h - PAD.top - PAD.bottom);
  const ready = plotW > 0 && plotH > 0;

  const xOf = (t: number) => PAD.left + (t / durationMs) * plotW;
  const yOf = (v: number) => PAD.top + plotH - ((v - vMin) / vSpan) * plotH;
  const timeOf = (x: number) => ((x - PAD.left) / plotW) * durationMs;

  const keyframesById = useMemo(() => {
    const m = new Map<Id, EffectKeyframe>();
    effectKeyframes.forEach((k) => m.set(k.id, k));
    return m;
  }, [effectKeyframes]);

  const visibleKfIds = useMemo(() => {
    const s = new Set<Id>();
    groups.forEach((g) => g.keyframes.forEach((k) => s.add(k.id)));
    return s;
  }, [groups]);

  const selectedKfSet = useMemo(() => new Set(selectedKeyframeIds), [selectedKeyframeIds]);

  const toLocal = (e: ReactPointerEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onKfPointerDown = (kf: EffectKeyframe) => (e: ReactPointerEvent) => {
    e.stopPropagation();
    if (!ready) return;
    svgRef.current?.setPointerCapture(e.pointerId);
    const { x, y } = toLocal(e);

    // 点已选中的点 = 拖动整组；点未选中的点 = 只拖它自己
    const already = selectedKfSet.has(kf.id);
    const ids = already ? selectedKeyframeIds : [kf.id];
    if (!already) setSelectedKeyframeIds([kf.id]);
    selectEffect(kf.effectId);

    const origins = new Map<Id, { timeMs: number; value: number }>();
    ids.forEach((id) => {
      const k = keyframesById.get(id);
      if (k) origins.set(id, { timeMs: k.timeMs, value: k.value });
    });
    if (!origins.has(kf.id)) origins.set(kf.id, { timeMs: kf.timeMs, value: kf.value });

    setFrozen([vMin, vMax]);
    dragRef.current = { mode: "kf", startX: x, startY: y, origins, moved: false };
  };

  const onBgPointerDown = (e: ReactPointerEvent) => {
    if (!ready) return;
    svgRef.current?.setPointerCapture(e.pointerId);
    const { x, y } = toLocal(e);
    boxRef.current = { x1: x, y1: y, x2: x, y2: y };
    setBox(boxRef.current);
    dragRef.current = { mode: "box", startX: x, startY: y };
  };

  const onRulerPointerDown = (e: ReactPointerEvent) => {
    if (!ready) return;
    svgRef.current?.setPointerCapture(e.pointerId);
    const { x } = toLocal(e);
    setPlayhead(clamp(timeOf(x), 0, durationMs));
    dragRef.current = { mode: "scrub" };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d || !ready) return;
    const { x, y } = toLocal(e);

    if (d.mode === "kf") {
      const dx = x - d.startX;
      const dy = y - d.startY;
      if (!d.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      d.moved = true;
      const dt = (dx / plotW) * durationMs;
      const dv = -(dy / plotH) * vSpan;
      const updates: Array<{ id: Id; timeMs: number; value: number }> = [];
      d.origins.forEach((o, id) => {
        updates.push({
          id,
          timeMs: clamp(o.timeMs + dt, 0, durationMs),
          value: clamp(o.value + dv, vMin, vMax),
        });
      });
      updateEffectKeyframes(updates);
      return;
    }

    if (d.mode === "box") {
      boxRef.current = { x1: d.startX, y1: d.startY, x2: x, y2: y };
      setBox(boxRef.current);
      return;
    }

    if (d.mode === "scrub") {
      setPlayhead(clamp(timeOf(x), 0, durationMs));
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;

    if (d.mode === "box") {
      const b = boxRef.current;
      if (b) {
        const x1 = Math.min(b.x1, b.x2);
        const x2 = Math.max(b.x1, b.x2);
        const y1 = Math.min(b.y1, b.y2);
        const y2 = Math.max(b.y1, b.y2);
        // 微小位移视作「点空白」= 清空选择，不作为框选
        if (x2 - x1 > 3 || y2 - y1 > 3) {
          const ids: Id[] = [];
          for (const kf of effectKeyframes) {
            if (!visibleKfIds.has(kf.id)) continue;
            const px = xOf(kf.timeMs);
            const py = yOf(kf.value);
            if (px >= x1 && px <= x2 && py >= y1 && py <= y2) ids.push(kf.id);
          }
          setSelectedKeyframeIds(ids);
        } else {
          setSelectedKeyframeIds([]);
        }
      }
      boxRef.current = null;
      setBox(null);
    }

    if (d.mode === "kf") setFrozen(null);

    dragRef.current = null;
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // 指针已释放，忽略
    }
  };

  // ---- 刻度 ----
  const timeStep = niceStep(durationMs, 10);
  const timeTicks: number[] = [];
  for (let t = 0; t <= durationMs + 1; t += timeStep) timeTicks.push(Math.min(t, durationMs));

  const valueTicks: number[] = [];
  for (let i = 0; i <= 4; i++) valueTicks.push(vMin + (vSpan * i) / 4);

  const hasSelection = groups.length > 0;

  return (
    <div className="ce-wrap">
      <div className="ce-toolbar">
        <span className="ce-title">曲线编辑器</span>
        <div className="ce-legend">
          {groups.map((g) => (
            <button
              key={`${g.effectId}:${g.param}`}
              type="button"
              className="ce-legend-item"
              title={`定位到效果：${g.label}`}
              onClick={() => selectEffect(g.effectId)}
            >
              <span className="ce-swatch" style={{ background: g.color }} />
              {g.label}
            </button>
          ))}
          {groups.length === 0 && (
            <span className="ce-legend-empty">
              当前图层没有打了关键帧的参数，点亮效果栈里的秒表即可生成曲线
            </span>
          )}
        </div>
        <span className="ce-timecode num">{msToTimecode(playheadMs, frameRate)}</span>
      </div>

      <div className="ce-stage" ref={stageRef}>
        {ready && (
          <svg
            ref={svgRef}
            className="ce-svg"
            width={size.w}
            height={size.h}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* 标尺带：点击 / 拖动即移动播放头 */}
            <rect
              className="ce-ruler-hit"
              x={0}
              y={0}
              width={size.w}
              height={PAD.top}
              onPointerDown={onRulerPointerDown}
            />

            {/* 横向值刻度线 + 左侧数值标签 */}
            {valueTicks.map((v, i) => {
              const y = yOf(v);
              return (
                <g key={`v${i}`}>
                  <line
                    className="ce-grid"
                    x1={PAD.left}
                    y1={y}
                    x2={PAD.left + plotW}
                    y2={y}
                  />
                  <text className="ce-axis-label" x={PAD.left - 6} y={y} textAnchor="end" dominantBaseline="middle">
                    {fmtNum(v)}
                  </text>
                </g>
              );
            })}

            {/* 纵向时间刻度线 + 底部时间标签 */}
            {timeTicks.map((t, i) => {
              const x = xOf(t);
              return (
                <g key={`t${i}`}>
                  <line className="ce-grid" x1={x} y1={PAD.top} x2={x} y2={PAD.top + plotH} />
                  <text
                    className="ce-axis-label"
                    x={x}
                    y={PAD.top + plotH + 14}
                    textAnchor="middle"
                  >
                    {msToShort(t)}
                  </text>
                </g>
              );
            })}

            {/* 绘图区背景：框选与清空选择都在这里起手 */}
            <rect
              className="ce-plot-hit"
              x={PAD.left}
              y={PAD.top}
              width={plotW}
              height={plotH}
              onPointerDown={onBgPointerDown}
            />

            {/* 曲线本体：按缓动预设密集采样，折线肉眼即平滑 */}
            {groups.map((g) => (
              <path
                key={`c:${g.effectId}:${g.param}`}
                className="ce-curve"
                d={buildPath(g.keyframes, durationMs, xOf, yOf)}
                stroke={g.color}
              />
            ))}

            {/* 播放头 */}
            <line
              className="ce-playhead"
              x1={xOf(playheadMs)}
              y1={PAD.top}
              x2={xOf(playheadMs)}
              y2={PAD.top + plotH}
            />

            {/* 关键帧菱形点 */}
            {groups.map((g) =>
              g.keyframes.map((kf) => {
                const cx = xOf(kf.timeMs);
                const cy = yOf(kf.value);
                const on = selectedKfSet.has(kf.id);
                return (
                  <g
                    key={kf.id}
                    className={`ce-kf${on ? " selected" : ""}`}
                    onPointerDown={onKfPointerDown(kf)}
                  >
                    <circle className="ce-kf-hit" cx={cx} cy={cy} r={9} />
                    <polygon
                      className="ce-kf-diamond"
                      points={`${cx},${cy - 5} ${cx + 5},${cy} ${cx},${cy + 5} ${cx - 5},${cy}`}
                      style={on ? undefined : { stroke: g.color }}
                    />
                  </g>
                );
              })
            )}

            {/* 框选矩形 */}
            {box && (
              <rect
                className="ce-box"
                x={Math.min(box.x1, box.x2)}
                y={Math.min(box.y1, box.y2)}
                width={Math.abs(box.x2 - box.x1)}
                height={Math.abs(box.y2 - box.y1)}
              />
            )}
          </svg>
        )}

        {!hasSelection && (
          <div className="ce-empty">
            <div className="main-text">暂无可编辑的曲线</div>
            <div className="sub-text">
              在时间线上选中片段，再到效果栈点亮参数左侧的秒表，曲线就会出现在这里
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 把一条曲线按时间域密集采样成 SVG 路径。
 * 采样点直接喂给 evaluateCurve，所以画出来的就是引擎真实取的贝塞尔缓动值；
 * 首尾之外按引擎语义保持端点值（不外推）。
 */
function buildPath(
  keyframes: EffectKeyframe[],
  durationMs: number,
  xOf: (t: number) => number,
  yOf: (v: number) => number
): string {
  if (keyframes.length === 0) return "";
  const mapped: Keyframe[] = keyframes.map((k) => ({
    id: k.id,
    targetId: k.effectId,
    param: k.param,
    timeMs: k.timeMs,
    value: k.value,
    easing: k.easing,
    inTangent: k.inTangent,
    outTangent: k.outTangent,
  }));

  const samples = 160;
  let d = "";
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * durationMs;
    const v = evaluateCurve(mapped, t) ?? 0;
    const x = xOf(t);
    const y = yOf(v);
    d += i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d;
}

/** 取一个「整齐」的刻度间隔，让时间轴刻度落在 1/2/5 × 10^n 上。 */
function niceStep(span: number, target: number): number {
  if (span <= 0) return 1000;
  const raw = span / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * pow;
}

/** 数值标签：跨度大不显示小数，跨度小才给一位。 */
function fmtNum(n: number): string {
  const a = Math.abs(n);
  if (a >= 100) return n.toFixed(0);
  if (a >= 10) return n.toFixed(1);
  if (a >= 1) return n.toFixed(2);
  return n.toFixed(3);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
