/**
 * 时间线视图（可编辑）。
 *
 * 按时间轴水平排布片段，垂直分轨。这里是「动得了的时间线」：
 * 拖片段改位置、拖两端修剪、Ctrl+K 切割、空白处框选、右键菜单改速度、
 * Ctrl+滚轮以鼠标为锚缩放，拖动时 6 像素内自动吸附并画参考线。
 * 视频/图片片段铺满缩略图胶片条（采样点走共享缩略图缓存），
 * 音频片段内沿中线画波形，峰值由后端解 PCM 压好，取不到就静默不画。
 * 双击片段 = 在监视器里直接预览这段素材（PR 源监视器的路子）。
 *
 * 所有编辑都发给后端，落库后由后端返回的权威快照回填（走 store/projectActions），
 * 前端只在拖动过程中算一份临时预览，松手就交给后端定夺。
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore, useCurrentSequence, isClipNodeBypassed } from "../store/appStore";
import type { Asset, Clip, Id, Project, Track } from "../types/project";
import type { EffectKeyframe } from "../types/effect";
import type { Keyframe } from "../types/keyframe";
import { evaluateCurve } from "../core/curveEval";
import { invoke } from "@tauri-apps/api/core";
import { registerEasingExpression } from "../core/curveEval";
import type { EasingPreset } from "../types/keyframe";
import { msToChinese, msToTimecode, snapToFrame } from "../core/timecode";
import { assetDragBridge } from "../core/assetDragBridge";
import { extractWaveform } from "../services/audio";
import { timeline as timelineApi } from "../services";
import { useThumbUrl } from "../hooks/useThumbUrl";
import {
  addSubtitleAtPlayhead,
  addTimelineMarker,
  applyClipSpeed,
  deleteSelectedClips,
  generateSubtitlesForClip,
  moveClipsTo,
  nestSelectedClips,
  placeAssetAt,
  refreshProject,
  removeTimelineMarker,
  rippleDeleteSelected,
  revealAsset,
  setClipAudioFade,
  setClipEnabled,
  setClipLabel,
  setClipTransition,
  setClipTransitionOut,
  unlinkCompound,
  trimClipTo,
  updateTrackFlags,
} from "../store/projectActions";

/** 标签色板（PR 式标签，用户要求高饱和渲染） */
const CLIP_LABELS: Array<{ name: string; label: string; color: string }> = [
  { name: "red", label: "红色", color: "#ff3b30" },
  { name: "orange", label: "橙色", color: "#ff9500" },
  { name: "yellow", label: "黄色", color: "#ffcc00" },
  { name: "green", label: "绿色", color: "#34c759" },
  { name: "cyan", label: "青色", color: "#32ade6" },
  { name: "blue", label: "蓝色", color: "#0a84ff" },
  { name: "pink", label: "粉色", color: "#ff2d92" },
];

/** 片段当前是否启用（默认启用） */
function isClipEnabled(clipId: Id | null): boolean {
  if (!clipId) return false;
  const project = useAppStore.getState().project;
  for (const seq of project?.sequences ?? []) {
    for (const track of seq.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return clip.enabled !== false;
    }
  }
  return false;
}

/** 缩放范围：1 毫秒对应多少像素。太小时一屏放不下两分钟，太大时一帧占满一屏。 */
const MIN_PX_PER_MS = 0.004;
const MAX_PX_PER_MS = 0.8;

/** 吸附半径（像素） */
const SNAP_PX = 6;
/** 内容右侧留白，方便把片段拖到序列末尾之外 */
const TAIL_PADDING_PX = 240;
/** 判定「这是拖动而不是点击」的像素阈值 */
const DRAG_PX = 3;
/** 边缘自动滚动：指针离滚动容器左右边缘这么近就开始滚（剪映同款手感） */
const EDGE_SCROLL_PX = 28;
const EDGE_SCROLL_SPEED = 16;

/** 素材类型中文名，时间线角标与提示用 */
const ASSET_KIND_LABEL: Record<Asset["kind"], string> = {
  video: "视频",
  audio: "音频",
  image: "图片",
  imageSequence: "序列",
};

/**
 * 时间线行：摄像机单独一行，其余按序号成对（Vn / 字幕 / An）。
 * 轨道本来就是无限的，只有「当前用到第几层」——上面空出来的地方
 * 滚一下滚轮就叠一层新的 V/A。
 *
 * V/A 分区（用户要求）：视频区（V + 字幕 + 摄像机）在上，音频区（A）在下，
 * 两个区各自独立垂直滚动，加轨也各自独立。
 */
interface TrackRow {
  key: string;
  /** 成对行交替底色，便于数层 */
  alt: boolean;
  tracks: Track[];
}

/** 视频区行：摄像机 + 各层 V（字幕挂在 V 下面） */
function buildVideoRows(tracks: Track[]): TrackRow[] {
  const rows: TrackRow[] = [];
  for (const camera of tracks.filter((t) => t.kind === "camera")) {
    rows.push({ key: `cam-${camera.id}`, alt: false, tracks: [camera] });
  }
  const indices = Array.from(
    new Set(tracks.filter((t) => t.kind === "video" || t.kind === "subtitle").map((t) => t.index))
  ).sort((a, b) => a - b);
  indices.forEach((index, i) => {
    const group = tracks.filter(
      (t) => (t.kind === "video" || t.kind === "subtitle") && t.index === index
    );
    rows.push({
      key: `v-${index}`,
      alt: i % 2 === 1,
      tracks: [
        ...group.filter((t) => t.kind === "video"),
        ...group.filter((t) => t.kind === "subtitle"),
      ],
    });
  });
  return rows;
}

