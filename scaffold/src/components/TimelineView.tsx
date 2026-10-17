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
import { msToChinese, msToTimecode, snapToFrame } from "../core/timecode";
import { extractWaveform } from "../services/audio";
import { timeline as timelineApi } from "../services";
import { useThumbUrl } from "../hooks/useThumbUrl";
import {
  addSubtitleAtPlayhead,
  applyClipSpeed,
  deleteSelectedClips,
  generateSubtitlesForClip,
  moveClipsTo,
  placeAssetAt,
  refreshProject,
  splitAtPlayhead,
  trimClipTo,
  updateTrackFlags,
} from "../store/projectActions";

/** 缩放范围：1 毫秒对应多少像素。太小时一屏放不下两分钟，太大时一帧占满一屏。 */
const MIN_PX_PER_MS = 0.004;
const MAX_PX_PER_MS = 0.8;
const DEFAULT_PX_PER_MS = 0.06;
/** 吸附半径（像素） */
const SNAP_PX = 6;
/** 内容右侧留白，方便把片段拖到序列末尾之外 */
const TAIL_PADDING_PX = 240;
/** 判定「这是拖动而不是点击」的像素阈值 */
const DRAG_PX = 3;

/** 素材类型中文名，时间线角标与提示用 */
const ASSET_KIND_LABEL: Record<Asset["kind"], string> = {
  video: "视频",
  audio: "音频",
  image: "图片",
  imageSequence: "序列",
};

/**
 * 一条时间线行：摄像机单独一行，其余按序号成对（Vn / 字幕 / An）。
 * 轨道本来就是无限的，只有「当前用到第几层」——上面空出来的地方
 * 滚一下滚轮就叠一层新的 V/A。
 */
interface TrackRow {
  key: string;
  /** 成对行交替底色，便于数层 */
  alt: boolean;
  tracks: Track[];
}

