/**
 * 效果栈（图层式）。
 *
 * 选中片段时出现：一片段 = 一个图层，效果从上到下依次叠加，没有连线。
 * 每张效果是一张可折叠卡片：拖拽把手改序、旁路开关、参数行。
 * 参数行的数值框支持鼠标左右拖动调值（Shift 微调）；左侧秒表点亮即打关键帧，
 * 曲线编辑器里会立刻多出一条对应曲线——两侧共用 store 里的同一份关键帧数据。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useAppStore, useSelectedClip } from "../store/appStore";
import type { Effect, EffectKeyframe, EffectParam, EffectParamValue } from "../types/effect";
import type { Id } from "../types/project";
import type { Keyframe } from "../types/keyframe";
import { IconKeyframe } from "./icons";
import { evaluateCurve } from "../core/curveEval";
import { effectsByCategory } from "../core/effectCatalog";

/**
 * 「+ 效果」菜单：按分类分组，范围照 docs/02 第 D3 节的效果清单。
 * 只列能加到片段上的效果；序列 / 片段 / 输出是结构性节点，不出现在这里。
 */
const EFFECT_MENU = effectsByCategory()
  .map((group) => ({
    category: group.category,
    options: group.effects.filter((effect) => effect.addable),
  }))
  .filter((group) => group.options.length > 0);

/** 一张效果预设：参数键 → 参数值。按效果类型分组存，同类效果可互通。 */
type ParamPreset = Record<string, EffectParamValue>;

const PRESET_KEY = "reelix:fx-presets";

function loadPresets(): Record<string, ParamPreset> {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, ParamPreset>;
  } catch {
    // 本地存储损坏时当作没有预设，不打断效果栈
  }
  return {};
}