/** 音频区行：各层 A */
function buildAudioRows(tracks: Track[]): TrackRow[] {
  const indices = Array.from(
    new Set(tracks.filter((t) => t.kind === "audio").map((t) => t.index))
  ).sort((a, b) => a - b);
  return indices.map((index, i) => {
    const group = tracks.filter((t) => t.kind === "audio" && t.index === index);
    return { key: `a-${index}`, alt: i % 2 === 1, tracks: group };
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isNodeAnimated(project: Project, nodeId: string): boolean {
  for (const graph of Object.values(project.graphs)) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (node) return node.animated;
  }
  return false;
}

/** 刻度间隔：保证相邻标签至少隔开 64 像素，缩放变化时刻度不会挤成一团。 */
function tickStepMs(pxPerMs: number, frameRate = 25): number {
  // 最大密度 = 1 帧：slot 帧时长放在步长表最前，缩放足够大时主刻度逐帧（用户要求）
  const oneFrame = 1000 / Math.max(1, frameRate);
  const steps = [oneFrame, oneFrame * 2, oneFrame * 5, oneFrame * 10,
    oneFrame * 25, oneFrame * 50, 40, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000];
  for (const step of steps) {
    if (step * pxPerMs >= 64) return step;
  }
  return 120000;
}

type DragKind =
  | "move"
  | "trim-in"
  | "trim-out"
  | "marquee"
  | "scrub"
  /** 波纹编辑：拖边缘并挤压/拉伸同轨后续片段 */
  | "ripple-in"
  | "ripple-out"
  /** 滚动编辑：拖衔接点，同时修改左右两段 */
  | "roll-in"
  | "roll-out"
  /** 速度拉伸：拖边缘改时长同时反比改速度 */
  | "rate-in"
  | "rate-out"
  /** 滑移：拖片段内部换内容，起点与时长不变 */
  | "slip";

interface MarqueeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一次指针拖动的全部上下文。放在 ref 里给事件用，同时进 state 供渲染读。 */
interface DragSession {
  kind: DragKind;
  pointerId: number;
  /** 起点（客户端坐标） */
  originX: number;
  originY: number;
  /** 拖动涉及哪些片段，以及它们各自的原始起点 */
  ids: Id[];
  origins: Map<Id, number>;
  /** 被直接操作的那个片段（修剪 / 右键都以它为准） */
  clipId: Id;
  baseStart: number;
  baseDuration: number;
  baseIn: number;
  baseOut: number;
  speed: number;
  /** 右端最多能往外拉多少毫秒（受素材本身长度限制），无从得知时为 null */
  maxExtend: number | null;
  deltaMs: number;
  snapMs: number | null;
  moved: boolean;
  marquee: MarqueeBox | null;
  marqueeIds: Id[];
}

interface MenuState {
  x: number;
  y: number;
  /** clip=片段菜单；track=轨道空白；ruler=时间尺；blank=内容区空白 */
  kind: "clip" | "track" | "ruler" | "blank";
  /** track 菜单对应的轨道 */
  trackId?: Id;
}

/** 片段内音频波形的入参。cache 由 TimelineView 持有，同一素材窗口只取一次。 */
interface ClipWaveProps {
  assetId: Id;
  inMs: number;
  outMs: number;
  speed: number;
  /** 片段当前显示宽度（像素），决定峰值桶数 */
  widthPx: number;
  cache: Map<string, number[]>;
}
/**
 * 片段内的音频波形：内联 SVG，以片段中线为轴画上下镜像的峰值条。
 * 数据没到或取失败就什么都不画；指针事件全放行，不碰拖动/修剪/切割。
 */
function ClipWave({ assetId, inMs, outMs, speed, widthPx, cache }: ClipWaveProps) {
  /** 约 3 像素一桶，再宽的片段也没必要超过 512 桶 */
  const buckets = clamp(Math.round(widthPx / 3), 24, 512);
  const key = `${assetId}|${inMs}|${outMs}|${speed}|${buckets}`;
  const [data, setData] = useState<number[] | null>(() => cache.get(key) ?? null);

  useEffect(() => {
    const cached = cache.get(key);
    if (cached) {
      setData(cached);
      return;
    }
    let active = true;
    // 缩放/修剪会让宽度连续变化，防抖 200ms，停稳了才向后端取波形
    const timer = window.setTimeout(() => {
      extractWaveform(assetId, inMs, outMs, speed, buckets)
        .then((peaks) => {
          if (!active) return;
          cache.set(key, peaks);
          setData(peaks);
        })
        .catch(() => {
          /* 取不到波形就静默，不打扰 */
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [assetId, inMs, outMs, speed, buckets, key, cache]);

  if (!data || data.length === 0) return null;

  const barWidth = widthPx / data.length;
  return (
    <svg
      className="clip-wave"
      viewBox={`0 0 ${widthPx} 100`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {data.map((peak, i) => {
        // 峰值条以中线（50）为轴，向上向下各画一半，总高 = peak * 片段高
        const h = clamp(peak, 0, 1) * 50;
        const x = i * barWidth;
        return (
          <g key={i}>
            <rect x={x} y={50 - h} width={barWidth} height={h} />
            <rect x={x} y={50} width={barWidth} height={h} />
          </g>
        );
      })}
    </svg>
  );
}

/** 胶片条的一格：一张缩略图，取不到就留空槽（中性底色，绝不画成「破损」样） */
function FilmCell({ assetId, timeMs }: { assetId: Id; timeMs: number }) {
  const url = useThumbUrl(assetId, timeMs, true);
  return (
    <div
      className={`clip-film-cell${url ? "" : " empty"}`}
      style={url ? { backgroundImage: `url("${url}")` } : undefined}
    />
  );
}

/**
 * 就地展开的关键帧曲线行（AE 图表编辑器内嵌在时间轴的模式）。
 *
 * 选中片段打了关键帧后，它所在轨道的下方就地长出这一行：
 * - 横轴就是时间线时间，曲线只画片段自己的时间范围；
 * - 该片段的效果参数各画一条线（当前选中的效果高亮）；
 * - 关键帧菱形可以直接拖：横向改时刻（吸附到帧）、纵向改数值；
 * - 播放头竖线与时间线对齐，点行内空白即把播放头挪过去。
 */
/** 缓动预设中文名（曲线区间标签用） */
function easingLabel(e: string): string {
  const table: Record<string, string> = {
    linear: "线性",
    "ease-in": "缓入",
    "ease-out": "缓出",
    "ease-in-out": "缓入出",
    bounce: "弹跳",
    elastic: "弹性",
  };
  if (e.startsWith("expr:")) return "表达式";
  return table[e] ?? e;
}

const CURVE_ROW_H = 128;

function CurveLane({ clip, pxPerMs }: { clip: Clip; pxPerMs: number }) {
  const effects = useAppStore((s) => s.effects);
  const effectKeyframes = useAppStore((s) => s.effectKeyframes);
  const selectedEffectId = useAppStore((s) => s.selectedEffectId);
  const selectEffect = useAppStore((s) => s.selectEffect);
  const selectedKeyframeIds = useAppStore((s) => s.selectedKeyframeIds);
  const playheadMs = useAppStore((s) => s.playheadMs);
  const setPlayhead = useAppStore((s) => s.setPlayhead);
  const updateEffectKeyframes = useAppStore((s) => s.updateEffectKeyframes);
  const setKeyframesEasing = useAppStore((s) => s.setKeyframesEasing);
  const setCurveExpanded = useAppStore((s) => s.setCurveExpanded);
  const frameRate = useAppStore((s) => s.project?.sequences[0]?.frameRate ?? 25);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dragKf = useRef<{ id: Id } | null>(null);
  /** BLURRR 式：曲线区间右键菜单（选缓动预设） */
  const [segMenu, setSegMenu] = useState<{ x: number; y: number; leftKfId: Id; effectId: Id } | null>(null);

  const clipEffects = effects[clip.id] ?? [];
  const laneKeys = useMemo(
    () =>
      effectKeyframes.filter(
        (k) =>
          clipEffects.some((e) => e.id === k.effectId) &&
          (selectedEffectId === null || k.effectId === selectedEffectId)
      ),
    [effectKeyframes, clipEffects, selectedEffectId]
  );

  const startMs = clip.startMs;
  const spanMs = Math.max(1, clip.durationMs);
  const width = Math.max(80, spanMs * pxPerMs);

  // 值域归一化：所有可见关键帧的 min/max；没有变化幅度就给 ±1 的窗
  const values = laneKeys.map((k) => k.value);
  const lo = values.length > 0 ? Math.min(...values) : 0;
  const hi = values.length > 0 ? Math.max(...values) : 1;
  const vSpan = Math.max(1e-6, hi - lo);

  const xOf = (t: number) => ((t - startMs) / spanMs) * width;
  const yOf = (v: number) => CURVE_ROW_H - 14 - ((v - lo) / vSpan) * (CURVE_ROW_H - 28);
  const timeAt = (clientX: number) => {
    const rect = bodyRef.current?.getBoundingClientRect();
    if (!rect) return startMs;
    const ratio = (clientX - rect.left) / rect.width;
    return startMs + ratio * spanMs;
  };
  const valueAt = (clientY: number) => {
    const rect = bodyRef.current?.getBoundingClientRect();
    if (!rect) return lo;
    const ratio = (rect.bottom - clientY - 14) / (CURVE_ROW_H - 28);
    return lo + clamp(ratio, 0, 1) * vSpan;
  };

  const onKfPointerDown = (e: React.PointerEvent, kfId: Id) => {
    e.stopPropagation();
    dragKf.current = { id: kfId };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onKfPointerMove = (e: React.PointerEvent) => {
    const session = dragKf.current;
    if (!session) return;
    const kf = laneKeys.find((k) => k.id === session.id);
    if (!kf) return;
    updateEffectKeyframes([
      {
        id: kf.id,
        timeMs: Math.max(0, snapToFrame(timeAt(e.clientX), frameRate)),
        value: valueAt(e.clientY),
      },
    ]);
  };
  const onKfPointerUp = () => {
    dragKf.current = null;
  };

  // 按效果分组画线：当前选中的效果用强调色，其余用弱化色
  const byEffect = new Map<Id, EffectKeyframe[]>();
  for (const k of laneKeys) {
    const list = byEffect.get(k.effectId) ?? [];
    list.push(k);
    byEffect.set(k.effectId, list);
  }

  return (
    <div className="tl-curve-row" style={{ height: CURVE_ROW_H }}>
      <div className="tl-curve-tag">
        <span>关键帧曲线</span>
        <button
          type="button"
          title="收起曲线行"
          onClick={() => setCurveExpanded(null)}
        >
          ×
        </button>
      </div>
      {/* 曲线区间右键菜单：缓动预设（曲线/弹性/表达式 三组） */}
      {segMenu && (
        <div className="curve-seg-menu" style={{ left: segMenu.x, top: segMenu.y }}>
          <div className="curve-seg-menu-title">曲线</div>
          {(["linear", "ease-in", "ease-out", "ease-in-out"] as const).map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                const kf = laneKeys.find((k) => k.id === segMenu.leftKfId);
                if (kf) {
                  setKeyframesEasing([{ id: kf.id, easing: e }]);
                }
                setSegMenu(null);
              }}
            >
              {easingLabel(e)}
            </button>
          ))}
          <div className="curve-seg-menu-title">弹性</div>
          {(["bounce-out", "elastic-out"] as const).map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                const kf = laneKeys.find((k) => k.id === segMenu.leftKfId);
                if (kf) {
                  setKeyframesEasing([{ id: kf.id, easing: e }]);
                }
                setSegMenu(null);
              }}
            >
              {easingLabel(e).replace("弹跳", "弹跳(出)").replace("弹性", "弹性(出)")}
            </button>
          ))}
          <div className="curve-seg-menu-title">表达式</div>
          <button
            type="button"
            onClick={() => {
              const expr = window.prompt(
                "缓动表达式（变量 t ∈ 0~1，例：t*t 或 sin(t*3.14)）",
                "t*t"
              );
              if (expr && expr.trim()) {
                const kf = laneKeys.find((k) => k.id === segMenu.leftKfId);
                if (kf) {
                  // 预采样 100 步存进 EXPR_CACHE（前端直接用，不求值于拖动热路径）
                  void (async () => {
                    try {
                      const samples = new Float32Array(101);
                      for (let i = 0; i <= 100; i++) {
                        samples[i] = await invoke<number>("eval_expr", {
                          text: expr.trim(),
                          t: i / 100,
                        });
                      }
                      registerEasingExpression(`expr:${expr.trim()}`, samples);
                      setKeyframesEasing([
                        { id: kf.id, easing: `expr:${expr.trim()}` as EasingPreset, easingExpr: expr.trim() },
                      ]);
                    } catch (err) {
                      useAppStore
                        .getState()
                        .pushNotice("error", err instanceof Error ? err.message : String(err));
                    }
                  })();
                }
              }
              setSegMenu(null);
            }}
          >
            自定义表达式…
          </button>
        </div>
      )}
      {segMenu && <div className="curve-seg-menu-mask" onClick={() => setSegMenu(null)} />}

      <div
        ref={bodyRef}
        className="tl-curve-body"
        onPointerDown={(e) => {
          // 点空白：把播放头挪过去（不吸附，跟时间线标尺一致的手感）
          e.stopPropagation();
          setPlayhead(timeAt(e.clientX));
        }}
      >
        <svg
          className="tl-curve-svg"
          width={width}
          height={CURVE_ROW_H}
          viewBox={`0 0 ${width} ${CURVE_ROW_H}`}
          preserveAspectRatio="none"
        >
          {Array.from(byEffect.entries()).map(([effectId, list]) => {
            const sorted = list.slice().sort((a, b) => a.timeMs - b.timeMs);
            const mapped: Keyframe[] = sorted.map((k) => ({
              id: k.id,
              targetId: k.effectId,
              param: k.param,
              timeMs: k.timeMs,
              value: k.value,
              easing: k.easing,
              inTangent: k.inTangent,
              outTangent: k.outTangent,
            }));
            const samples = Math.max(24, Math.round(width / 4));
            let d = "";
            for (let i = 0; i <= samples; i++) {
              const t = startMs + (spanMs * i) / samples;
              const v = evaluateCurve(mapped, t) ?? lo;
              const x = xOf(t).toFixed(1);
              const y = yOf(v).toFixed(1);
              d += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
            }
            const active = selectedEffectId === effectId;
            return (
              <path
                key={effectId}
                d={d}
                className={`tl-curve-line${active ? " active" : ""}`}
                onPointerDown={(e) => {
                  selectEffect(effectId);
                  void e;
                }}
              />
            );
          })}
          {/* BLURRR 式区间：两关键帧之间的蓝色半透明带，点选整段 / 右键选缓动 */}
          {Array.from(byEffect.entries()).map(([effectId, list]) => {
            const sorted = list.slice().sort((a, b) => a.timeMs - b.timeMs);
            return sorted.slice(0, -1).map((k, i) => {
              const b = sorted[i + 1];
              const x0 = xOf(k.timeMs);
              const w = Math.max(2, xOf(b.timeMs) - x0);
              return (
                <g key={`seg-${effectId}-${k.id}`}>
                  <rect
                    className="tl-curve-seg"
                    onClick={() => selectEffect(effectId)}
                    x={x0}
                    y={2}
                    width={w}
                    height={CURVE_ROW_H - 4}
                    fill="rgba(74, 144, 226, 0.18)"
                    stroke="rgba(56, 116, 203, 0.55)"
                    strokeWidth={1}
                    rx={3}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      selectEffect(effectId);
                      setSegMenu({
                        x: e.clientX,
                        y: e.clientY,
                        leftKfId: k.id,
                        effectId,
                      });
                    }}
                  />
                  {/* 区间缓动名（缩放小时自动挤没了，不碍事） */}
                  {w > 54 && (
                    <text x={x0 + 4} y={14} className="tl-curve-seg-label">
                      {easingLabel(k.easing)}
                    </text>
                  )}
                </g>
              );
            });
          })}
          {laneKeys.map((k) => (
            <g
              key={k.id}
              className={`tl-curve-kf${selectedKeyframeIds.includes(k.id) ? " selected" : ""}`}
              transform={`translate(${xOf(k.timeMs).toFixed(1)}, ${yOf(k.value).toFixed(1)})`}
              onPointerDown={(e) => onKfPointerDown(e, k.id)}
              onPointerMove={onKfPointerMove}
              onPointerUp={onKfPointerUp}
            >
              <rect className="tl-curve-kf-hit" x={-7} y={-7} width={14} height={14} />
              <rect className="tl-curve-kf-diamond" x={-3.5} y={-3.5} width={7} height={7} />
            </g>
          ))}
        </svg>
        <span
          className="tl-curve-playhead"
          style={{ left: Math.max(0, xOf(playheadMs)) }}
        />
      </div>
    </div>
  );
}

/**
 * 片段胶片条：把片段在素材内的区间均摊成 2~8 个采样点抽帧，
 * 从左到右排成一列缩略图——这就是「哪段视频一眼可辨」的凭据。
 * 宽度连续变化（缩放/修剪）时防抖 150ms，停稳了才算采样点。
 */
function ClipFilm({ assetId, inMs, outMs, widthPx }: { assetId: Id; inMs: number; outMs: number; widthPx: number }) {
  const [stableWidth, setStableWidth] = useState(widthPx);
  useEffect(() => {
    const timer = window.setTimeout(() => setStableWidth(widthPx), 150);
    return () => window.clearTimeout(timer);
  }, [widthPx]);

  // 剪映式瓦片：每 48px 一格，格数随宽度增长（不设上限），
  // 瓦片时刻按 500ms 步长量化——缩放时间线时相同帧保持，不重排。
  const cells = Math.min(60, Math.max(1, Math.round(stableWidth / 48)));
  const times = useMemo(() => {
    const span = Math.max(1, outMs - inMs);
    return Array.from({ length: cells }, (_, i) => {
      const raw = inMs + (span * (i + 0.5)) / cells;
      // 量化到 500ms：相邻缩放级别下同一格取同一帧
      return Math.round(raw / 500) * 500;
    });
  }, [assetId, inMs, outMs, cells]);

  return (
    <div className="clip-film" aria-hidden="true">
      {times.map((t, i) => (
        <FilmCell key={`${t}-${i}`} assetId={assetId} timeMs={t} />
      ))}
    </div>
  );
}