function buildTrackRows(tracks: Track[]): TrackRow[] {
  const rows: TrackRow[] = [];
  for (const camera of tracks.filter((t) => t.kind === "camera")) {
    rows.push({ key: `cam-${camera.id}`, alt: false, tracks: [camera] });
  }

  const indices = Array.from(
    new Set(tracks.filter((t) => t.kind !== "camera").map((t) => t.index))
  ).sort((a, b) => b - a);

  indices.forEach((index, i) => {
    const group = tracks.filter((t) => t.kind !== "camera" && t.index === index);
    rows.push({
      key: `pair-${index}`,
      alt: i % 2 === 1,
      // 字幕挂在 V 层下面、A 层上面：看得到的进 V，听得到的进 A
      tracks: [
        ...group.filter((t) => t.kind === "video"),
        ...group.filter((t) => t.kind === "subtitle"),
        ...group.filter((t) => t.kind === "audio"),
      ],
    });
  });

  return rows;
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
function tickStepMs(pxPerMs: number): number {
  const steps = [40, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000];
  for (const step of steps) {
    if (step * pxPerMs >= 64) return step;
  }
  return 120000;
}

type DragKind = "move" | "trim-in" | "trim-out" | "marquee" | "scrub";

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
  const setCurveExpanded = useAppStore((s) => s.setCurveExpanded);
  const frameRate = useAppStore((s) => s.project?.sequences[0]?.frameRate ?? 25);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dragKf = useRef<{ id: Id } | null>(null);

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

  const cells = Math.min(8, Math.max(1, Math.round(stableWidth / 64)));
  const times = useMemo(() => {
    const span = Math.max(1, outMs - inMs);
    return Array.from({ length: cells }, (_, i) => inMs + (span * (i + 0.5)) / cells);
  }, [assetId, inMs, outMs, cells]);

  return (
    <div className="clip-film" aria-hidden="true">
      {times.map((t) => (
        <FilmCell key={t} assetId={assetId} timeMs={t} />
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

  const [pxPerMs, setPxPerMs] = useState(DEFAULT_PX_PER_MS);
  const [drag, setDrag] = useState<DragSession | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** 拖动片段时指针悬停的可落轨轨道（仅同类型轨道可落） */
  const [moveTargetId, setMoveTargetId] = useState<Id | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gutterBodyRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragSession | null>(null);
  /** 缩放回调只注册一次，靠 ref 拿最新倍率 */
  const pxPerMsRef = useRef(pxPerMs);
  pxPerMsRef.current = pxPerMs;
  /** 滚轮叠层回调只注册一次，靠 ref 拿最新序列 id */
  const sequenceIdRef = useRef<Id | null>(null);
  sequenceIdRef.current = sequence?.id ?? null;
  /** 叠层防连发：一次滚轮手势只长一对 V/A */
  const addPairAtRef = useRef(0);
  /** 波形缓存：键为「素材|入点|出点|速度|桶数」，跨片段共享，同一窗口只向后端取一次 */
  const waveCacheRef = useRef<Map<string, number[]>>(new Map());

  const dragBatch = (next: DragSession | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  /**
   * 向上滚到顶再滚 = 在现有轨道上方叠一对新的 V/A。
   * 轨道本来就是无限的，不需要「新建轨道」按钮。
   */
  const addTrackPair = async () => {
    const now = Date.now();
    if (now - addPairAtRef.current < 450) return;
    const seqId = sequenceIdRef.current;
    if (!seqId) return;
    addPairAtRef.current = now;
    try {
      await timelineApi.addTrack("video", seqId);
      await timelineApi.addTrack("audio", seqId);
      await refreshProject();
      // 新的一对在最上面，滚回顶部让它露出来
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
      });
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
      if (!e.ctrlKey) {
        // 已经滚到最顶还继续往上：长出新的一层
        if (e.deltaY < 0 && el.scrollTop <= 0) void addTrackPair();
        return;
      }
      e.preventDefault();
      const current = pxPerMsRef.current;
      const rect = el.getBoundingClientRect();
      const pointerOffset = e.clientX - rect.left;
      const anchorMs = (pointerOffset + el.scrollLeft) / current;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      const next = clamp(current * factor, MIN_PX_PER_MS, MAX_PX_PER_MS);
      pxPerMsRef.current = next;
      setPxPerMs(next);
      // 内容宽度要等重排后才生效，下一帧再对齐一次，免得被旧宽度夹住
      el.scrollLeft = anchorMs * next - pointerOffset;
      requestAnimationFrame(() => {
        el.scrollLeft = anchorMs * next - pointerOffset;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [sequence?.tracks.length]);

  /** 左侧轨道名跟着右侧内容一起纵向滚动（上下永远对齐）。 */
  useEffect(() => {
    const el = scrollRef.current;
    const gutter = gutterBodyRef.current;
    if (!el || !gutter) return;
    const sync = () => {
      gutter.scrollTop = el.scrollTop;
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    return () => el.removeEventListener("scroll", sync);
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
  const contentWidth = Math.max(
    sequence.durationMs * pxPerMs + TAIL_PADDING_PX,
    800
  );
  /** 底部对齐的成对轨道：最高的一对在最上面，V1/A1 贴在最底 */
  const rows = buildTrackRows(sequence.tracks);

  const tickStep = tickStepMs(pxPerMs);
  const ticks: number[] = [];
  for (let t = 0; t <= sequence.durationMs; t += tickStep) ticks.push(t);

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
  const onClipPointerDown = (e: React.PointerEvent, clip: Clip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setMenu(null);

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
    const ms = clamp(clientXToMs(e.clientX), 0, sequence.durationMs);
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
    const content = contentRef.current;
    if (!content) return;
    const base = content.getBoundingClientRect();
    const x = e.clientX - base.left;
    const y = e.clientY - base.top;
    beginDrag(e.pointerId, e.clientX, e.clientY, {
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
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const session = dragRef.current;
    if (!session || e.pointerId !== session.pointerId) return;

    if (session.kind === "scrub") {
      const ms = clamp(clientXToMs(e.clientX), 0, sequence.durationMs);
      setPlayhead(snapToFrame(ms, frameRate));
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
      dragBatch({
        ...session,
        marquee: box,
        marqueeIds: hitTest(box),
        moved: box.w > DRAG_PX || box.h > DRAG_PX,
      });
      return;
    }

    if (session.kind === "move") {
      const minStart = Math.min(...session.ids.map((id) => session.origins.get(id) ?? 0));
      let delta = Math.max(raw, -minStart);
      // 吸附：片段两端谁靠近参考点就贴谁
      const tolerance = SNAP_PX / pxPerMs;
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
    const tolerance = SNAP_PX / pxPerMs;
    let snapMs: number | null = null;
    let bestDiff = tolerance;
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
    const session = dragRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    // 松手前先定下落轨：只在单片段、同类型、目标未锁定时生效
    const dstTrack =
      session.kind === "move" && session.ids.length === 1
        ? resolveDropTrack(session.clipId, e.clientY)
        : null;
    setMoveTargetId(null);
    contentRef.current?.releasePointerCapture(e.pointerId);
    dragBatch(null);

    if (session.kind === "scrub") return;

    if (session.kind === "marquee") {
      if (session.moved) {
        if (session.marqueeIds.length > 0) useAppStore.getState().selectClips(session.marqueeIds);
        else useAppStore.getState().clearSelection();
      } else {
        // 空白处单击：清掉选中，并把播放头挪到点击处
        const state = useAppStore.getState();
        state.clearSelection();
        const ms = clamp(clientXToMs(e.clientX), 0, sequence.durationMs);
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
      void moveClipsTo(
        Array.from(targets.entries()).map(([id, startMs]) => ({
          id,
          startMs: startMs + session.deltaMs,
          // 换轨只作用于被拖的那一段，联动兄弟留在原轨
          trackId: id === session.clipId ? dstTrack?.id : undefined,
        }))
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
    } else {
      void trimClipTo(session.clipId, {
        startMs: session.baseStart,
        inMs: session.baseIn,
        outMs: session.baseOut + session.deltaMs * session.speed,
      });
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
   * 拖错层时自动换到同一层的对应轨（V2 上掉音频 → A2），找不到同类轨才原样落下。
   */
  const resolveAssetTrack = (track: Track, assetId: Id): Track => {
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) return track;
    const wanted: Track["kind"] = asset.kind === "audio" ? "audio" : "video";
    if (track.kind === wanted) return track;
    const samePair = sequence.tracks.find(
      (t) => t.kind === wanted && t.index === track.index && !t.locked
    );
    if (samePair) return samePair;
    const candidates = sequence.tracks.filter((t) => t.kind === wanted && !t.locked);
    if (candidates.length === 0) return track;
    return candidates.reduce((best, t) =>
      Math.abs(t.index - track.index) < Math.abs(best.index - track.index) ? t : best
    );
  };

  const onTrackDragOver = (e: React.DragEvent, track: Track) => {
    if (!e.dataTransfer.types.includes("application/reelix-asset")) return;
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
    setDropTrackId(null);
    const assetId = e.dataTransfer.getData("application/reelix-asset");
    if (!assetId) return;
    const ms = clamp(clientXToMs(e.clientX), 0, Math.max(0, sequence.durationMs));
    const target = resolveAssetTrack(track, assetId);
    void placeAssetAt(assetId, target.id, snapToFrame(ms, frameRate));
  };

  /** 拖动中的临时几何：左端与时长，松手后由后端权威数据接管。 */
  const clipGeometry = (clip: Clip): { left: number; duration: number } => {
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
          <div className="tl-gutter-spacer" />
          <div className="tl-gutter-stack">
            {rows.map((row) => (
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
          </div>
        </div>
      </div>

      <div className="tl-scroll" ref={scrollRef}>
        <div
          className={`tl-content${drag ? " dragging" : ""}`}
          ref={contentRef}
          style={{ width: contentWidth }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="tl-ruler" onPointerDown={onRulerPointerDown}>
            {ticks.map((t) => (
              <div key={t}>
                <span className="tick" style={{ left: t * pxPerMs }} />
                <span className="tick-label" style={{ left: t * pxPerMs }}>
                  {msToTimecode(t, frameRate)}
                </span>
              </div>
            ))}
          </div>

          <div className="tl-stage-spacer">
            <span className="tl-stack-hint">向上滚动鼠标滚轮，再叠一层 V / A</span>
          </div>
          <div className="tl-stage">
            {rows.map((row) => (
              <div key={row.key} className="tl-row">
                {row.tracks.map((track) => (
                  <Fragment key={track.id}>
                    <div
                      data-track-id={track.id}
                      className={`tl-track${row.alt ? " alt" : ""}${
                        dropTrackId === track.id || moveTargetId === track.id ? " drop-target" : ""
                      }`}
                      style={{ height: track.height }}
              onPointerDown={onTrackPointerDown}
              onDragOver={(e) => onTrackDragOver(e, track)}
              onDragLeave={(e) => onTrackDragLeave(e, track)}
              onDrop={(e) => onTrackDrop(e, track)}
            >
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

          <div className="tl-playhead" style={{ left: playheadMs * pxPerMs }} />
        </div>
      </div>

      {menu && (
        <div
          className="tl-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(splitAtPlayhead)}
          >
            切割<span className="tl-menu-key">Ctrl+K</span>
          </button>
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(deleteSelectedClips)}
          >
            删除<span className="tl-menu-key">Delete</span>
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
          {/* 转场里最高频的两个动作：淡入 / 淡出（0.5 秒不透明度关键帧，
              曲线行就地展开，拖着菱形就能改） */}
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              const s = useAppStore.getState();
              if (s.selectedClipId) s.addFade(s.selectedClipId, "in");
            })}
          >
            淡入<span className="tl-menu-key">0.5s</span>
          </button>
          <button
            type="button"
            className="tl-menu-item"
            onClick={() => runMenuAction(async () => {
              const s = useAppStore.getState();
              if (s.selectedClipId) s.addFade(s.selectedClipId, "out");
            })}
          >
            淡出<span className="tl-menu-key">0.5s</span>
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
            {(() => {
              const s = useAppStore.getState();
              return s.selectedClipId !== null && s.curveExpandedClipId === s.selectedClipId
                ? "收起关键帧曲线"
                : "显示关键帧曲线";
            })()}
          </button>
        </div>
      )}
    </div>
  );
}