export function EffectStack() {
  const clip = useSelectedClip();
  const effects = useAppStore((s) => s.effects);
  const selectedEffectId = useAppStore((s) => s.selectedEffectId);
  const selectEffect = useAppStore((s) => s.selectEffect);
  const addEffect = useAppStore((s) => s.addEffect);
  const removeEffect = useAppStore((s) => s.removeEffect);
  const toggleEffectBypass = useAppStore((s) => s.toggleEffectBypass);
  const toggleEffectCollapsed = useAppStore((s) => s.toggleEffectCollapsed);
  const reorderEffects = useAppStore((s) => s.reorderEffects);
  const setAllEffectsCollapsed = useAppStore((s) => s.setAllEffectsCollapsed);
  const resetEffect = useAppStore((s) => s.resetEffect);
  const setEffectParam = useAppStore((s) => s.setEffectParam);
  const toggleEffectParamAnimation = useAppStore((s) => s.toggleEffectParamAnimation);
  const pushNotice = useAppStore((s) => s.pushNotice);

  // 拖拽改序时记录来源下标
  const dragFrom = useRef<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // 效果预设：右键卡片保存 / 应用 / 清除（EC 参考 的 effect preset 做法）
  const [presets, setPresets] = useState<Record<string, ParamPreset>>(loadPresets);
  const [ctx, setCtx] = useState<{ x: number; y: number; effect: Effect } | null>(null);

  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtx(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctx]);

  const writePresets = (next: Record<string, ParamPreset>) => {
    setPresets(next);
    try {
      localStorage.setItem(PRESET_KEY, JSON.stringify(next));
    } catch {
      pushNotice("error", "预设写入本地存储失败");
    }
  };

  const savePreset = (fx: Effect) => {
    const values: ParamPreset = {};
    for (const p of fx.params) values[p.key] = p.value;
    writePresets({ ...presets, [fx.type]: values });
    pushNotice("info", `已把「${fx.name}」保存为预设`);
  };

  const applyPreset = (fx: Effect) => {
    const preset = presets[fx.type];
    if (!preset) return;
    for (const [key, value] of Object.entries(preset)) setEffectParam(fx.id, key, value);
    pushNotice("info", `已应用「${fx.name}」预设`);
  };

  const clearPreset = (fx: Effect) => {
    const next = { ...presets };
    delete next[fx.type];
    writePresets(next);
    pushNotice("info", `已清除「${fx.name}」预设`);
  };

  // 未选片段不显示：效果栈永远跟着图层走
  if (!clip) return null;
  const list = effects[clip.id] ?? [];

  return (
    <div className="fx-stack">
      <div className="fx-stack-head">
        <span className="title">效果栈</span>
        <div className="fx-add-wrap">
          <button
            type="button"
            className="fx-add"
            onClick={() => setMenuOpen((v) => !v)}
          >
            + 效果
          </button>
          {menuOpen && (
            <div className="fx-menu">
              {EFFECT_MENU.map((group) => (
                <div className="fx-menu-group" key={group.category}>
                  <div className="fx-menu-cat">{group.category}</div>
                  {group.options.map((opt) => (
                    <button
                      key={opt.type}
                      type="button"
                      onClick={() => {
                        addEffect(clip.id, opt.type);
                        setMenuOpen(false);
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {list.length === 0 && (
        <div className="fx-empty">这个图层还没有效果，点「+ 效果」加一个</div>
      )}

      {list.map((fx, index) => (
        <div
          key={fx.id}
          className={`fx-card${selectedEffectId === fx.id ? " selected" : ""}${
            fx.bypassed ? " bypassed" : ""
          }`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (dragFrom.current !== null) {
              reorderEffects(clip.id, dragFrom.current, index);
            }
            dragFrom.current = null;
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            selectEffect(fx.id);
            setCtx({ x: e.clientX, y: e.clientY, effect: fx });
          }}
        >
          <div className="fx-head" onClick={() => selectEffect(fx.id)}>
            <span
              className="fx-handle"
              title="按住拖动改序"
              draggable
              onDragStart={() => {
                dragFrom.current = index;
              }}
            >
              ⣿
            </span>
            <button
              type="button"
              className="fx-collapse"
              title={fx.collapsed ? "展开" : "折叠（按住 Alt 联动全部）"}
              onClick={(e) => {
                e.stopPropagation();
                // Alt / Cmd 点折叠箭头：联动这个图层所有效果一起折叠或展开
                // （AE 的联动折叠，蒸馏自 EC 参考 的 toggle_closed(..., all)）
                if (e.altKey || e.metaKey) {
                  setAllEffectsCollapsed(clip.id, !fx.collapsed);
                  return;
                }
                toggleEffectCollapsed(fx.id);
              }}
            >
              {fx.collapsed ? "▸" : "▾"}
            </button>
            {/* fx 标记：PR 效果控件里效果名前的 fx 徽标，点它开关效果；
                旁路时打一道斜线（FC 参考 的画法） */}
            <button
              type="button"
              className={`fx-fxmark${fx.bypassed ? " off" : ""}`}
              title={fx.bypassed ? "已旁路，点一下恢复" : "效果已启用，点一下旁路"}
              onClick={(e) => {
                e.stopPropagation();
                toggleEffectBypass(fx.id);
              }}
            >
              fx
            </button>
            <span className="fx-name" title={fx.name}>
              {fx.name}
            </span>
            {/* 行尾重置：参数回默认、解除旁路、清关键帧（PR 的 Reset Effect） */}
            <button
              type="button"
              className="fx-reset"
              title="重置效果（参数回默认，清掉这条效果的关键帧）"
              onClick={(e) => {
                e.stopPropagation();
                resetEffect(fx.id);
              }}
            >
              ⟲
            </button>
            <button
              type="button"
              className="fx-del"
              title="移除效果"
              onClick={(e) => {
                e.stopPropagation();
                removeEffect(fx.id);
              }}
            >
              ✕
            </button>
          </div>

          {!fx.collapsed && (
            <div className="fx-body">
              {fx.params.map((p) => (
                <FxParamRow
                  key={p.key}
                  effectId={fx.id}
                  param={p}
                  onToggleAnim={() => toggleEffectParamAnimation(fx.id, p.key)}
                  onChange={(v) => setEffectParam(fx.id, p.key, v)}
                />
              ))}
              {/* 行内曲线小图：AE 在属性行下面内嵌的那条速度曲线，
                  点哪里跳到哪里——不用切去曲线编辑器页签就能看清这条曲线的形状 */}
              <ParamSparkline effectId={fx.id} />
            </div>
          )}
        </div>
      ))}

      {ctx && (
        <div
          className="fx-ctx"
          style={{ left: ctx.x, top: ctx.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button type="button" onClick={() => { savePreset(ctx.effect); setCtx(null); }}>
            保存当前参数为预设
          </button>
          <button
            type="button"
            disabled={!presets[ctx.effect.type]}
            onClick={() => { applyPreset(ctx.effect); setCtx(null); }}
          >
            应用预设
          </button>
          <div className="fx-ctx-sep" />
          <button
            type="button"
            disabled={!presets[ctx.effect.type]}
            onClick={() => { clearPreset(ctx.effect); setCtx(null); }}
          >
            清除预设
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 行内曲线小图（AE 属性行下的内嵌速度曲线）。
 * 把这条效果所有已打关键帧的参数的曲线叠在一张小图里：一眼看清形状与范围，
 * 点图上任意位置即把播放头挪过去；右上角一个按钮在时间线里就地展开这条曲线。
 * 没有关键帧时不画——AE 也是没有动画就不显示这条曲线。
 */
function ParamSparkline({ effectId }: { effectId: string }) {
  const effectKeyframes = useAppStore((s) => s.effectKeyframes);
  const playheadMs = useAppStore((s) => s.playheadMs);
  const setPlayhead = useAppStore((s) => s.setPlayhead);
  const setCurveExpanded = useAppStore((s) => s.setCurveExpanded);
  const setPage = useAppStore((s) => s.setPage);
  const clip = useSelectedClip();
  const clipId = clip?.id ?? null;
  const svgRef = useRef<SVGSVGElement>(null);

  const keys = useMemo(
    () => effectKeyframes.filter((k) => k.effectId === effectId),
    [effectKeyframes, effectId]
  );

  if (keys.length < 2) return null;

  // 按参数分组画，每组用自己的纵轴范围，保证不同量纲的参数都能看清
  const groups = new Map<string, typeof keys>();
  for (const k of keys) {
    const list = groups.get(k.param) ?? [];
    list.push(k);
    groups.set(k.param, list);
  }

  const width = 260;
  const height = 42;
  const pad = 4;
  const tMin = Math.min(...keys.map((k) => k.timeMs));
  const tMax = Math.max(...keys.map((k) => k.timeMs));
  const tSpan = Math.max(1, tMax - tMin);
  const xOf = (t: number) => pad + ((t - tMin) / tSpan) * (width - pad * 2);

  /** 点图跳播放头：把客户端 x 反算成时间 */
  const onPick = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = (clientX - rect.left - pad) / (width - pad * 2);
    setPlayhead(Math.max(0, tMin + ratio * tSpan));
  };

  return (
    <div className="fx-spark">
      <svg
        ref={svgRef}
        className="fx-spark-svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        onPointerDown={(e) => onPick(e.clientX)}
      >
        {Array.from(groups.entries()).map(([param, list], gi) => {
          const sorted = list.slice().sort((a, b) => a.timeMs - b.timeMs);
          const lo = Math.min(...sorted.map((k) => k.value));
          const hi = Math.max(...sorted.map((k) => k.value));
          const vSpan = Math.max(1e-6, hi - lo);
          const yOf = (v: number) => height - pad - ((v - lo) / vSpan) * (height - pad * 2);
          // 用密集采样画，曲线形状才和曲线编辑器一致（同一套 evaluateCurve）
          const d = buildSparkPath(sorted, tMin, tMax, xOf, yOf);
          return (
            <path
              key={param}
              className="fx-spark-line"
              d={d}
              style={{ stroke: gi === 0 ? "var(--rl-accent)" : "var(--rl-text-mute)" }}
            />
          );
        })}
        <line
          className="fx-spark-playhead"
          x1={xOf(playheadMs)}
          y1={0}
          x2={xOf(playheadMs)}
          y2={height}
        />
      </svg>
      <button
        type="button"
        className="fx-spark-jump"
        title="在时间线里就地展开这条曲线（选中片段的轨道下方）"
        onClick={() => {
          setPage("edit");
          setCurveExpanded(clipId ?? null);
        }}
      >
        曲线
      </button>
    </div>
  );
}

/** 密集采样成 SVG 路径，与曲线编辑器同一套求值（core/curveEval） */
function buildSparkPath(
  keys: EffectKeyframe[],
  tMin: number,
  tMax: number,
  xOf: (t: number) => number,
  yOf: (v: number) => number
): string {
  const mapped: Keyframe[] = keys.map((k) => ({
    id: k.id,
    targetId: k.effectId,
    param: k.param,
    timeMs: k.timeMs,
    value: k.value,
    easing: k.easing,
    inTangent: k.inTangent,
    outTangent: k.outTangent,
  }));
  const samples = 48;
  let d = "";
  for (let i = 0; i <= samples; i++) {
    const t = tMin + ((tMax - tMin) * i) / samples;
    const v = evaluateCurve(mapped, t) ?? 0;
    d += i === 0 ? `M ${xOf(t).toFixed(1)} ${yOf(v).toFixed(1)}` : ` L ${xOf(t).toFixed(1)} ${yOf(v).toFixed(1)}`;
  }
  return d;
}

/**
 * 一行参数：秒表 · 参数名 90px · 数值框 72×22px · ◀ ◆ ▶ 关键帧导航器。
 * 导航器照 AE / PR 的做法：菱形在播放头处增删关键帧（播放头正落在关键帧上时实心），
 * 两侧箭头跳上一个 / 下一个关键帧。
 */
function FxParamRow({
  effectId,
  param,
  onToggleAnim,
  onChange,
}: {
  effectId: Id;
  param: EffectParam;
  onToggleAnim: () => void;
  onChange: (value: EffectParamValue) => void;
}) {
  const navEffectKeyframe = useAppStore((s) => s.navEffectKeyframe);
  const hasKeyframeAtPlayhead = useAppStore((s) => s.hasKeyframeAtPlayhead);
  const atPlayhead = hasKeyframeAtPlayhead(effectId, param.key);
  const animated = param.animated;
  // 角度类参数（旋转 / 倾斜 / 角度）用圆盘拖，有界数值参数额外给一条滑杆
  const isAngle =
    typeof param.value === "number" &&
    (/(rotation|angle|skew)/i.test(param.key) || /旋转|倾斜|角度/.test(param.label));
  const isBounded =
    typeof param.value === "number" &&
    !isAngle &&
    param.min !== undefined &&
    param.max !== undefined;

  return (
    <div className={`fx-row${isBounded ? " has-slider" : ""}`}>
      <button
        type="button"
        className={`fx-stopwatch${animated ? " on" : ""}${atPlayhead ? " at-playhead" : ""}`}
        title={
          animated
            ? atPlayhead
              ? "播放头处有关键帧：再点一次删除它"
              : "该参数已启用关键帧：点一下在播放头处记录"
            : "启用关键帧（在播放头处记录）"
        }
        onClick={onToggleAnim}
      >
        <IconKeyframe />
      </button>
      <span className="fx-label" title={param.label}>
        {param.label}
      </span>
      {isAngle && (
        <AngleDial
          value={param.value as number}
          min={param.min}
          max={param.max}
          onChange={onChange}
        />
      )}
      {isBounded && (
        <input
          type="range"
          className="fx-slider"
          min={param.min}
          max={param.max}
          step={param.step ?? 1}
          value={param.value as number}
          title="拖动滑杆调值"
          onChange={(e) => onChange(Number(e.target.value))}
        />
      )}
      {typeof param.value === "number" ? (
        <DragNumber
          value={param.value}
          step={param.step ?? 1}
          min={param.min}
          max={param.max}
          animated={animated}
          onChange={onChange}
        />
      ) : (
        <span className={`fx-value num${animated ? " animated" : ""}`}>
          {String(param.value)}
        </span>
      )}
      {typeof param.value === "number" && (
        <span className="fx-kfnav" title="关键帧导航：上一帧 / 增删 / 下一帧">
          <button
            type="button"
            className="fx-kfnav-btn"
            title="跳到上一个关键帧"
            onClick={() => navEffectKeyframe(effectId, param.key, -1)}
          >
            ◀
          </button>
          <button
            type="button"
            className={`fx-kfnav-btn diamond${atPlayhead ? " at" : ""}`}
            title={atPlayhead ? "删除播放头处的关键帧" : "在播放头处打关键帧"}
            onClick={() => navEffectKeyframe(effectId, param.key, 0)}
          >
            ◆
          </button>
          <button
            type="button"
            className="fx-kfnav-btn"
            title="跳到下一个关键帧"
            onClick={() => navEffectKeyframe(effectId, param.key, 1)}
          >
            ▶
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * 角度盘：指针绕圆心拖动改角度，双击归零。
 * 蒸馏自 EC 参考 角度控件的拖动手感，但换成 Reelix 的描边圆盘。
 */
function AngleDial({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  const drag = useRef<{ startAngle: number; base: number } | null>(null);

  const angleAt = (e: ReactPointerEvent<HTMLButtonElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    return (Math.atan2(dy, dx) * 180) / Math.PI;
  };

  const clamp = (n: number): number => {
    let out = n;
    if (min !== undefined) out = Math.max(min, out);
    if (max !== undefined) out = Math.min(max, out);
    return Math.round(out * 10) / 10;
  };

  const rad = ((value - 90) * Math.PI) / 180;
  const tipX = 8 + 5 * Math.cos(rad);
  const tipY = 8 + 5 * Math.sin(rad);

  return (
    <button
      type="button"
      className="fx-angle"
      title={`角度 ${value}°（绕圆盘拖动，双击归零）`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startAngle: angleAt(e), base: value };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        let delta = angleAt(e) - d.startAngle;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        onChange(clamp(d.base + delta));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // 指针已释放，忽略
        }
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={() => onChange(0)}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.4" />
        <line
          x1="8"
          y1="8"
          x2={tipX}
          y2={tipY}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

/**
 * 可拖动数值框。按住左右拖动改值（1px = step；按住 Shift 缩到 1/10），
 * 双击切成文本输入。刻意不引入任何拖拽库。
 */
/** 可拖拽数值框：横向拖改值、双击键入。效果控件与 3D 变换组共用 */
export function DragNumber({
  value,
  step = 1,
  min,
  max,
  animated,
  onChange,
}: {
  value: number;
  step?: number;
  min?: number;
  max?: number;
  animated: boolean;
  onChange: (value: number) => void;
}) {
  const drag = useRef<{ x: number; base: number; moved: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const clamp = (n: number): number => {
    let out = n;
    if (min !== undefined) out = Math.max(min, out);
    if (max !== undefined) out = Math.min(max, out);
    return Math.round(out * 1000) / 1000;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLInputElement>) => {
    if (editing) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, base: value, moved: false };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLInputElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return; // 阈值内算点击，不算拖动
    d.moved = true;
    const fine = e.shiftKey ? 0.1 : 1;
    onChange(clamp(d.base + dx * step * fine));
  };

  const endDrag = (e: ReactPointerEvent<HTMLInputElement>) => {
    if (drag.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // 指针已释放，忽略
      }
    }
    drag.current = null;
  };

  if (editing) {
    return (
      <input
        className={`fx-value num${animated ? " animated" : ""}`}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft);
          if (draft.trim() !== "" && !Number.isNaN(n)) onChange(clamp(n));
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }

  return (
    <input
      className={`fx-value num${animated ? " animated" : ""}`}
      readOnly
      value={String(value)}
      title="左右拖动调值（Shift 微调），双击输入"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => {
        setDraft(String(value));
        setEditing(true);
      }}
    />
  );
}