export function TimelineView() {
  const project = useAppStore((s) => s.project);
  const sequence = useCurrentSequence();
  const playheadMs = useAppStore((s) => s.playheadMs);
  const setPlayhead = useAppStore((s) => s.setPlayhead);
  const selectedClipIds = useAppStore((s) => s.selectedClipIds);
  // 只为了给片段打 FX 徽标；效果本体在 store.effects 里，跟着图层走
  const effects = useAppStore((s) => s.effects);
  // 就地展开的关键帧曲线行：选中片段打了关键帧后，轨道下方就地长出来
  const curveExpandedClipId = useAppStore((s) => s.curveExpandedClipId);
  /** 当前工具：剃刀/文字/选择直接影响在时间线上的点击行为 */
  const tool = useAppStore((s) => s.tool);

  /**
   * Pointer Events 全局拖拽落轨：素材库按住素材拖到轨道上松手就落 clip。
   * 用同步桥（assetDragBridge）而不是 store state——state 异步会让
   * pointerup 早于 effect 挂载，落轨永远不触发（用户报过四次）。
   */
  useEffect(() => {
    assetDragBridge.onDrop = (info) => {
      const st = useAppStore.getState();
      const seq = st.project?.sequences[0];
      if (!seq) return;
      const el = scrollRef.current;
      if (!el) return;
      // 命中轨道（指针必须在某条轨的矩形里）；没命中就按空白处处理——
      // placeAssetAt 会自己找轨/建轨，用户拖哪儿都能落（剪映语义）
      let hover: Track | null = null;
      for (const node of el.querySelectorAll<HTMLElement>(".tl-track")) {
        const rect = node.getBoundingClientRect();
        if (info.clientY >= rect.top && info.clientY <= rect.bottom) {
          hover = seq.tracks.find((t) => t.id === node.dataset.trackId) ?? null;
          break;
        }
      }
      setDropTrackId(hover?.id ?? null);
      const asset = st.project?.assets.find((a) => a.id === info.assetId);
      if (!asset) return;
      const rect = el.getBoundingClientRect();
      const rate = seq.frameRate || 25;
      const rawMs = (info.clientX - rect.left + el.scrollLeft) / pxPerMsRef.current;
      const ms = snapToFrame(Math.max(0, rawMs), rate);
      // 素材落对轨：听到的进 A、看到的进 V；没有合适的轨就传 null 让后端建
      const targetId = hover ? resolveAssetTrackId(seq.tracks, asset, hover) : null;
      void placeAssetAt(info.assetId, targetId, ms);
    };
    return () => {
      assetDragBridge.onDrop = null;
    };
  }, []);

  const zoomLevel = useAppStore((s) => s.zoomLevel);
  const setZoomLevel = useAppStore((s) => s.setZoomLevel);
  const pxPerMs = zoomLevel;
  const setPxPerMs = setZoomLevel;

  // 拖动吸附的总开关来自偏好设置（「时间线 ▸ 拖动吸附」）。
  // 关掉之后容差为 0， moves 完全按松手位置摆放——不是摆样子的开关。
  const [snapEnabled, setSnapEnabled] = useState(true);
  useEffect(() => {
    void (async () => {
      try {
        const { getSettings } = await import("../services/settings");
        const s = await getSettings();
        setSnapEnabled(s.snapEnabled !== false);
      } catch {
        /* 读不到设置就按开启处理 */
      }
    })();
  }, []);
  /** 吸附容差（毫秒）：开关关掉时为 0 */
  const snapToleranceMs = snapEnabled ? SNAP_PX / pxPerMs : 0;

  const [drag, setDrag] = useState<DragSession | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** 拖动片段时指针悬停的可落轨轨道（仅同类型轨道可落） */
  const [moveTargetId, setMoveTargetId] = useState<Id | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gutterBodyRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragSession | null>(null);
  /** 空白处按下的 pending：move 超阈值才升级成框选，避免吞掉素材拖放 */
  const pendingBlankRef = useRef<{ pointerId: number; clientX: number; clientY: number } | null>(null);
  /** 缩放回调只注册一次，靠 ref 拿最新倍率 */
  const pxPerMsRef = useRef(pxPerMs);
  pxPerMsRef.current = pxPerMs;
  /** 滚轮叠层回调只注册一次，靠 ref 拿最新序列 id */
  const sequenceIdRef = useRef<Id | null>(null);
  sequenceIdRef.current = sequence?.id ?? null;
  /** 叠层防连发：一次滚轮手势只长一对 V/A */
  /** 波形缓存：键为「素材|入点|出点|速度|桶数」，跨片段共享，同一窗口只向后端取一次 */
  const waveCacheRef = useRef<Map<string, number[]>>(new Map());

  const dragBatch = (next: DragSession | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  /**
   * rAF 节流版 dragBatch：高频 pointermove（拖动播放头 / 裁剪 / 移动）下，
   * 每帧最多提交一次 state 更新。120Hz 鼠标在 60Hz 屏上白跑一半的 move，
   * 大工程里一次全量重渲染能到几十毫秒，不节流就会拖影、发粘。
   * 参数为函数时按最新 session 计算；帧末统一落 ref + setState。
   */
  const pendingFrameRef = useRef<number | null>(null);
  /** V/A 分区高度比例（0.15~0.85）：中间分割线可拖动调整（剪映同款）；默认各半 */
  const [vaSplit, setVaSplit] = useState(0.5);
  /**
   * 播放跟随：播放中播放头快到右边缘时，时间线持续左滚，保持播放头在屏内
   * （剪映同款；拖动 / 缩放时用户自己掌控，不抢滚动）。
   */
  const playing = useAppStore((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const el = scrollRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const viewStart = el.scrollLeft / Math.max(0.001, pxPerMs);
      const x = (playheadMs - viewStart) * pxPerMs;
      if (x > rect.width - 90) {
        el.scrollLeft += 28;
      } else if (x < 30 && el.scrollLeft > 0) {
        el.scrollLeft -= 28;
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [playing, playheadMs, pxPerMs]);

  /** 拖动 / 裁剪时的悬浮时刻读数（null = 不显示） */
  const [dragReadout, setDragReadout] = useState<{ x: number; y: number; text: string } | null>(null);


  const scrubWantedMsRef = useRef<number>(0);
  const scrubWantedRef = useRef<number | null>(null);
  const dragBatchThrottled = (next: DragSession | ((s: DragSession) => DragSession)) => {
    dragRef.current =
      typeof next === "function" ? next(dragRef.current as DragSession) : next;
    if (pendingFrameRef.current !== null) return;
    pendingFrameRef.current = requestAnimationFrame(() => {
      pendingFrameRef.current = null;
      setDrag(dragRef.current);
    });
  };
  const cancelDragFrame = () => {
    if (pendingFrameRef.current !== null) {
      cancelAnimationFrame(pendingFrameRef.current);
      pendingFrameRef.current = null;
    }
  };


  /** V/A 分批加轨：V 区只加 V 轨，A 区只加 A 轨（用户要求分批） */
  /** 加轨后把对应分区滚到底：否则新轨和加轨按钮只露一半（用户报的 bug） */
  const scrollZoneToBottom = (kind: "video" | "audio") => {
    const el = scrollRef.current;
    if (!el) return;
    const zone = el.querySelector<HTMLElement>(
      kind === "video" ? ".tl-zone-v" : ".tl-zone-a"
    );
    if (zone) {
      // 等一帧让新轨渲染出来再滚
      requestAnimationFrame(() => {
        zone.scrollTop = zone.scrollHeight;
      });
    }
  };

  const addTrackOfKind = async (kind: "video" | "audio") => {
    const seqId = sequenceIdRef.current;
    if (!seqId) return;
    try {
      await timelineApi.addTrack(kind, seqId);
      await refreshProject();
      // 修 bug：加轨后分区滚到底，否则新轨和「＋新建 X 轨」按钮只露一半
      scrollZoneToBottom(kind);
    } catch {
      /* 失败时后端已给中文提示，这里安静 */
    }
  };

  /**
   * Ctrl+滚轮缩放，锚点是鼠标位置：缩放前后指针底下那一毫秒不动。
   * 普通滚轮滚到顶继续往上 = 叠一层 V/A。
   * React 的 onWheel 是被动监听，preventDefault 无效，所以自己挂原生监听。
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        // Ctrl+滚轮 = 缩放，锚点是鼠标位置（缩放前后指针底下那一毫秒不动）
        e.preventDefault();
        const current = pxPerMsRef.current;
        const rect = el.getBoundingClientRect();
        const pointerOffset = e.clientX - rect.left;
        const anchorMs = (pointerOffset + el.scrollLeft) / current;
        const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
        const next = clamp(current * factor, MIN_PX_PER_MS, MAX_PX_PER_MS);
        pxPerMsRef.current = next;
        setPxPerMs(next);
        el.scrollLeft = anchorMs * next - pointerOffset;
        requestAnimationFrame(() => {
          el.scrollLeft = anchorMs * next - pointerOffset;
        });
        return;
      }
      if (e.shiftKey) {
        // Shift+滚轮 = 左右移动时间线（横向滚动）
        e.preventDefault();
        el.scrollLeft += e.deltaY;
        return;
      }
      // 普通滚轮 = 上下滚轨道。
      // 以前这里写的是 scrollLeft：滚轮永远只能左右走，上下滚必须跑去左边轨头，
      // 加上轨头与内容各滚各的，于是「分不清是左右滚还是上下滚」。
      e.preventDefault();
      el.scrollTop += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [sequence?.tracks.length]);

  /** 左侧轨道名与右侧内容纵向**双向**同步（以前只有右→左，左轨头自己滚时右边不跟）。 */
  useEffect(() => {
    const el = scrollRef.current;
    const gutter = gutterBodyRef.current;
    if (!el || !gutter) return;
    let syncing = false;
    const fromContent = () => {
      if (syncing) return;
      syncing = true;
      gutter.scrollTop = el.scrollTop;
      syncing = false;
    };
    const fromGutter = () => {
      if (syncing) return;
      syncing = true;
      el.scrollTop = gutter.scrollTop;
      syncing = false;
    };
    fromContent();
    el.addEventListener("scroll", fromContent, { passive: true });
    gutter.addEventListener("scroll", fromGutter, { passive: true });
    return () => {
      el.removeEventListener("scroll", fromContent);
      gutter.removeEventListener("scroll", fromGutter);
    };
  }, [sequence?.tracks.length]);

  /** 右键菜单：点外面或按 Esc 关掉。 */
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  // 没有工程就没有序列，给一个引导态
  if (!project || !sequence) {
    return <div className="tl-empty">还没有打开工程，先「新建工程」或「打开工程」</div>;
  }

  const frameRate = sequence.frameRate || 25;
  /** 片段最短时长：一帧 */
  const minClipMs = Math.max(1000 / frameRate, 20);
  /**
   * 可梳理时间上限：序列时长再放宽一点尾巴。
   * 时长严格跟内容走（10s 的片子就是 10s），但播放头要能拖到内容末尾
   * 之外——不然最后一个片段的出点后面就没法定位、也没法接着排片。
   */
  const scrubMaxMs = sequence.durationMs + 5000;
  const contentWidth = Math.max(
    scrubMaxMs * pxPerMs + TAIL_PADDING_PX,
    800
  );
  /** 底部对齐的成对轨道：最高的一对在最上面，V1/A1 贴在最底 */
  const videoRows = buildVideoRows(sequence.tracks);
  const audioRows = buildAudioRows(sequence.tracks);

  const tickStep = tickStepMs(pxPerMs, frameRate);
  const ticks: number[] = [];
  for (let t = 0; t <= scrubMaxMs; t += tickStep) ticks.push(t);
  /**
   * 密集小刻度（用户要求：顶上一个小刻度一个小刻度）：
   * 主刻度之间再切 5 份画短刻度，缩放时自动变密/变疏；
   * 间距小于 6px 就不画（自动隐藏，不糊成一片）。
   */
  const minorStep = tickStep / 5;
  const minorTicks: number[] =
    minorStep * pxPerMs >= 6
      ? (() => {
          const out: number[] = [];
          for (let t = 0; t <= scrubMaxMs; t += minorStep) {
            if (Math.abs(t % tickStep) > 1e-6) out.push(t);
          }
          return out;
        })()
      : [];

  /** 客户端横坐标 → 时间线毫秒 */
  const clientXToMs = (clientX: number): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return (clientX - rect.left + el.scrollLeft) / pxPerMs;
  };

  /**
   * 客户端纵坐标 → 指针下方的轨道。
   * 用轨道矩形自己算，而不是 elementFromPoint：拖动中的片段盖在轨道上面，
   * 命中测试只会摸到片段本身，摸不到它底下的轨道。
   */
  const trackAtClientY = (clientY: number): Track | null => {
    const content = contentRef.current;
    if (!content) return null;
    for (const el of content.querySelectorAll<HTMLElement>(".tl-track")) {
      const rect = el.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) {
        const id = el.dataset.trackId;
        return sequence.tracks.find((t) => t.id === id) ?? null;
      }
    }
    return null;
  };

  /** 拖动单片段时，指针下方允许落下的轨道（同类型、未锁定、不是原轨） */
  /**
   * 边缘自动滚动：拖动（move/trim/scrub）时指针贴近滚动容器左右边缘，
   * 时间线持续往那个方向滚——长片段拖到画面外时不用先松手去滚轮。
   * 用 pointer 位置直接算，不建定时器：pointermove 本身就在驱动。
   */
  const edgeScroll = (clientX: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (clientX - rect.left < EDGE_SCROLL_PX) {
      el.scrollLeft -= EDGE_SCROLL_SPEED;
    } else if (rect.right - clientX < EDGE_SCROLL_PX) {
      el.scrollLeft += EDGE_SCROLL_SPEED;
    }
  };

  const resolveDropTrack = (clipId: Id, clientY: number): Track | null => {
    const source = sequence.tracks.find((t) => t.clips.some((c) => c.id === clipId));
    if (!source) return null;
    const hover = trackAtClientY(clientY);
    if (!hover || hover.id === source.id) return null;
    if (hover.kind !== source.kind || hover.locked) return null;
    return hover;
  };

  /** 吸附目标：0、播放头、以及不属于 exclude 的片段两端。 */
  const snapTargets = (exclude: (id: Id) => boolean): number[] => {
    const targets: number[] = [0, playheadMs];
    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        if (exclude(clip.id)) continue;
        targets.push(clip.startMs, clip.startMs + clip.durationMs);
      }
    }
    return targets;
  };

  const hitTest = (box: MarqueeBox): Id[] => {
    const content = contentRef.current;
    if (!content) return [];
    const base = content.getBoundingClientRect();
    const left = box.x + base.left;
    const top = box.y + base.top;
    const right = left + box.w;
    const bottom = top + box.h;
    const hits: Id[] = [];
    content.querySelectorAll<HTMLElement>(".tl-clip").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.left < right && r.right > left && r.top < bottom && r.bottom > top) {
        const id = el.dataset.clipId;
        if (id) hits.push(id);
      }
    });
    return hits;
  };

  /** 开始一次拖动：把指针捕获到内容层，后续 move / up 全由它收。 */
  const beginDrag = (pointerId: number, clientX: number, clientY: number, init: Omit<DragSession, "pointerId" | "originX" | "originY">) => {
    contentRef.current?.setPointerCapture(pointerId);
    dragBatch({ ...init, pointerId, originX: clientX, originY: clientY });
  };

  /** 拖动片段本体：先处理选中（Shift 加选 / 已在组里就整组走），再起步。 */
  /** 在指定时刻切开片段（剃刀工具与切割按钮共用） */
  const splitClipAt = async (clipId: Id, atMs: number) => {
    try {
      await timelineApi.splitClip(clipId, atMs);
      await refreshProject();
    } catch {
      useAppStore.getState().pushNotice("error", "切割失败");
    }
  };

  const onClipPointerDown = (e: React.PointerEvent, clip: Clip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setMenu(null);

    // 剃刀工具：在指针处直接切开这段片段（工具条那排真的能用）
    if (tool === "razor") {
      const atMs = snapToFrame(clientXToMs(e.clientX), frameRate);
      if (atMs > clip.startMs + 1 && atMs < clip.startMs + clip.durationMs - 1) {
        void splitClipAt(clip.id, atMs);
      }
      return;
    }
    // 文字工具：点到哪就在那加一条字幕
    if (tool === "text") {
      useAppStore.getState().selectClip(clip.id);
      void addSubtitleAtPlayhead();
      return;
    }
    // 缩放工具：以点击处为锚放大一档
    if (tool === "zoom") {
      const anchorMs = clientXToMs(e.clientX);
      const el = scrollRef.current;
      const next = Math.min(MAX_PX_PER_MS, pxPerMs * 1.6);
      useAppStore.getState().selectClip(clip.id);
      setZoomLevel(next);
      if (el) {
        const rect = el.getBoundingClientRect();
        el.scrollLeft = anchorMs * next - (e.clientX - rect.left);
      }
      return;
    }
    // 滑移工具：拖动片段内部换内容（起点不动、in/out 平移）
    if (tool === "slip") {
      useAppStore.getState().selectClip(clip.id);
      beginDrag(e.pointerId, e.clientX, e.clientY, {
        kind: "slip",
        ids: [clip.id],
        origins: new Map([[clip.id, clip.startMs]]),
        clipId: clip.id,
        baseStart: clip.startMs,
        baseDuration: clip.durationMs,
        baseIn: clip.inMs,
        baseOut: clip.outMs,
        speed: clip.speed,
        maxExtend: null,
        deltaMs: 0,
        snapMs: null,
        moved: false,
        marquee: null,
        marqueeIds: [],
      });
      return;
    }
    // 波纹 / 滚动 / 速度拉伸：按住片段边缘拖（左侧 8px 或右侧 8px）
    if (tool === "rippleEdit" || tool === "rolling" || tool === "rateStretch") {
      const rect = e.currentTarget.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const onLeft = offsetX < 8;
      const onRight = offsetX > rect.width - 8;
      if (!onLeft && !onRight) {
        // 中间命中：选中片段（不进入拖拽）
        useAppStore.getState().selectClip(clip.id);
        return;
      }
      const kind =
        tool === "rateStretch"
          ? onLeft
            ? "rate-in"
            : "rate-out"
          : tool === "rolling"
            ? onLeft
              ? "roll-in"
              : "roll-out"
            : onLeft
              ? "ripple-in"
              : "ripple-out";
      useAppStore.getState().selectClip(clip.id);
      beginDrag(e.pointerId, e.clientX, e.clientY, {
        kind,
        ids: [clip.id],
        origins: new Map([[clip.id, clip.startMs]]),
        clipId: clip.id,
        baseStart: clip.startMs,
        baseDuration: clip.durationMs,
        baseIn: clip.inMs,
        baseOut: clip.outMs,
        speed: clip.speed,
        maxExtend: null,
        deltaMs: 0,
        snapMs: null,
        moved: false,
        marquee: null,
        marqueeIds: [],
      });
      return;
    }
    // 轨道向前/向后选择：整段选中，但**不拦截拖动**（PR 的行为：
    // 轨道选择工具点击选整轨，拖动片段照样能移动）
    if (tool === "trackSelectForward" || tool === "trackSelectBackward") {
      const state = useAppStore.getState();
      const owner = sequence.tracks.find((t) => t.id === clip.trackId);
      if (owner) {
        const base = clip.startMs + clip.durationMs / 2;
        const ids = owner.clips
          .filter((c) =>
            tool === "trackSelectForward" ? c.startMs >= base : c.startMs <= base
          )
          .map((c) => c.id);
        if (ids.length > 0) state.selectClips(ids);
      }
      // 不 return：继续走下面的 move 拖拽逻辑
    }

    // 双击 = 在监视器里直接预览这段素材（PR 源监视器的路子），不进入拖动
    // 字幕片段没有素材，双击只选中，交给右侧属性面板改字
    if (e.detail >= 2) {
      const state = useAppStore.getState();
      state.selectClip(clip.id);
      if (clip.assetId) state.setPreviewAsset(clip.assetId);
      return;
    }

    const state = useAppStore.getState();
    const ownerTrack = sequence.tracks.find((t) => t.id === clip.trackId);
    if (ownerTrack?.locked) {
      state.selectClip(clip.id);
      state.pushNotice("info", "轨道已锁定，先解锁再编辑");
      return;
    }
    let ids: Id[];
    if (e.shiftKey) {
      const current = state.selectedClipIds;
      ids = current.includes(clip.id)
        ? current.filter((id) => id !== clip.id)
        : [...current, clip.id];
      if (ids.length === 0) {
        state.clearSelection();
        return;
      }
      // Shift 点中的那个成为主选中（末位），效果栈跟着它走
      ids = [...ids.filter((id) => id !== clip.id), clip.id];
      state.selectClips(ids);
    } else if (state.selectedClipIds.includes(clip.id) && state.selectedClipIds.length > 1) {
      ids = [...state.selectedClipIds.filter((id) => id !== clip.id), clip.id];
      state.selectClips(ids);
    } else {
      // 单选：链接组一起选（达芬奇式默认粘起来——点画面，声音跟着选中）
      const compoundId = clip.compoundId;
      if (compoundId) {
        const siblings = sequence.tracks
          .flatMap((track) => track.clips)
          .filter((c) => c.compoundId === compoundId)
          .map((c) => c.id);
        state.selectClips([...new Set([clip.id, ...siblings])]);
      } else {
        state.selectClip(clip.id);
      }
      ids = useAppStore.getState().selectedClipIds.length > 0
        ? useAppStore.getState().selectedClipIds
        : [clip.id];
    }

    const origins = new Map<Id, number>();
    for (const id of ids) {
      const found = sequence.tracks
        .flatMap((track) => track.clips)
        .find((item) => item.id === id);
      if (found) origins.set(id, found.startMs);
    }
    beginDrag(e.pointerId, e.clientX, e.clientY, {
      kind: "move",
      ids,
      origins,
      clipId: clip.id,
      baseStart: clip.startMs,
      baseDuration: clip.durationMs,
      baseIn: clip.inMs,
      baseOut: clip.outMs,
      speed: clip.speed || 1,
      maxExtend: null,
      deltaMs: 0,
      snapMs: null,
      moved: false,
      marquee: null,
      marqueeIds: [],
    });
  };

  /** 拖两端修剪。入出点按速度换算，时长交给后端算。 */
  const onTrimPointerDown = (e: React.PointerEvent, clip: Clip, kind: "trim-in" | "trim-out") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setMenu(null);
    const ownerTrack = sequence.tracks.find((t) => t.id === clip.trackId);
    if (ownerTrack?.locked) {
      useAppStore.getState().pushNotice("info", "轨道已锁定，先解锁再编辑");
      return;
    }
    const asset = project.assets.find((a) => a.id === clip.assetId);
    const speedAbs = Math.abs(clip.speed) || 1;
    // 字幕片段没有素材时长约束，两端都能自由拉长
    const maxExtend =
      ownerTrack?.kind === "subtitle"
        ? null
        : kind === "trim-out" && asset && asset.durationMs > clip.outMs
          ? (asset.durationMs - clip.outMs) / speedAbs
          : kind === "trim-out"
            ? 0
            : null;
    beginDrag(e.pointerId, e.clientX, e.clientY, {
      kind,
      ids: [clip.id],
      origins: new Map([[clip.id, clip.startMs]]),
      clipId: clip.id,
      baseStart: clip.startMs,
      baseDuration: clip.durationMs,
      baseIn: clip.inMs,
      baseOut: clip.outMs,
      speed: clip.speed || 1,
      maxExtend,
      deltaMs: 0,
      snapMs: null,
      moved: false,
      marquee: null,
      marqueeIds: [],
    });
  };

  /** 标尺上按下 = 拖播放头（带逐帧吸附）。 */
  const onRulerPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setMenu(null);
    // 拖动播放头：置位 scrubbing，Monitor 期间不重新解码/合成，
    // 否则每帧 move 都触发一次 CPU 渲染，竖条会被拖得一卡一卡。
    useAppStore.getState().setScrubbing(true);
    const ms = clamp(clientXToMs(e.clientX), 0, scrubMaxMs);
    setPlayhead(snapToFrame(ms, frameRate));
    beginDrag(e.pointerId, e.clientX, e.clientY, {
      kind: "scrub",
      ids: [],
      origins: new Map(),
      clipId: "",
      baseStart: 0,
      baseDuration: 0,
      baseIn: 0,
      baseOut: 0,
      speed: 1,
      maxExtend: null,
      deltaMs: 0,
      snapMs: null,
      moved: false,
      marquee: null,
      marqueeIds: [],
    });
  };

  /** 轨道空白处按下 = 拉框选。 */
  const onTrackPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return;
    setMenu(null);
    // 抓手工具：按住拖动平移时间线（工具条那排真的能用）
    if (tool === "hand") {
      const el = scrollRef.current;
      if (!el) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const baseLeft = el.scrollLeft;
      const baseTop = el.scrollTop;
      const move = (ev: PointerEvent) => {
        el.scrollLeft = baseLeft - (ev.clientX - startX);
        el.scrollTop = baseTop - (ev.clientY - startY);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
    // 不在 pointerdown 就 setPointerCapture——那会吞掉从素材箱拖进来的 HTML5 拖拽
    // （拖文件进来要经过 pointer 事件序列，提前 capture 会让 dragstart 根本不触发）。
    // 框选改成 pending 模式：等真的拖起来（move 超阈值）再 capture 起步。
    pendingBlankRef.current = { pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY };
  };

  /** pending 的空白单击/框选起步：move 超过阈值才变成框选 */
  const startPendingMarquee = (e: React.PointerEvent) => {
    const pending = pendingBlankRef.current;
    if (!pending || pending.pointerId !== e.pointerId) return false;
    if (Math.abs(e.clientX - pending.clientX) < DRAG_PX && Math.abs(e.clientY - pending.clientY) < DRAG_PX) {
      return false;
    }
    const content = contentRef.current;
    if (!content) return false;
    const base = content.getBoundingClientRect();
    const x = pending.clientX - base.left;
    const y = pending.clientY - base.top;
    beginDrag(e.pointerId, pending.clientX, pending.clientY, {
      kind: "marquee",
      ids: [],
      origins: new Map(),
      clipId: "",
      baseStart: 0,
      baseDuration: 0,
      baseIn: 0,
      baseOut: 0,
      speed: 1,
      maxExtend: null,
      deltaMs: 0,
      snapMs: null,
      moved: false,
      marquee: { x, y, w: 0, h: 0 },
      marqueeIds: [],
    });
    return true;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const session = dragRef.current;
    // 没有拖动 session 时，先把 pending 的空白单击/框选起步
    if (!session) {
      if (startPendingMarquee(e)) {
        // 起步成功后按新 session 继续本次 move
        const started = dragRef.current;
        if (started && started.kind === "marquee") {
          const content = contentRef.current;
          if (content) {
            const base = content.getBoundingClientRect();
            const x0 = started.originX - base.left;
            const y0 = started.originY - base.top;
            const x1 = e.clientX - base.left;
            const y1 = e.clientY - base.top;
            const box: MarqueeBox = {
              x: Math.min(x0, x1),
              y: Math.min(y0, y1),
              w: Math.abs(x1 - x0),
              h: Math.abs(y1 - y0),
            };
            dragBatch({ ...started, marquee: box, marqueeIds: hitTest(box), moved: true });
          }
        }
      }
      return;
    }
    if (e.pointerId !== session.pointerId) return;

    if (session.kind === "scrub") {
      const ms = clamp(clientXToMs(e.clientX), 0, scrubMaxMs);
      const at = snapToFrame(ms, frameRate);
      // 拖动滑块手感：同一帧内的多次 move 只提交最后一次（setPlayhead 直调，
      // playhead 是 store 切片，Monitor 侧已有 coalescing，不会堆积渲染请求）
      scrubWantedMsRef.current = at;
      edgeScroll(e.clientX);
      if (scrubWantedRef.current === null) {
        scrubWantedRef.current = requestAnimationFrame(() => {
          scrubWantedRef.current = null;
          setPlayhead(scrubWantedMsRef.current);
        });
      }
      return;
    }

    const raw = (e.clientX - session.originX) / pxPerMs;

    if (session.kind === "marquee") {
      const content = contentRef.current;
      if (!content) return;
      const base = content.getBoundingClientRect();
      const x0 = session.originX - base.left;
      const y0 = session.originY - base.top;
      const x1 = e.clientX - base.left;
      const y1 = e.clientY - base.top;
      const box: MarqueeBox = {
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        w: Math.abs(x1 - x0),
        h: Math.abs(y1 - y0),
      };
      dragBatchThrottled((session) => ({
        ...session,
        marquee: box,
        marqueeIds: hitTest(box),
        moved: box.w > DRAG_PX || box.h > DRAG_PX,
      }));
      return;
    }

    if (session.kind === "move") {
      const minStart = Math.min(...session.ids.map((id) => session.origins.get(id) ?? 0));
      let delta = Math.max(raw, -minStart);
      // 吸附：片段两端谁靠近参考点就贴谁
      const tolerance = snapToleranceMs;
      const start = session.baseStart + delta;
      const end = start + session.baseDuration;
      let snapMs: number | null = null;
      let bestDiff = tolerance;
      for (const target of snapTargets((id) => session.ids.includes(id))) {
        const diffStart = Math.abs(target - start);
        if (diffStart < bestDiff) {
          bestDiff = diffStart;
          snapMs = target;
          delta = target - session.baseStart;
        }
        const diffEnd = Math.abs(target - end);
        if (diffEnd < bestDiff) {
          bestDiff = diffEnd;
          snapMs = target;
          delta = target - (session.baseStart + session.baseDuration);
        }
      }
      delta = Math.max(delta, -minStart);
      // 跨轨：只有单片段拖动才允许换轨，多选整组移动保持原轨
      const dropTrack =
        session.ids.length === 1 ? resolveDropTrack(session.clipId, e.clientY) : null;
      setMoveTargetId(dropTrack?.id ?? null);
      dragBatch({
        ...session,
        deltaMs: delta,
        snapMs,
        moved:
          session.moved ||
          Math.abs(raw) > DRAG_PX ||
          Math.abs(e.clientY - session.originY) > DRAG_PX,
      });
      return;
    }

    // 波纹 / 滚动 / 速度拉伸 / 滑移：位移直接换算成毫秒（不做素材长度夹取，
    // 速度拉伸本身就会改速度；只保底一帧）
    if (
      session.kind === "ripple-in" ||
      session.kind === "ripple-out" ||
      session.kind === "roll-in" ||
      session.kind === "roll-out" ||
      session.kind === "rate-in" ||
      session.kind === "rate-out" ||
      session.kind === "slip"
    ) {
      let d = raw;
      if (session.kind === "ripple-in" || session.kind === "roll-in" || session.kind === "rate-in") {
        d = Math.min(d, session.baseDuration - minClipMs);
        d = Math.max(d, -session.baseStart);
      } else {
        d = Math.max(d, -(session.baseDuration - minClipMs));
      }
      dragBatch({
        ...session,
        deltaMs: d,
        snapMs: null,
        moved: session.moved || Math.abs(raw) > DRAG_PX,
      });
      return;
    }

    // 修剪：左端不能越过片段尾，右端不能缩到没影，也不能超过素材本身长度
    let delta =
      session.kind === "trim-in"
        ? Math.min(raw, session.baseDuration - minClipMs)
        : Math.max(raw, -(session.baseDuration - minClipMs));
    if (session.kind === "trim-in") {
      delta = Math.max(delta, -session.baseStart);
    } else if (session.maxExtend !== null) {
      delta = Math.min(delta, session.maxExtend);
    }

    const edgeBase =
      session.kind === "trim-in" ? session.baseStart : session.baseStart + session.baseDuration;
    const tolerance = snapToleranceMs;
    let snapMs: number | null = null;
    let bestDiff = tolerance;
    // 邻片边界钳制（剪映行为）：普通修剪不能盖住同轨相邻片段，
    // 顶到邻片边缘就停住，并把磁吸线画在边界上给出反馈。
    const ownerTrack = sequence.tracks.find((tr) =>
      tr.clips.some((c) => c.id === session.clipId)
    );
    if (ownerTrack) {
      const clip = ownerTrack.clips.find((c) => c.id === session.clipId);
      if (clip) {
        if (session.kind === "trim-in") {
          // 同轨上在本片之前结束的最近一片
          const prevEnd = ownerTrack.clips
            .filter((c) => c.id !== clip.id && c.startMs + c.durationMs <= clip.startMs + 0.5)
            .map((c) => c.startMs + c.durationMs)
            .reduce((a, b) => (b > a ? b : a), 0.0);
          if (prevEnd > 0) {
            const limit = prevEnd - session.baseStart; // 负值：最早只能到 prevEnd
            if (delta < limit) {
              delta = limit;
              snapMs = prevEnd;
            }
          }
        } else if (session.kind === "trim-out") {
          const nextStart = ownerTrack.clips
            .filter((c) => c.id !== clip.id && c.startMs >= clip.startMs + clip.durationMs - 0.5)
            .map((c) => c.startMs)
            .reduce((a, b) => (a === 0 || b < a ? b : a), Number.MAX_SAFE_INTEGER);
          if (nextStart < Number.MAX_SAFE_INTEGER) {
            const limit = nextStart - (session.baseStart + session.baseDuration);
            if (delta > limit) {
              delta = limit;
              snapMs = nextStart;
            }
          }
        }
      }
    }

    for (const target of snapTargets((id) => id === session.clipId)) {
      const diff = Math.abs(target - (edgeBase + delta));
      if (diff < bestDiff) {
        bestDiff = diff;
        delta = target - edgeBase;
        snapMs = target;
      }
    }

    dragBatch({
      ...session,
      deltaMs: delta,
      snapMs,
      moved: session.moved || Math.abs(raw) > DRAG_PX,
    });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    // 收尾必须 flush 掉节流帧：否则最后一小段位移不落库（trim 差几毫秒）
    cancelDragFrame();
    setDragReadout(null);
    const session = dragRef.current;
    // 空白处单击（没拖起来）：清选中 + 把播放头挪到点击处
    if (!session) {
      const pending = pendingBlankRef.current;
      if (pending && pending.pointerId === e.pointerId) {
        pendingBlankRef.current = null;
        const state = useAppStore.getState();
        state.clearSelection();
        const ms = clamp(clientXToMs(e.clientX), 0, scrubMaxMs);
        setPlayhead(snapToFrame(ms, frameRate));
      }
      return;
    }
    if (e.pointerId !== session.pointerId) return;
    // 松手前先定下落轨：只在单片段、同类型、目标未锁定时生效
    const dstTrack =
      session.kind === "move" && session.ids.length === 1
        ? resolveDropTrack(session.clipId, e.clientY)
        : null;
    setMoveTargetId(null);
    contentRef.current?.releasePointerCapture(e.pointerId);
    dragBatch(null);

    if (session.kind === "scrub") {
      // 松手：退出拖动态，Monitor 收到 playheadMs 变化后才渲染最终那一帧
      useAppStore.getState().setScrubbing(false);
      return;
    }

    if (session.kind === "marquee") {
      if (session.moved) {
        if (session.marqueeIds.length > 0) useAppStore.getState().selectClips(session.marqueeIds);
        else useAppStore.getState().clearSelection();
      } else {
        // 空白处单击：清掉选中，并把播放头挪到点击处
        const state = useAppStore.getState();
        state.clearSelection();
        const ms = clamp(clientXToMs(e.clientX), 0, scrubMaxMs);
        setPlayhead(snapToFrame(ms, frameRate));
      }
      return;
    }

    if (!session.moved) return;
    // 纯纵向换轨时水平位移可能不足半毫秒，这里放行
    if (Math.abs(session.deltaMs) < 0.5 && dstTrack === null) return;

    const sessionTrack = sequence.tracks.find((t) =>
      t.clips.some((c) => c.id === session.clipId)
    );
    const isSubtitle = sessionTrack?.kind === "subtitle";

    if (session.kind === "move") {
      // 链接联动：拖 A/V 组里的一段，同 compound_id 的兄弟一起走
      // （达芬奇式「默认粘起来」，蒸馏自两家的链接片段模型）
      const project = useAppStore.getState().project;
      const targets = new Map(session.origins);
      if (project) {
        const allClips: Clip[] = [];
        for (const seq of project.sequences) {
          for (const track of seq.tracks) allClips.push(...track.clips);
        }
        for (const id of session.ids) {
          const compoundId = allClips.find((c) => c.id === id)?.compoundId;
          if (!compoundId) continue;
          for (const sib of allClips) {
            if (sib.compoundId === compoundId && !targets.has(sib.id)) {
              targets.set(sib.id, sib.startMs);
            }
          }
        }
      }
      // 轨道不重叠钳制（用户规则：不能重叠，放不下就贴到邻片边缘）：
      // 被拖片段与目标轨上其他片段求交，相交就把起点推到最近的空位。
      const nonOverlap = (clipId: Id, trackId: Id, startMs: number, durationMs: number): number => {
        const tr = sequence.tracks.find((t) => t.id === trackId);
        if (!tr) return startMs;
        const others = tr.clips.filter((c) => c.id !== clipId && !session.ids.includes(c.id));
        let s = startMs;
        const e = () => s + durationMs;
        for (let pass = 0; pass < 4; pass++) {
          const hit = others.find((c) => s < c.startMs + c.durationMs && e() > c.startMs);
          if (!hit) break;
          // 推到更近的一侧：左贴（hit 结束处）或右贴（hit 起点减时长）
          const pushRight = hit.startMs + hit.durationMs;
          const pushLeft = hit.startMs - durationMs;
          s = Math.abs(pushRight - s) <= Math.abs(s - pushLeft) ? pushRight : Math.max(0, pushLeft);
        }
        return Math.max(0, s);
      };
      void moveClipsTo(
        Array.from(targets.entries()).map(([id, startMs]) => {
          const newStart = startMs + session.deltaMs;
          const trackId = id === session.clipId ? dstTrack?.id : undefined;
          const c = sequence.tracks.flatMap((t) => t.clips).find((x) => x.id === id);
          const dur = c?.durationMs ?? 0;
          const finalTrack = trackId ?? sequence.tracks.find((t) => t.clips.some((x) => x.id === id))?.id;
          return {
            id,
            // 换轨只作用于被拖的那一段，联动兄弟留在原轨
            trackId,
            startMs: finalTrack ? nonOverlap(id, finalTrack, newStart, dur) : newStart,
          };
        })
      );
    } else if (session.kind === "trim-in") {
      // 字幕没有源素材：左端外拉时直接把时长补长，入点保持 0
      void trimClipTo(
        session.clipId,
        isSubtitle
          ? {
              startMs: session.baseStart + session.deltaMs,
              inMs: 0,
              outMs: Math.max(minClipMs, session.baseDuration - session.deltaMs),
            }
          : {
              startMs: session.baseStart + session.deltaMs,
              inMs: session.baseIn + session.deltaMs * session.speed,
              outMs: session.baseOut,
            }
      );
    } else if (session.kind === "trim-out") {
      void trimClipTo(session.clipId, {
        startMs: session.baseStart,
        inMs: session.baseIn,
        outMs: session.baseOut + session.deltaMs * session.speed,
      });
    } else if (
      session.kind === "ripple-in" ||
      session.kind === "ripple-out" ||
      session.kind === "roll-in" ||
      session.kind === "roll-out" ||
      session.kind === "rate-in" ||
      session.kind === "rate-out" ||
      session.kind === "slip"
    ) {
      // 波纹 / 滚动 / 速度拉伸 / 滑移：只走专用提交，不能再走 trim-out（否则双重执行）
      void commitToolEdit(session);
    }
  };

  /** 波纹/滚动/速度拉伸/滑移的落手：调后端命令，真改时间线 */
  async function commitToolEdit(session: DragSession): Promise<void> {
    const delta = session.deltaMs;
    if (Math.abs(delta) < 0.5) return;
    const seq = useAppStore.getState().project?.sequences[0];
    if (!seq) return;
    const track = seq.tracks.find((t) => t.clips.some((c) => c.id === session.clipId));
    if (!track) return;
    const clip = track.clips.find((c) => c.id === session.clipId);
    if (!clip) return;
    const newDur = Math.max(minClipMs, session.baseDuration + delta);

    try {
      if (session.kind === "ripple-in" || session.kind === "ripple-out") {
        // 波纹：改本段长度，同轨后续片段整体前移/后移，不留缝也不压片
        if (session.kind === "ripple-in") {
          await timelineApi.trimClip(
            session.clipId,
            session.baseIn + delta * session.speed,
            session.baseOut
          );
          await timelineApi.moveClip(session.clipId, session.baseStart + delta);
        } else {
          await timelineApi.trimClip(
            session.clipId,
            session.baseIn,
            session.baseOut + delta * session.speed
          );
        }
        // 同轨上排在后面的片段跟着平移
        const dx = session.kind === "ripple-in" ? 0 : delta;
        const shift = session.kind === "ripple-in" ? -delta : delta;
        const followers = track.clips
          .filter((c) => c.id !== session.clipId && c.startMs >= session.baseStart + session.baseDuration - 1)
          .sort((a, b) => a.startMs - b.startMs);
        for (const f of followers) {
          await timelineApi.moveClip(f.id, Math.max(0, f.startMs + shift), track.id);
        }
        void dx;
      } else if (session.kind === "roll-in" || session.kind === "roll-out") {
        // 滚动：修改衔接点 —— 本段与相邻段同时伸缩（总长不变）
        const neighbor = track.clips
          .filter((c) => c.id !== session.clipId)
          .find((c) =>
            session.kind === "roll-out"
              ? Math.abs(c.startMs - (session.baseStart + session.baseDuration)) < 2
              : Math.abs(c.startMs + c.durationMs - session.baseStart) < 2
          );
        if (session.kind === "roll-out") {
          await timelineApi.trimClip(
            session.clipId,
            session.baseIn,
            session.baseOut + delta * session.speed
          );
          if (neighbor) {
            await timelineApi.trimClip(
              neighbor.id,
              neighbor.inMs + delta * neighbor.speed,
              neighbor.outMs
            );
            await timelineApi.moveClip(neighbor.id, neighbor.startMs + delta, track.id);
          }
        } else {
          await timelineApi.trimClip(
            session.clipId,
            session.baseIn + delta * session.speed,
            session.baseOut
          );
          await timelineApi.moveClip(session.clipId, session.baseStart + delta, track.id);
          if (neighbor) {
            await timelineApi.trimClip(neighbor.id, neighbor.inMs, neighbor.outMs - delta * neighbor.speed);
          }
        }
      } else if (session.kind === "rate-in" || session.kind === "rate-out") {
        // 速度拉伸：时长变 → 速度反比变（内容全长仍然铺满原素材范围）
        const speed = Math.max(
          0.1,
          Math.min(100, (session.baseDuration / newDur) * session.speed)
        );
        if (session.kind === "rate-in") {
          await timelineApi.moveClip(session.clipId, session.baseStart + delta, track.id);
        }
        await timelineApi.trimClip(
          session.clipId,
          session.baseIn,
          session.baseIn + (session.baseOut - session.baseIn)
        );
        await timelineApi.setClipSpeed(session.clipId, speed);
      } else if (session.kind === "slip") {
        // 滑移：起点不动，素材内容平移（in/out 同步挪，时长不变）
        const shift = -delta * session.speed;
        const nextIn = Math.max(0, session.baseIn + shift);
        const nextOut = nextIn + (session.baseOut - session.baseIn);
        await timelineApi.trimClip(session.clipId, nextIn, nextOut);
      }
      await refreshProject();
    } catch {
      useAppStore.getState().pushNotice("error", "编辑失败");
    }
  };

  const onClipContextMenu = (e: React.MouseEvent, clip: Clip) => {
    e.preventDefault();
    e.stopPropagation();
    const state = useAppStore.getState();
    if (!state.selectedClipIds.includes(clip.id)) state.selectClip(clip.id);
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 200),
      y: Math.min(e.clientY, window.innerHeight - 340),
      kind: "clip",
    });
  };

  /** 轨道空白右键：粘贴 / 加轨 / 删除此轨 */
  const onTrackContextMenu = (e: React.MouseEvent, track: Track) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 200),
      y: Math.min(e.clientY, window.innerHeight - 260),
      kind: "track",
      trackId: track.id,
    });
  };

  /** 时间尺右键：在指针处加标记 */
  const onRulerContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 200),
      y: Math.min(e.clientY, window.innerHeight - 160),
      kind: "ruler",
    });
  };

  /** 内容空白右键：粘贴 / 全选 */
  const onBlankContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 200),
      y: Math.min(e.clientY, window.innerHeight - 160),
      kind: "blank",
    });
  };

  const runMenuAction = (action: () => Promise<unknown>) => {
    setMenu(null);
    void action();
  };

  // ---- 素材箱拖放落轨 ----

  /** 正在拖着素材悬停的轨道 id，用于落点高亮 */
  const [dropTrackId, setDropTrackId] = useState<Id | null>(null);

  /**
   * 素材落轨：听得到的进 A 轨，看得到的进 V 轨。
   * 拖错层时自动换到同一层的对应轨（V2 上掉音频 → A2）；
   * 一条同类轨都没有时返回 null——由 placeAssetAt 新建一条，
   * 不再硬落在错误类型的轨上（老代码落到 A 轨的视频还是去了 V 轨，
   * 用户看到的就是「拖到 A 轨却冒出 V 轨」）。
   *
   * 轨道表与素材都由调用方显式传入：拖拽桥的 effect 依赖是 []，
   * 走闭包会抓到首次渲染的空工程快照。
   */
  const resolveAssetTrackId = (
    tracks: Track[],
    asset: { id: Id; kind: string } | undefined,
    track: Track
  ): Id | null => {
    if (!asset) return track.id;
    const wanted: Track["kind"] = asset.kind === "audio" ? "audio" : "video";
    if (track.kind === wanted) return track.id;
    const samePair = tracks.find(
      (t) => t.kind === wanted && t.index === track.index && !t.locked
    );
    if (samePair) return samePair.id;
    const candidates = tracks.filter((t) => t.kind === wanted && !t.locked);
    if (candidates.length === 0) return null;
    return candidates.reduce((best, t) =>
      Math.abs(t.index - track.index) < Math.abs(best.index - track.index) ? t : best
    ).id;
  };

  const onTrackDragOver = (e: React.DragEvent, track: Track) => {
    // 素材箱拖来的（自定义 type）；text/plain 兜底是给某些 WebView 丢自定义 type 的情况
    const isReelixDrag =
      e.dataTransfer.types.includes("application/reelix-asset") ||
      e.dataTransfer.types.includes("text/plain");
    if (!isReelixDrag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    // 高亮真正会落下的轨（拖到 A 轨的图片会亮 V 轨）
    setDropTrackId(track.id);
  };

  const onTrackDragLeave = (e: React.DragEvent, track: Track) => {
    if (dropTrackId === track.id) setDropTrackId(null);
    void e;
  };

  /** 松手落轨：按指针位置换算时刻（吸附到帧），带音轨的视频同时拆出声音落到音频轨 */
  const onTrackDrop = (e: React.DragEvent, track: Track) => {
    e.preventDefault();
    // 挡住冒泡：内容区还有一层兜底 drop，不挡会同一份素材落两次
    e.stopPropagation();
    setDropTrackId(null);
    let assetId = e.dataTransfer.getData("application/reelix-asset");
    if (!assetId) assetId = e.dataTransfer.getData("text/plain");
    if (!assetId) return;
    // 校验这个 id 真是本工程的素材，挡住外部文件误拖
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) return;
    // 允许落到序列末尾之后（接着往后排），只挡负数；以前 clamp 到序列时长，
    // 导致「视频放完之后放不进下一个位置」。
    const ms = Math.max(0, clientXToMs(e.clientX));
    const targetId = resolveAssetTrackId(sequence.tracks, asset, track);
    void placeAssetAt(assetId, targetId, snapToFrame(ms, frameRate));
  };

  /**
   * 整块内容区兜底：指针落在片段条或轨道边缘时，轨道自己的 dragover/drop
   * 可能收不到（WebView2 命中测试的差异），这里用指针纵坐标反查轨道再走同一套落轨逻辑；
   * 连轨道都没命中（拖在空白处）就传 null，由 placeAssetAt 自动找轨/建轨。
   */
  const onContentDragOver = (e: React.DragEvent) => {
    const track = trackAtClientY(e.clientY);
    if (track) setDropTrackId(track.id);
  };

  const onContentDrop = (e: React.DragEvent) => {
    const track = trackAtClientY(e.clientY);
    setDropTrackId(null);
    let assetId = e.dataTransfer.getData("application/reelix-asset");
    if (!assetId) assetId = e.dataTransfer.getData("text/plain");
    if (!assetId) return;
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) return;
    const ms = Math.max(0, clientXToMs(e.clientX));
    const targetId = track ? resolveAssetTrackId(sequence.tracks, asset, track) : null;
    void placeAssetAt(assetId, targetId, snapToFrame(ms, frameRate));
  };

  /** 拖动中的临时几何：左端与时长，松手后由后端权威数据接管。 */  const clipGeometry = (clip: Clip): { left: number; duration: number } => {
    if (!drag) return { left: clip.startMs, duration: clip.durationMs };
    if (drag.kind === "move" && drag.ids.includes(clip.id)) {
      return { left: clip.startMs + drag.deltaMs, duration: clip.durationMs };
    }
    if (drag.kind === "trim-in" && drag.clipId === clip.id) {
      return { left: clip.startMs + drag.deltaMs, duration: clip.durationMs - drag.deltaMs };
    }
    if (drag.kind === "trim-out" && drag.clipId === clip.id) {
      return { left: clip.startMs, duration: clip.durationMs + drag.deltaMs };
    }
    return { left: clip.startMs, duration: clip.durationMs };
  };

  return (
    <div className="tl-wrap">
      <div className="tl-gutter">
        <div className="gutter-head" />
        <div className="tl-gutter-body" ref={gutterBodyRef}>
          {/* 轨道从底部往上长，上面空出来的是「还能叠的层」 */}
          {/* 轨道从头往下排（与右侧内容区一致）。
              之前这里有一块 tl-gutter-spacer 把轨道头推到底部，
              右侧内容区却在顶部——左右错位，于是出现「没轨道的地方冒出一个视频」。 */}
          <div className="tl-gutter-stack">
<div className="tl-gutter-zone tl-gutter-zone-v" style={{ flex: `1 1 ${vaSplit * 100}%` }}>
            {videoRows.map((row) => (
              <div key={row.key} className="tl-gutter-row">
                {row.tracks.map((track) => (
                  <Fragment key={track.id}>
                    <div className="track-label" style={{ height: track.height }}>
            <span className="track-code">
              {track.kind === "video"
                ? `V${track.index + 1}`
                : track.kind === "audio"
                  ? `A${track.index + 1}`
                  : track.kind === "subtitle"
                    ? `S${track.index + 1}`
                    : "摄像机"}
            </span>
            {track.kind === "camera" ? (
              // 摄像机轨道不承载素材，只表示相机「穿过」的区间（docs/09 第 2.4 节）
              <span className="tbtn on" title="三维摄像机轨道">3D</span>
            ) : (
              <>
                {track.kind !== "subtitle" && (
                  <>
                    <button
                      type="button"
                      className={`tbtn${track.muted ? " on" : ""}`}
                      title={track.muted ? "取消静音" : "静音"}
                      onClick={() => void updateTrackFlags(track.id, { muted: !track.muted })}
                    >
                      静
                    </button>
                    <button
                      type="button"
                      className={`tbtn${track.solo ? " on" : ""}`}
                      title={track.solo ? "取消独奏" : "独奏这条轨"}
                      onClick={() => void updateTrackFlags(track.id, { solo: !track.solo })}
                    >
                      独
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={`tbtn${track.hidden ? " on" : ""}`}
                  title={track.hidden ? "显示这条轨" : "隐藏这条轨"}
                  onClick={() => void updateTrackFlags(track.id, { hidden: !track.hidden })}
                >
                  隐
                </button>
                <button
                  type="button"
                  className={`tbtn${track.locked ? " on" : ""}`}
                  title={track.locked ? "解锁这条轨" : "锁定这条轨"}
                  onClick={() => void updateTrackFlags(track.id, { locked: !track.locked })}
                >
                  锁
                </button>
              </>
            )}
          </div>
          {/* 曲线行展开时，gutter 同步补一块等高占位，左右两侧永远对齐 */}
          {curveExpandedClipId !== null &&
            track.clips.some((c) => c.id === curveExpandedClipId) && (
              <div className="track-label curve-gutter" style={{ height: CURVE_ROW_H }}>
                <span>曲线</span>
                <button
                  type="button"
                  className="tbtn"
                  title="收起曲线行"
                  onClick={() => useAppStore.getState().setCurveExpanded(null)}
                >
                  收起
                </button>
              </div>
            )}
                  </Fragment>
                ))}
              </div>
            ))}
            {/* V 区底部：只加 V 轨（用户要求：V 下加 V，A 下加 A，分批） */}
            <button
              type="button"
              className="tl-add-zone-track"
              title="在视频区新增一条视频轨"
              onClick={() => void addTrackOfKind("video")}
            >
              ＋ 新建 V 轨
            </button>
          </div>
          <div className="tl-gutter-zone tl-gutter-zone-a" style={{ flex: `1 1 ${(1 - vaSplit) * 100}%` }}>
            {audioRows.map((row) => (
              <div key={row.key} className="tl-gutter-row">
                {row.tracks.map((track) => (
                  <Fragment key={track.id}>
                    <div className="track-label" style={{ height: track.height }}>
            <span className="track-code">
              {track.kind === "video"
                ? `V${track.index + 1}`
                : track.kind === "audio"
                  ? `A${track.index + 1}`
                  : track.kind === "subtitle"
                    ? `S${track.index + 1}`
                    : "摄像机"}
            </span>
            {track.kind === "camera" ? (
              // 摄像机轨道不承载素材，只表示相机「穿过」的区间（docs/09 第 2.4 节）
              <span className="tbtn on" title="三维摄像机轨道">3D</span>
            ) : (
              <>
                {track.kind !== "subtitle" && (
                  <>
                    <button
                      type="button"
                      className={`tbtn${track.muted ? " on" : ""}`}
                      title={track.muted ? "取消静音" : "静音"}
                      onClick={() => void updateTrackFlags(track.id, { muted: !track.muted })}
                    >
                      静
                    </button>
                    <button
                      type="button"
                      className={`tbtn${track.solo ? " on" : ""}`}
                      title={track.solo ? "取消独奏" : "独奏这条轨"}
                      onClick={() => void updateTrackFlags(track.id, { solo: !track.solo })}
                    >
                      独
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className={`tbtn${track.hidden ? " on" : ""}`}
                  title={track.hidden ? "显示这条轨" : "隐藏这条轨"}
                  onClick={() => void updateTrackFlags(track.id, { hidden: !track.hidden })}
                >
                  隐
                </button>
                <button
                  type="button"
                  className={`tbtn${track.locked ? " on" : ""}`}
                  title={track.locked ? "解锁这条轨" : "锁定这条轨"}
                  onClick={() => void updateTrackFlags(track.id, { locked: !track.locked })}
                >
                  锁
                </button>
              </>
            )}
          </div>
          {/* 曲线行展开时，gutter 同步补一块等高占位，左右两侧永远对齐 */}
          {curveExpandedClipId !== null &&
            track.clips.some((c) => c.id === curveExpandedClipId) && (
              <div className="track-label curve-gutter" style={{ height: CURVE_ROW_H }}>
                <span>曲线</span>
                <button
                  type="button"
                  className="tbtn"
                  title="收起曲线行"
                  onClick={() => useAppStore.getState().setCurveExpanded(null)}
                >
                  收起
                </button>
              </div>
            )}
                  </Fragment>
                ))}
              </div>
            ))}
            {/* A 区底部：只加 A 轨 */}
            <button
              type="button"
              className="tl-add-zone-track"
              title="在音频区新增一条音频轨"
              onClick={() => void addTrackOfKind("audio")}
            >
              ＋ 新建 A 轨
            </button>
          </div>
        </div>
        </div>
      </div>

      {/* 拖动 / 裁剪时的悬浮时刻读数（剪映同款） */}
      {dragReadout && (
        <div
          className="tl-drag-readout"
          style={{ left: dragReadout.x, top: dragReadout.y }}
        >
          {dragReadout.text}
        </div>
      )}
      <div className="tl-scroll" ref={scrollRef}>        <div
          className={`tl-content${drag ? " dragging" : ""}`}
          ref={contentRef}
          data-tool={tool}
          style={{ width: contentWidth }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDragOver={onContentDragOver}
          onDrop={onContentDrop}
          onContextMenu={onBlankContextMenu}
        >
          <div className="tl-ruler" onPointerDown={onRulerPointerDown} onContextMenu={onRulerContextMenu}>
            {/* 密集小刻度（随缩放自动显示/隐藏） */}
            {minorTicks.map((t) => (
              <span key={`m${t}`} className="tick-minor" style={{ left: t * pxPerMs }} />
            ))}
            {ticks.map((t) => (
              <div key={t}>
                <span className="tick" style={{ left: t * pxPerMs }} />
                <span className="tick-label" style={{ left: t * pxPerMs }}>
                  {msToTimecode(t, frameRate)}
                </span>
              </div>
            ))}
            {/* 时间线标记（后端 markers）：点一下跳过去，右键删除 */}
            {(sequence.markers ?? []).map((m) => (
              <button
                key={m.id}
                type="button"
                className="tl-marker"
                style={{ left: m.timeMs * pxPerMs }}
                title={`${m.name ?? "标记"} · ${msToTimecode(m.timeMs, frameRate)}（右键删除）`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setPlayhead(m.timeMs)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void removeTimelineMarker(sequence.id, m.id);
                }}
              >
                <span className="tl-marker-flag" />
              </button>
            ))}
          </div>

          <div className="tl-zone-hint">
            {/* 轨道从底部往上长；V 区与 A 区各自独立滚动，互不影响 */}
          </div>
<div className="tl-zone tl-zone-v" style={{ flex: "1 1 " + vaSplit * 100 + "%" }}>
          <div className="tl-stage">
            {videoRows.map((row) => (
              <div key={row.key} className="tl-row">
                {row.tracks.map((track) => (
                  <Fragment key={track.id}>
                    <div
                      data-track-id={track.id}
                      data-kind={track.kind}
                      className={`tl-track${row.alt ? " alt" : ""}${
                        dropTrackId === track.id || moveTargetId === track.id ? " drop-target" : ""
                      }`}
                      style={{ height: track.height }}
              onPointerDown={onTrackPointerDown}
              onContextMenu={(e) => onTrackContextMenu(e, track)}
              onDragOver={(e) => onTrackDragOver(e, track)}
              onDragLeave={(e) => onTrackDragLeave(e, track)}
              onDrop={(e) => onTrackDrop(e, track)}
            >
              {/* 小眼睛：轨道隐藏（导出同样隐藏） */}
              <button
                type="button"
                className={`tl-track-eye${track.hidden ? " hidden-on" : ""}`}
                title={track.hidden ? "已隐藏（导出同样跳过）· 点击显示" : "隐藏此轨道（导出同样跳过）"}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  void updateTrackFlags(track.id, { hidden: !track.hidden });
                }}
              >
                {track.hidden ? "◌" : "◉"}
              </button>
              {track.clips.map((clip) => {
                const asset = project.assets.find((a) => a.id === clip.assetId);
                const bypassed = isClipNodeBypassed(project, clip);
                const animated = isNodeAnimated(project, clip.nodeId);
                const selected =
                  selectedClipIds.includes(clip.id) ||
                  (drag?.marqueeIds.includes(clip.id) ?? false);
                const geometry = clipGeometry(clip);
                const clipWidth = Math.max(8, geometry.duration * pxPerMs);
                // 视频 / 图片 / 序列片段铺缩略图胶片条；音频、摄像机轨、丢失素材不铺
                const showFilm =
                  asset !== undefined &&
                  !asset.missing &&
                  track.kind !== "camera" &&
                  (asset.kind === "video" ||
                    asset.kind === "image" ||
                    asset.kind === "imageSequence");
                // 波形只画音频轨；视频片段有胶片条了就不要再压一层波形
                const showWave =
                  asset !== undefined &&
                  !asset.missing &&
                  !showFilm &&
                  (track.kind === "audio" || (track.kind === "video" && asset.hasAudio));

                return (
                  <div
                    key={clip.id}
                    data-clip-id={clip.id}
                    className={`tl-clip ${track.kind}${selected ? " selected" : ""}${
                      bypassed ? " bypassed" : ""
                    }${drag?.kind === "move" && drag.ids.includes(clip.id) ? " moving" : ""}`}
                    style={{
                      left: geometry.left * pxPerMs,
                      width: clipWidth,
                    }}
                    onPointerDown={(e) => onClipPointerDown(e, clip)}
                    onContextMenu={(e) => onClipContextMenu(e, clip)}
                    title={
                      track.kind === "subtitle"
                        ? clip.text || "空字幕"
                        : asset
                          ? `${asset.name}（${ASSET_KIND_LABEL[asset.kind]} · ${msToChinese(
                              asset.durationMs
                            )}）· 双击预览`
                          : "片段"
                    }
                  >
                    {showWave && (
                      <ClipWave
                        assetId={clip.assetId}
                        inMs={clip.inMs}
                        outMs={clip.outMs}
                        speed={clip.speed || 1}
                        widthPx={clipWidth}
                        cache={waveCacheRef.current}
                      />
                    )}
                    {showFilm && (
                      <ClipFilm
                        assetId={clip.assetId}
                        inMs={clip.inMs}
                        outMs={clip.outMs}
                        widthPx={clipWidth}
                      />
                    )}
                    {/* 摄像机轨道上的片段不承载素材，不给修剪手柄 */}
                    {track.kind !== "camera" && (
                      <>
                        <span
                          className="tl-handle left"
                          onPointerDown={(e) => onTrimPointerDown(e, clip, "trim-in")}
                        />
                        <span
                          className="tl-handle right"
                          onPointerDown={(e) => onTrimPointerDown(e, clip, "trim-out")}
                        />
                      </>
                    )}
                    <div className="clip-name">
                      {track.kind === "subtitle"
                        ? clip.text?.trim() || "空字幕"
                        : asset?.name ?? (track.kind === "camera" ? "摄像机" : "片段")}
                    </div>
                    {/* 素材文件丢失：明确标「离线」，与正常片段一眼区分 */}
                    {asset?.missing && <span className="clip-offline">离线</span>}
                    {/* 挂了效果的片段给一枚 FX 徽标（PR 时间线的做法：一眼扫出调过哪些片段） */}
                    {(effects[clip.id]?.length ?? 0) > 0 && (
                      <span className="clip-fx">FX</span>
                    )}
                    {/* 图层勾选「启用 3D」后，片段出现 3D 角标（docs/09 第 2.4 节） */}
                    {clip.enable3D && <span className="badge-3d">3D</span>}
                    {/* 打了关键帧的片段给一枚可点的菱形：点它就地展开/收起曲线行 */}
                    {animated && (
                      <button
                        type="button"
                        className={`kf-dot${curveExpandedClipId === clip.id ? " on" : ""}`}
                        title={curveExpandedClipId === clip.id ? "收起关键帧曲线" : "展开关键帧曲线"}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          useAppStore
                            .getState()
                            .setCurveExpanded(curveExpandedClipId === clip.id ? null : clip.id);
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/* 关键帧曲线行：就地长在这条轨道下面（AE 图表编辑器内嵌在时间轴的模式） */}
            {(() => {
              if (curveExpandedClipId === null || track.kind === "camera") return null;
              const expanded = track.clips.find((c) => c.id === curveExpandedClipId);
              if (!expanded) return null;
              return <CurveLane clip={expanded} pxPerMs={pxPerMs} />;
            })()}
                  </Fragment>
                ))}
              </div>
            ))}
          </div>
</div>
<div
            className="tl-va-divider"
            title="拖动调整 V / A 分区高度"
            onPointerDown={(e) => {
              e.preventDefault();
              const el = scrollRef.current;
              if (!el) return;
              const rect = el.getBoundingClientRect();
              const base = rect.top;
              const total = rect.height;
              const move = (ev: PointerEvent) => {
                const ratio = (ev.clientY - base) / Math.max(1, total);
                setVaSplit(Math.min(0.85, Math.max(0.15, ratio)));
              };
              const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                document.body.classList.remove("resizing-va");
              };
              document.body.classList.add("resizing-va");
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up);
            }}
          />
          <div className="tl-zone tl-zone-a" style={{ flex: `1 1 ${(1 - vaSplit) * 100}%` }}>
          <div className="tl-stage">
            {audioRows.map((row) => (
              <div key={row.key} className="tl-row">
                {row.tracks.map((track) => (
                  <Fragment key={track.id}>
                    <div
                      data-track-id={track.id}
                      data-kind={track.kind}
                      className={`tl-track${row.alt ? " alt" : ""}${
                        dropTrackId === track.id || moveTargetId === track.id ? " drop-target" : ""
                      }`}
                      style={{ height: track.height }}
              onPointerDown={onTrackPointerDown}
              onContextMenu={(e) => onTrackContextMenu(e, track)}
              onDragOver={(e) => onTrackDragOver(e, track)}
              onDragLeave={(e) => onTrackDragLeave(e, track)}
              onDrop={(e) => onTrackDrop(e, track)}
            >
              {/* 小眼睛：轨道隐藏（导出同样隐藏） */}
              <button
                type="button"
                className={`tl-track-eye${track.hidden ? " hidden-on" : ""}`}
                title={track.hidden ? "已隐藏（导出同样跳过）· 点击显示" : "隐藏此轨道（导出同样跳过）"}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  void updateTrackFlags(track.id, { hidden: !track.hidden });
                }}
              >
                {track.hidden ? "◌" : "◉"}
              </button>
              {track.clips.map((clip) => {
                const asset = project.assets.find((a) => a.id === clip.assetId);
                const bypassed = isClipNodeBypassed(project, clip);
                const animated = isNodeAnimated(project, clip.nodeId);
                const selected =
                  selectedClipIds.includes(clip.id) ||
                  (drag?.marqueeIds.includes(clip.id) ?? false);
                const geometry = clipGeometry(clip);
                const clipWidth = Math.max(8, geometry.duration * pxPerMs);
                // 视频 / 图片 / 序列片段铺缩略图胶片条；音频、摄像机轨、丢失素材不铺
                const showFilm =
                  asset !== undefined &&
                  !asset.missing &&
                  track.kind !== "camera" &&
                  (asset.kind === "video" ||
                    asset.kind === "image" ||
                    asset.kind === "imageSequence");
                // 波形只画音频轨；视频片段有胶片条了就不要再压一层波形
                const showWave =
                  asset !== undefined &&
                  !asset.missing &&
                  !showFilm &&
                  (track.kind === "audio" || (track.kind === "video" && asset.hasAudio));

                return (
                  <div
                    key={clip.id}
                    data-clip-id={clip.id}
                    className={`tl-clip ${track.kind}${selected ? " selected" : ""}${
                      bypassed ? " bypassed" : ""
                    }${drag?.kind === "move" && drag.ids.includes(clip.id) ? " moving" : ""}`}
                    style={{
                      left: geometry.left * pxPerMs,
                      width: clipWidth,
                    }}
                    onPointerDown={(e) => onClipPointerDown(e, clip)}
                    onContextMenu={(e) => onClipContextMenu(e, clip)}
                    title={
                      track.kind === "subtitle"
                        ? clip.text || "空字幕"
                        : asset
                          ? `${asset.name}（${ASSET_KIND_LABEL[asset.kind]} · ${msToChinese(
                              asset.durationMs
                            )}）· 双击预览`
                          : "片段"
                    }
                  >
                    {showWave && (
                      <ClipWave
                        assetId={clip.assetId}
                        inMs={clip.inMs}
                        outMs={clip.outMs}
                        speed={clip.speed || 1}
                        widthPx={clipWidth}
                        cache={waveCacheRef.current}
                      />
                    )}
                    {showFilm && (
                      <ClipFilm
                        assetId={clip.assetId}
                        inMs={clip.inMs}
                        outMs={clip.outMs}
                        widthPx={clipWidth}
                      />
                    )}
                    {/* 摄像机轨道上的片段不承载素材，不给修剪手柄 */}
                    {track.kind !== "camera" && (
                      <>
                        <span
                          className="tl-handle left"
                          onPointerDown={(e) => onTrimPointerDown(e, clip, "trim-in")}
                        />
                        <span
                          className="tl-handle right"
                          onPointerDown={(e) => onTrimPointerDown(e, clip, "trim-out")}
                        />
                      </>
                    )}
                    <div className="clip-name">
                      {track.kind === "subtitle"
                        ? clip.text?.trim() || "空字幕"
                        : asset?.name ?? (track.kind === "camera" ? "摄像机" : "片段")}
                    </div>
                    {/* 素材文件丢失：明确标「离线」，与正常片段一眼区分 */}
                    {asset?.missing && <span className="clip-offline">离线</span>}
                    {/* 挂了效果的片段给一枚 FX 徽标（PR 时间线的做法：一眼扫出调过哪些片段） */}
                    {(effects[clip.id]?.length ?? 0) > 0 && (
                      <span className="clip-fx">FX</span>
                    )}
                    {/* 图层勾选「启用 3D」后，片段出现 3D 角标（docs/09 第 2.4 节） */}
                    {clip.enable3D && <span className="badge-3d">3D</span>}
                    {/* 打了关键帧的片段给一枚可点的菱形：点它就地展开/收起曲线行 */}
                    {animated && (
                      <button
                        type="button"
                        className={`kf-dot${curveExpandedClipId === clip.id ? " on" : ""}`}
                        title={curveExpandedClipId === clip.id ? "收起关键帧曲线" : "展开关键帧曲线"}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          useAppStore
                            .getState()
                            .setCurveExpanded(curveExpandedClipId === clip.id ? null : clip.id);
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/* 关键帧曲线行：就地长在这条轨道下面（AE 图表编辑器内嵌在时间轴的模式） */}
            {(() => {
              if (curveExpandedClipId === null || track.kind === "camera") return null;
              const expanded = track.clips.find((c) => c.id === curveExpandedClipId);
              if (!expanded) return null;
              return <CurveLane clip={expanded} pxPerMs={pxPerMs} />;
            })()}
                  </Fragment>
                ))}
              </div>
            ))}
          </div>
</div>

          {drag?.snapMs !== null && drag?.snapMs !== undefined && (
            <div className="tl-snapline" style={{ left: drag.snapMs * pxPerMs }} />
          )}

          {drag?.marquee && (
            <div
              className="tl-marquee"
              style={{
                left: drag.marquee.x,
                top: drag.marquee.y,
                width: drag.marquee.w,
                height: drag.marquee.h,
              }}
            />
          )}

          <div
            className="tl-playhead"
            style={{ left: playheadMs * pxPerMs }}
            onPointerDown={(e) => {
              // 播放头本身可拖（用户要求）：按下即 scrub
              if (e.button !== 0) return;
              e.stopPropagation();
              setMenu(null);
              const ms = clamp(clientXToMs(e.clientX), 0, scrubMaxMs);
              setPlayhead(snapToFrame(ms, frameRate));
              beginDrag(e.pointerId, e.clientX, e.clientY, {
                kind: "scrub",
                ids: [],
                origins: new Map(),
                clipId: "",
                baseStart: 0,
                baseDuration: 0,
                baseIn: 0,
                baseOut: 0,
                speed: 1,
                maxExtend: null,
                deltaMs: 0,
                snapMs: null,
                moved: false,
                marquee: null,
                marqueeIds: [],
              });
            }}
          />
        </div>
      </div>

      {menu && menu.kind === "track" && (
        <div
          className="tl-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => useAppStore.getState().pasteClips())}
          >
            粘贴<span className="tl-menu-key">Ctrl+V</span>
          </button>
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              const seq = useAppStore.getState().project?.sequences[0];
              if (!seq) return;
              const track = seq.tracks.find((t) => t.id === menu.trackId);
              if (!track) return;
              await timelineApi.addTrack(track.kind, seq.id);
              await refreshProject();
            })}
          >
            在此插入同类型轨道
          </button>
          <div className="tl-menu-sep" />
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              if (!menu.trackId) return;
              await timelineApi.removeTrack(menu.trackId);
              await refreshProject();
            })}
          >
            删除此轨道
          </button>
        </div>
      )}

      {menu && menu.kind === "ruler" && (
        <div
          className="tl-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              await addTimelineMarker(sequence.id, playheadMs);
            })}
          >
            在播放头处添加标记
          </button>
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              const state = useAppStore.getState();
              const seq = state.project?.sequences[0];
              if (!seq) return;
              for (const m of seq.markers ?? []) {
                await removeTimelineMarker(seq.id, m.id);
              }
            })}
          >
            删除所有标记
          </button>
        </div>
      )}

      {menu && menu.kind === "blank" && (
        <div
          className="tl-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => useAppStore.getState().pasteClips())}
          >
            粘贴<span className="tl-menu-key">Ctrl+V</span>
          </button>
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => useAppStore.getState().selectAllClips())}
          >
            全选<span className="tl-menu-key">Ctrl+A</span>
          </button>
        </div>
      )}

      {menu && menu.kind === "clip" && (
        <div
          className="tl-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* 右键菜单照 FC 参考 的 CLIP_MENU 分组（timeline.rs 1988 行起）：
              剪切/复制/粘贴属性/移除属性/清除/波纹删除 → 编辑原始素材/源监视器替换 →
              启用/取消链接 → 标签 → 速度 → 帧定格/缩放选项 → 在项目面板中显示/连接贯通编辑 */}
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              useAppStore.getState().cutClips();
            })}
          >
            剪切<span className="tl-menu-key">Ctrl+X</span>
          </button>
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              useAppStore.getState().copyClips();
            })}
          >
            复制<span className="tl-menu-key">Ctrl+C</span>
          </button>
          <button
            type="button"
            className="tl-menu-item"
            disabled={useAppStore.getState().clipClipboard.length === 0}
            onClick={() => runMenuAction(async () => {
              await useAppStore.getState().pasteClips();
            })}
          >
            粘贴<span className="tl-menu-key">Ctrl+V</span>
          </button>
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              const s = useAppStore.getState();
              if (s.selectedEffectId) s.removeEffect(s.selectedEffectId);
            })}
          >
            移除属性
          </button>
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(deleteSelectedClips)}
          >
            清除<span className="tl-menu-key">Delete</span>
          </button>
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(rippleDeleteSelected)}
          >
            波纹删除<span className="tl-menu-key">Shift+Delete</span>
          </button>
          <div className="tl-menu-sep" />
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              const assetId = useAppStore.getState().selectedClipAssetId;
              if (assetId) await revealAsset(assetId);
            })}
          >
            编辑原始素材
          </button>
          <div className="tl-menu-sep" />
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              const s = useAppStore.getState();
              if (s.selectedClipId) await setClipEnabled(s.selectedClipId, !isClipEnabled(s.selectedClipId));
            })}
          >
            {isClipEnabled(useAppStore.getState().selectedClipId) ? "✓ 启用" : "启用"}
          </button>
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              const s = useAppStore.getState();
              if (s.selectedClipId && s.selectedClipCompoundId) {
                await unlinkCompound(s.selectedClipId);
              }
            })}
          >
            取消链接
          </button>
          <div className="tl-menu-sep" />
          {/* 标签子菜单：高饱和色（PR 是低饱和，用户要求高饱和） */}
          <div className="tl-menu-sub-wrap">
            <button type="button" className="tl-menu-item has-sub">
              标签<span className="menu-arrow">›</span>
            </button>
            <div className="tl-menu tl-menu-sub">
              {CLIP_LABELS.map((l) => (
                <button
                  key={l.name}
                  type="button"
                  className="tl-menu-item"
                  onClick={() => runMenuAction(() => setClipLabel(l.name))}
                >
                  <span className="label-dot" style={{ background: l.color }} />
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          <div className="tl-menu-sep" />
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(() => applyClipSpeed(0.5))}
          >
            速度 0.5×
          </button>
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(() => applyClipSpeed(1))}
          >
            速度 1×
          </button>
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(() => applyClipSpeed(2))}
          >
            速度 2×
          </button>
          <div className="tl-menu-sep" />
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              const id = useAppStore.getState().selectedClipId;
              if (id) await generateSubtitlesForClip(id);
            })}
          >
            识别语音生成字幕<span className="tl-menu-key">本机</span>
          </button>
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(addSubtitleAtPlayhead)}
          >
            在播放头处加字幕
          </button>
          <div className="tl-menu-sep" />
          {/* 识别语音转字幕（音频/视频片段右键，后端 whisper 全通） */}
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              const s = useAppStore.getState();
              if (s.selectedClipId) await generateSubtitlesForClip(s.selectedClipId);
            })}
          >
            识别语音转字幕
          </button>
          <div className="tl-menu-sep" />
          {/* 编组（嵌套）：多选片段折叠成一个复合片段（后端 collapse_compound 真实现） */}
          <button
            type="button"
            className="tl-menu-item"
            disabled={useAppStore.getState().selectedClipIds.length < 2}
            onClick={() => runMenuAction(async () => {
              await nestSelectedClips();
            })}
          >
            编组（嵌套成复合片段）
          </button>
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              const s = useAppStore.getState();
              if (s.selectedClipId) s.setImmersiveClipId(s.selectedClipId);
            })}
          >
            进入沉浸模式（WASD 调 3D 位置）
          </button>
          <div className="tl-menu-sep" />
          <div className="tl-menu-sub-wrap">
            <button type="button" className="tl-menu-item has-sub">
              转场<span className="menu-arrow">›</span>
            </button>
            <div className="tl-menu tl-menu-sub">
              <button
                type="button"
                className="tl-menu-item"
                onClick={() => runMenuAction(async () => {
                  const s = useAppStore.getState();
                  if (s.selectedClipId) await setClipTransition(s.selectedClipId, "crossDissolve");
                })}
              >
                交叉溶解
              </button>
              <button
                type="button"
                className="tl-menu-item"
                onClick={() => runMenuAction(async () => {
                  const s = useAppStore.getState();
                  if (s.selectedClipId) await setClipTransition(s.selectedClipId, "dipToBlack");
                })}
              >
                闪黑
              </button>
              <button
                type="button"
                className="tl-menu-item"
                onClick={() => runMenuAction(async () => {
                  const s = useAppStore.getState();
                  if (s.selectedClipId) await setClipTransition(s.selectedClipId, "dipToWhite");
                })}
              >
                闪白
              </button>
              <button
                type="button"
                className="tl-menu-item"
                onClick={() => runMenuAction(async () => {
                  const s = useAppStore.getState();
                  if (s.selectedClipId) await setClipTransition(s.selectedClipId, null);
                })}
              >
                清除转场
              </button>
            </div>
          </div>
          {/* 尾部淡出（剪映「淡出」）：片段末尾向黑/白渐隐，挂在片段属性上 */}
          <div className="tl-menu-sub-wrap">
            <button type="button" className="tl-menu-item has-sub">
              淡出<span className="menu-arrow">›</span>
            </button>
            <div className="tl-menu tl-menu-sub">
              <button
                type="button"
                className="tl-menu-item"
                onClick={() => runMenuAction(async () => {
                  const s = useAppStore.getState();
                  if (s.selectedClipId) await setClipTransitionOut(s.selectedClipId, "dipToBlack");
                })}
              >
                淡出到黑
              </button>
              <button
                type="button"
                className="tl-menu-item"
                onClick={() => runMenuAction(async () => {
                  const s = useAppStore.getState();
                  if (s.selectedClipId) await setClipTransitionOut(s.selectedClipId, "dipToWhite");
                })}
              >
                淡出到白
              </button>
              <button
                type="button"
                className="tl-menu-item"
                onClick={() => runMenuAction(async () => {
                  const s = useAppStore.getState();
                  if (s.selectedClipId) await setClipTransitionOut(s.selectedClipId, null);
                })}
              >
                清除淡出
              </button>
            </div>
          </div>
          {/* 音频慢入慢出（后端 set_audio_fade，混音时真生效） */}
          <div className="tl-menu-sub-wrap">
            <button type="button" className="tl-menu-item has-sub">
              音频慢入慢出<span className="menu-arrow">›</span>
            </button>
            <div className="tl-menu tl-menu-sub">
              <button
                type="button"
                className="tl-menu-item"
                onClick={() => runMenuAction(async () => {
                  const s = useAppStore.getState();
                  if (s.selectedClipId) await setClipAudioFade(s.selectedClipId, 500, 0);
                })}
              >
                慢入 0.5s
              </button>
              <button
                type="button"
                className="tl-menu-item"
                onClick={() => runMenuAction(async () => {
                  const s = useAppStore.getState();
                  if (s.selectedClipId) await setClipAudioFade(s.selectedClipId, 0, 500);
                })}
              >
                慢出 0.5s
              </button>
              <button
                type="button"
                className="tl-menu-item"
                onClick={() => runMenuAction(async () => {
                  const s = useAppStore.getState();
                  if (s.selectedClipId) await setClipAudioFade(s.selectedClipId, 500, 500);
                })}
              >
                慢入 + 慢出
              </button>
              <button
                type="button"
                className="tl-menu-item"
                onClick={() => runMenuAction(async () => {
                  const s = useAppStore.getState();
                  if (s.selectedClipId) await setClipAudioFade(s.selectedClipId, 0, 0);
                })}
              >
                清除慢入慢出
              </button>
            </div>
          </div>
          {/* 添加标记（后端 add_marker，标记显示在时间尺上） */}
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              const seq = useAppStore.getState().project?.sequences[0];
              const at = useAppStore.getState().playheadMs;
              if (seq) await addTimelineMarker(seq.id, at);
            })}
          >
            添加标记<span className="tl-menu-key">M</span>
          </button>
          <div className="tl-menu-sep" />
          {/* 转场里最高频的两个动作：淡入 / 淡出（0.5 秒，片段属性不是效果） */}
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              const s = useAppStore.getState();
              if (s.selectedClipId) await setClipTransition(s.selectedClipId, "dipToBlack", 500);
            })}
          >
            淡入<span className="tl-menu-key">0.5s</span>
          </button>
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              const s = useAppStore.getState();
              if (s.selectedClipId) await setClipTransitionOut(s.selectedClipId, "dipToBlack", 500);
            })}
          >
            淡出<span className="tl-menu-key">0.5s</span>
          </button>
          <div className="tl-menu-sep" />
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              const s = useAppStore.getState();
              const assetId = s.selectedClipAssetId;
              if (assetId) {
                s.setPickedAsset(assetId);
                s.setPage("media");
              }
            })}
          >
            在项目面板中显示
          </button>
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              const s = useAppStore.getState();
              const id = s.selectedClipId;
              if (id) s.setCurveExpanded(s.curveExpandedClipId === id ? null : id);
            })}
          >
            {useAppStore.getState().selectedClipId !== null &&
            useAppStore.getState().curveExpandedClipId === useAppStore.getState().selectedClipId
              ? "收起关键帧曲线"
              : "显示关键帧曲线"}
          </button>
        </div>
      )}
    </div>
  );
}
