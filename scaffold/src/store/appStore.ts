/**
 * 应用状态。
 *
 * 这个 store 是「图层式剪辑 + 效果栈」在代码里的落点：
 * 下半区「时间线 / 曲线编辑器」共用同一份选中态，属性面板的「效果栈」
 * 与曲线编辑器共用同一份关键帧数据，改一处两处立刻反映。
 * 不要在这里分成两套选中态，那会让融合退化成两个并排的面板。
 *
 * 工程数据不在这里安家：`project` 是后端权威快照的一份只读视图，
 * 由 `store/projectActions.ts` 通过 services 层拉回后整体替换。
 * 前端不留副本、不自己算工程结构，编辑一律走后端再把结果回填。
 */

import { create } from "zustand";
import type {
  Clip,
  Id,
  Layer3DOrientation,
  Project,
  Sequence,
  Transform3D,
} from "../types/project";
import { DEFAULT_TRANSFORM_3D } from "../types/project";
import type { GraphNode } from "../types/graph";
import type { Effect, EffectKeyframe, EffectParamValue, EffectType } from "../types/effect";
import type { ExportProgressPayload } from "../services/export";
import type { Keyframe } from "../types/keyframe";
import { evaluateCurve } from "../core/curveEval";
import { findEffect as findEffectSpec } from "../core/effectCatalog";

export type DeckTab = "timeline" | "curves";
export type ThemeMode = "dark" | "light";

/** 编辑器内的大页面：素材 / 剪辑 / 特效 / 导出，达芬奇式四页 */
export type PageTab = "media" | "edit" | "fx" | "deliver";

/** 导出任务在界面上的状态。放在 store 里，换页不丢，顶栏也看得见 */
export type ExportJobStatus = "idle" | "running" | "done" | "cancelled" | "failed";

/** 导出任务的全局状态。进度事件由 projectActions 的全局订阅写入 */
export interface ExportJobState {
  jobId: string | null;
  status: ExportJobStatus;
  progress: ExportProgressPayload;
  /** 失败时的中文原因 */
  failText: string;
  /** 本次导出的输出路径，完成后「打开所在文件夹」要用 */
  outputPath: string;
  /** 任务起始时刻（墙钟毫秒），算已用时间 */
  startedAt: number | null;
  finishedAt: number | null;
}

/** 空任务常量，避免每次选择器返回新对象导致重渲染 */
const IDLE_EXPORT_JOB: ExportJobState = {
  jobId: null,
  status: "idle",
  progress: { jobId: "", frame: 0, totalFrames: 0, etaMs: 0, stage: "" },
  failText: "",
  outputPath: "",
  startedAt: null,
  finishedAt: null,
};

/** 提示条。界面只给中文人话，不给错误码。 */
export interface Notice {
  kind: "info" | "error";
  text: string;
}

/** 空快照常量。反复返回同一个引用，避免选择器每次给它新对象导致重渲染。 */
const NO_ASSETS: Project["assets"] = [];

/**
 * 图层 3D 变换的局部补丁。嵌套的 position/rotation/anchor 只传要改的分量，
 * 这样属性面板里改一个 X，不会把 Y/Z 也覆盖掉。
 */
export interface Transform3DPatch {
  position?: Partial<Transform3D["position"]>;
  rotation?: Partial<Transform3D["rotation"]>;
  scale?: number;
  orientation?: Layer3DOrientation;
  anchor?: Partial<Transform3D["anchor"]>;
  receiveLight?: boolean;
}

interface AppState {
  /**
   * 当前工程。没打开任何工程时为 null。
   * 只读：所有写入都由后端命令完成，再把后端快照回填到这里。
   */
  project: Project | null;
  /** 播放头位置，全局时间轴的唯一权威 */
  playheadMs: number;
  /** 是否正在播放。放在 store 里，监视器按钮与全局空格键共用同一个开关 */
  playing: boolean;
  /** 播放倍速。正数正放、负数倒放，1 为常速；J/K/L 穿梭靠它 */
  playbackRate: number;
  /** 下半区当前显示哪个视图 */
  deckTab: DeckTab;
  /** 当前大页面（素材 / 剪辑 / 特效 / 导出），默认进剪辑页 */
  page: PageTab;
  theme: ThemeMode;
  /** 提示条内容，null 表示不显示 */
  notice: Notice | null;
  /** 开场界面是否显示。没有工程时必须显示；已有工程时由「新建工程」唤起 */
  startScreen: boolean;

  /**
   * 素材预览：双击素材箱条目或时间线片段时，监视器切入「素材预览」模式，
   * 直接看这段素材本身的画面（PR 源监视器的路子）。null 表示看序列。
   */
  previewAssetId: Id | null;
  /**
   * 就地展开关键帧曲线的片段 id：选中片段打了关键帧后，时间线该轨道下方
   * 就地长出一条曲线行（AE 图表编辑器内嵌在时间轴的模式）。null = 没有展开。
   */
  curveExpandedClipId: Id | null;
  /** 展开曲线行的动作：传片段 id 展开（换片段跟随），传 null 收起 */
  setCurveExpanded: (clipId: Id | null) => void;
  /** 导出任务状态。全局一份，导出页与顶栏进度胶囊共用 */
  exportJob: ExportJobState;

  /**
   * 选中态。时间线与效果栈共用这两个字段，这就是联动的实现方式。
   * 选中片段时，selectedNodeId 会被同步设为该片段在内部图里的 nodeId；
   * 选中内部节点时，如果是片段节点，selectedClipId 会被同步设为对应片段。
   */
  selectedClipId: Id | null;
  /** 时间线上的多选集合。框选与 Shift 加选都写这里，末位是「主选中」 */
  selectedClipIds: Id[];
  selectedNodeId: Id | null;

  /** 新建 / 打开工程：整体换掉，并清掉上一份工程的选中与效果视图 */
  loadProject: (project: Project) => void;
  /** 编辑之后的权威回填：只换工程数据，保留选中与效果视图 */
  syncProject: (project: Project) => void;
  /** 关闭工程，回到「未打开」态 */
  clearProject: () => void;

  /** 联动 A：在时间线上点片段 → 效果栈定位并高亮该片段的效果 */
  selectClip: (clipId: Id) => void;
  /** 框选 / Shift 加选：一次写入多个片段，末位作为主选中去联动效果栈 */
  selectClips: (clipIds: Id[]) => void;
  /** 联动 B：在效果栈点某效果 → 时间线定位到片段，播放头跳到入点 */
  selectNode: (nodeId: Id) => void;
  clearSelection: () => void;

  setPlayhead: (ms: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  /** J/K/L 穿梭：dir 正 / 负表示方向，同向连按加倍，反向回到一倍 */
  shuttle: (dir: 1 | -1) => void;
  /** 停止并复位倍速，K 键与逐帧都用它 */
  pause: () => void;
  setDeckTab: (tab: DeckTab) => void;
  /** 切换大页面（素材 / 剪辑 / 特效 / 导出） */
  setPage: (page: PageTab) => void;
  /** 打开开场界面——新建工程时在这儿挑画幅 / 帧率 / 色彩空间 */
  showStartScreen: () => void;
  /** 收起开场界面，回到编辑器 */
  hideStartScreen: () => void;
  toggleTheme: () => void;

  pushNotice: (kind: Notice["kind"], text: string) => void;
  dismissNotice: () => void;

  /** 素材预览：传入素材 id 进入预览，传 null 回到序列预览 */
  setPreviewAsset: (assetId: Id | null) => void;

  /** 导出任务开始：登记 jobId 与输出路径，状态置为运行中 */
  beginExportJob: (jobId: string, outputPath: string) => void;
  /** 进度事件回填（全局订阅调用）。终态 stage 由这里一并落定 */
  applyExportProgress: (payload: ExportProgressPayload) => void;
  /** 启动导出失败：直接落失败态，不必等事件 */
  failExportJob: (text: string) => void;
  /** 复位到空闲态，以便再次导出 */
  resetExportJob: () => void;

  /** 旁路：数据直通但效果保留 */
  toggleBypass: (nodeId: Id) => void;
  setNodeParam: (nodeId: Id, key: string, value: number | string | boolean) => void;

  /** 片段右键勾选「启用 3D」：开时补一份默认变换，关时清空（docs/09 第 2.3 节） */
  setClip3DEnabled: (clipId: Id, enabled: boolean) => void;
  /** 修改片段的 3D 变换属性 */
  setClipTransform3D: (clipId: Id, patch: Transform3DPatch) => void;

  // ---- 效果栈（图层式）----
  /** 片段 id → 效果列表，数组顺序即渲染顺序 */
  effects: Record<Id, Effect[]>;
  /** 效果栈里当前选中的效果卡片 */
  selectedEffectId: Id | null;
  /** 效果参数关键帧，全局一份，靠 effectId 归属 */
  effectKeyframes: EffectKeyframe[];
  /** 曲线编辑器里被框选中的关键帧 id */
  selectedKeyframeIds: Id[];

  selectEffect: (effectId: Id | null) => void;
  addEffect: (clipId: Id, type: EffectType) => void;
  /** AE 式「应用后聚焦」：加完效果展开并选中新效果，效果控件一眼看到它 */
  removeEffect: (effectId: Id) => void;
  toggleEffectBypass: (effectId: Id) => void;
  toggleEffectCollapsed: (effectId: Id) => void;
  /** 上下拖动改序：把 fromIndex 的效果插到 toIndex 位置 */
  reorderEffects: (clipId: Id, fromIndex: number, toIndex: number) => void;
  /** 全部折叠 / 全部展开：Alt 点折叠箭头时联动所有效果（AE 的联动折叠） */
  setAllEffectsCollapsed: (clipId: Id, collapsed: boolean) => void;
  /** 重置效果：参数回出厂默认、解除旁路、清掉这条效果的关键帧（PR 的 Reset Effect） */
  resetEffect: (effectId: Id) => void;
  /**
   * 给片段加淡入 / 淡出（转场里最高频的两个动作，PR 的 Cross Dissolve 拆开就是它）：
   * 挂一个不透明度效果，在片段首/尾 0.5 秒处打 0→100 / 100→0 的关键帧。
   * 已有不透明度效果时复用它，不重复挂。
   */
  addFade: (clipId: Id, kind: "in" | "out") => void;
  /** 改参数值；若该参数已打关键帧，同时在播放头处更新曲线 */
  setEffectParam: (effectId: Id, key: string, value: EffectParamValue) => void;
  /** 秒表开关：打开且尚无关键帧时，在播放头处补一个关键帧 */
  toggleEffectParamAnimation: (effectId: Id, key: string) => void;
  /** 在指定时刻写入 / 更新一个关键帧 */
  upsertEffectKeyframe: (effectId: Id, param: string, timeMs: number, value: number) => void;
  /** 批量更新关键帧位置（曲线编辑器拖动 / 框选后整体移动） */
  updateEffectKeyframes: (updates: Array<{ id: Id; timeMs: number; value: number }>) => void;
  setSelectedKeyframeIds: (ids: Id[]) => void;
  /**
   * 关键帧导航器（AE / PR 的 ◀ ◆ ▶，蒸馏自 FilmCraft `keyframe_nav`）：
   * -1 跳上一个关键帧、+1 跳下一个、0 在播放头处增删关键帧。
   * 播放头落到关键帧时刻并顺带选中它，返回是否动过。
   */
  navEffectKeyframe: (effectId: Id, param: string, dir: -1 | 0 | 1) => void;
  /** 该参数在播放头处是否正好有关键帧（决定菱形是实心还是空心） */
  hasKeyframeAtPlayhead: (effectId: Id, param: string) => boolean;
}

/**
 * 效果类型 → 中文名与默认参数，用于「加效果」。
 * 权威清单在 `core/effectCatalog.ts`（docs/02 第 D3 节），这里只做一次转换。
 */
function effectPreset(type: EffectType): { name: string; params: Effect["params"] } {
  const entry = findEffectSpec(type);
  if (!entry) {
    // 注册表里没有的类型不该出现，兜底成一张空卡片，别让界面崩掉。
    return { name: type, params: [] };
  }
  return {
    name: entry.label,
    params: entry.params.map((p) => ({
      key: p.key,
      label: p.label,
      value: p.value,
      ...(p.min !== undefined ? { min: p.min } : {}),
      ...(p.max !== undefined ? { max: p.max } : {}),
      ...(p.step !== undefined ? { step: p.step } : {}),
      animated: false,
    })),
  };
}

/** 在 effects 里就地改一张卡片，返回新的 effects 快照。 */
function mapEffect(
  effects: Record<Id, Effect[]>,
  effectId: Id,
  fn: (effect: Effect) => Effect
): Record<Id, Effect[]> {
  const next = { ...effects };
  for (const clipId of Object.keys(next)) {
    const list = next[clipId];
    const idx = list.findIndex((e) => e.id === effectId);
    if (idx >= 0) {
      const arr = list.slice();
      arr[idx] = fn(arr[idx]);
      next[clipId] = arr;
      break;
    }
  }
  return next;
}

/** 按 id 找一张效果卡片。 */
function findEffect(effects: Record<Id, Effect[]>, effectId: Id): Effect | null {
  for (const list of Object.values(effects)) {
    const hit = list.find((e) => e.id === effectId);
    if (hit) return hit;
  }
  return null;
}

/** 本地 id 生成，用于效果卡片与关键帧这类只存在于前端视图的临时标识。 */
let localUid = 0;
function newLocalId(prefix: string): Id {
  localUid += 1;
  return `${prefix}-${Date.now().toString(36)}-${localUid.toString(36)}`;
}

/** 该参数在播放头处的求值，走与渲染同一条曲线引擎；没有关键帧给 fallback */
function evaluateKeyframeAt(list: EffectKeyframe[], timeMs: number, fallback = 0): number {
  if (list.length === 0) return fallback;
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
  return evaluateCurve(mapped, timeMs) ?? fallback;
}

/** 在 (effectId, param) 曲线上写一个关键帧：toleranceMs 内命中就改，否则新增。 */
function upsertKeyframeRaw(
  list: EffectKeyframe[],
  effectId: Id,
  param: string,
  timeMs: number,
  value: number,
  toleranceMs = 1
): EffectKeyframe[] {
  const idx = list.findIndex(
    (k) =>
      k.effectId === effectId &&
      k.param === param &&
      Math.abs(k.timeMs - timeMs) <= toleranceMs
  );
  if (idx >= 0) {
    const arr = list.slice();
    arr[idx] = { ...arr[idx], timeMs, value };
    return arr;
  }
  const kf: EffectKeyframe = {
    id: newLocalId("kf"),
    effectId,
    param,
    timeMs,
    value,
    easing: "linear",
    inTangent: { x: 0, y: 0 },
    outTangent: { x: 0, y: 0 },
  };
  return [...list, kf];
}

/** 对某个片段做不可变更新，返回新的项目快照；找不到片段则原样返回。 */
function mapClip(project: Project, clipId: Id, fn: (clip: Clip) => Clip): Project {
  let hit = false;
  const sequences = project.sequences.map((seq) => {
    const tracks = seq.tracks.map((track) => {
      const idx = track.clips.findIndex((c) => c.id === clipId);
      if (idx < 0) return track;
      hit = true;
      const clips = track.clips.slice();
      clips[idx] = fn(clips[idx]);
      return { ...track, clips };
    });
    return hit ? { ...seq, tracks } : seq;
  });
  return hit ? { ...project, sequences } : project;
}

function findClip(project: Project, clipId: Id): Clip | null {
  for (const seq of project.sequences) {
    for (const track of seq.tracks) {
      const hit = track.clips.find((c) => c.id === clipId);
      if (hit) return hit;
    }
  }
  return null;
}

function findClipByNode(project: Project, nodeId: Id): Clip | null {
  for (const seq of project.sequences) {
    for (const track of seq.tracks) {
      const hit = track.clips.find((c) => c.nodeId === nodeId);
      if (hit) return hit;
    }
  }
  return null;
}

/** 该片段在内部图里的节点是否处于旁路状态，用于时间线上给片段打标记 */
export function isClipNodeBypassed(project: Project, clip: Clip): boolean {
  for (const graph of Object.values(project.graphs)) {
    const node = graph.nodes.find((n) => n.id === clip.nodeId);
    if (node) return node.bypassed;
  }
  return false;
}

export const useAppStore = create<AppState>((set, get) => ({
  // 未打开工程就是 null，界面据此显示「新建 / 打开」引导，不拿假数据充数。
  project: null,
  playheadMs: 0,
  playing: false,
  playbackRate: 1,
  deckTab: "timeline",
  // 达芬奇口径：进编辑器先落在素材页选素材，再进剪辑页干活。
  page: "media",
  // 默认浅色：白 + 浅绿是主用主题，深色只是备选（见 tokens.css 顶部说明）。
  theme: "light",
  notice: null,
  // 启动即停在开场：没有工程时不铺空面板，先让用户把画幅定下来
  startScreen: true,
  previewAssetId: null,
  curveExpandedClipId: null,
  exportJob: IDLE_EXPORT_JOB,
  selectedClipId: null,
  selectedClipIds: [],
  selectedNodeId: null,
  effects: {},
  selectedEffectId: null,
  effectKeyframes: [],
  selectedKeyframeIds: [],

  loadProject: (project) =>
    set({
      project,
      startScreen: false,
      playheadMs: 0,
      playing: false,
      playbackRate: 1,
      previewAssetId: null,
      curveExpandedClipId: null,
      exportJob: IDLE_EXPORT_JOB,
      selectedClipId: null,
      selectedClipIds: [],
      selectedNodeId: null,
      // 效果卡片与关键帧是上一份工程的视图状态，换工程要一起清掉
      effects: {},
      selectedEffectId: null,
      effectKeyframes: [],
      selectedKeyframeIds: [],
    }),

  syncProject: (project) => set({ project }),

  clearProject: () =>
    set({
      project: null,
      // 关掉工程就回开场，不留一个空壳编辑器在屏幕上
      startScreen: true,
      playheadMs: 0,
      playing: false,
      playbackRate: 1,
      previewAssetId: null,
      curveExpandedClipId: null,
      exportJob: IDLE_EXPORT_JOB,
      selectedClipId: null,
      selectedClipIds: [],
      selectedNodeId: null,
      effects: {},
      selectedEffectId: null,
      effectKeyframes: [],
      selectedKeyframeIds: [],
    }),

  selectClip: (clipId) => {
    const project = get().project;
    if (!project) return;
    const clip = findClip(project, clipId);
    if (!clip) return;
    // 联动：片段 → 内部节点（时间线上的旁路 / 关键帧标记仍靠内部节点）；
    // 效果栈随片段切换，清掉上一个片段遗留的效果选中与框选
    set({
      selectedClipId: clipId,
      selectedClipIds: [clipId],
      selectedNodeId: clip.nodeId,
      selectedEffectId: null,
      selectedKeyframeIds: [],
    });
  },

  selectClips: (clipIds) => {
    const project = get().project;
    const primary = clipIds.length > 0 ? clipIds[clipIds.length - 1] : null;
    if (!project || primary === null) {
      set({
        selectedClipId: null,
        selectedClipIds: [],
        selectedNodeId: null,
        selectedEffectId: null,
        selectedKeyframeIds: [],
      });
      return;
    }
    const clip = findClip(project, primary);
    // 多选改的是片段集合，效果栈只认主选中那一个，跟着刷新
    set({
      selectedClipId: primary,
      selectedClipIds: clipIds,
      selectedNodeId: clip?.nodeId ?? null,
      selectedEffectId: null,
      selectedKeyframeIds: [],
    });
  },

  selectNode: (nodeId) => {
    const project = get().project;
    const clip = project ? findClipByNode(project, nodeId) : null;
    if (clip) {
      // 联动：内部节点 → 片段，并把播放头跳到片段入点
      set({
        selectedNodeId: nodeId,
        selectedClipId: clip.id,
        selectedClipIds: [clip.id],
        playheadMs: clip.startMs,
      });
    } else {
      set({ selectedNodeId: nodeId, selectedClipId: null, selectedClipIds: [] });
    }
  },

  clearSelection: () =>
    set({ selectedClipId: null, selectedClipIds: [], selectedNodeId: null }),

  setPlayhead: (ms) => set({ playheadMs: Math.max(0, ms) }),
  setPlaying: (playing) => set({ playing }),
  togglePlaying: () =>
    set((state) => (state.playing ? { playing: false } : { playing: true, playbackRate: 1 })),

  shuttle: (dir) =>
    set((state) => {
      // 还没开始播：起步就是一倍速，方向由按键决定
      if (!state.playing) return { playing: true, playbackRate: dir };
      // 正在反方向播：先掰回本方向的一倍速
      if (Math.sign(state.playbackRate) !== dir) return { playbackRate: dir };
      // 同向连按：一倍 → 二倍 → 四倍 → 八倍封顶
      const magnitude = Math.min(Math.abs(state.playbackRate) * 2, 8);
      return { playbackRate: magnitude * dir };
    }),

  pause: () => set({ playing: false, playbackRate: 1 }),
  setDeckTab: (tab) => set({ deckTab: tab }),
  setPage: (page) => set({ page }),
  showStartScreen: () => set({ startScreen: true }),
  hideStartScreen: () => set({ startScreen: false }),
  toggleTheme: () => set({ theme: get().theme === "dark" ? "light" : "dark" }),

  pushNotice: (kind, text) => set({ notice: { kind, text } }),
  dismissNotice: () => set({ notice: null }),

  setPreviewAsset: (assetId) => set({ previewAssetId: assetId }),

  setCurveExpanded: (clipId) => set({ curveExpandedClipId: clipId }),

  beginExportJob: (jobId, outputPath) =>
    set({
      exportJob: {
        ...IDLE_EXPORT_JOB,
        jobId,
        status: "running",
        outputPath,
        startedAt: Date.now(),
      },
    }),

  applyExportProgress: (payload) =>
    set((state) => {
      const job = state.exportJob;
      // 只认自己发起的任务；任务还没回 jobId 时把第一个事件认领为本任务
      if (job.status !== "running") return {};
      if (job.jobId !== null && payload.jobId !== job.jobId) return {};
      const jobId = payload.jobId || job.jobId || "";
      const progress = { ...payload, jobId };

      if (payload.stage === "已完成") {
        return {
          exportJob: { ...job, jobId, progress, status: "done", finishedAt: Date.now() },
        };
      }
      if (payload.stage === "已取消") {
        return {
          exportJob: { ...job, jobId, progress, status: "cancelled", finishedAt: Date.now() },
        };
      }
      if (payload.stage.startsWith("失败")) {
        return {
          exportJob: {
            ...job,
            jobId,
            progress,
            status: "failed",
            failText: payload.stage,
            finishedAt: Date.now(),
          },
        };
      }
      return { exportJob: { ...job, jobId, progress } };
    }),

  failExportJob: (text) =>
    set((state) =>
      state.exportJob.status === "running"
        ? {
            exportJob: {
              ...state.exportJob,
              status: "failed",
              failText: text,
              finishedAt: Date.now(),
            },
          }
        : {}
    ),

  resetExportJob: () => set({ exportJob: IDLE_EXPORT_JOB }),

  toggleBypass: (nodeId) =>
    set((state) => {
      if (!state.project) return {};
      const graphs = { ...state.project.graphs };
      for (const key of Object.keys(graphs)) {
        const graph = graphs[key];
        const idx = graph.nodes.findIndex((n) => n.id === nodeId);
        if (idx >= 0) {
          const nodes = graph.nodes.slice();
          nodes[idx] = { ...nodes[idx], bypassed: !nodes[idx].bypassed };
          graphs[key] = { ...graph, nodes };
          break;
        }
      }
      return { project: { ...state.project, graphs } };
    }),

  setNodeParam: (nodeId, key, value) =>
    set((state) => {
      if (!state.project) return {};
      const graphs = { ...state.project.graphs };
      for (const gkey of Object.keys(graphs)) {
        const graph = graphs[gkey];
        const idx = graph.nodes.findIndex((n) => n.id === nodeId);
        if (idx >= 0) {
          const nodes = graph.nodes.slice();
          const node: GraphNode = nodes[idx];
          nodes[idx] = { ...node, params: { ...node.params, [key]: value } };
          graphs[gkey] = { ...graph, nodes };
          break;
        }
      }
      return { project: { ...state.project, graphs } };
    }),

  setClip3DEnabled: (clipId, enabled) =>
    set((state) => {
      if (!state.project) return {};
      return {
        project: mapClip(state.project, clipId, (clip) => {
          if (!enabled) return { ...clip, enable3D: false, transform3D: undefined };
          return {
            ...clip,
            enable3D: true,
            // 已有时保留用户改过的值，避免反复开关把参数洗掉
            transform3D: clip.transform3D ?? { ...DEFAULT_TRANSFORM_3D },
          };
        }),
      };
    }),

  setClipTransform3D: (clipId, patch) =>
    set((state) => {
      if (!state.project) return {};
      return {
        project: mapClip(state.project, clipId, (clip) => {
          const base = clip.transform3D ?? DEFAULT_TRANSFORM_3D;
          const next: Transform3D = {
            ...base,
            position: { ...base.position, ...patch.position },
            rotation: { ...base.rotation, ...patch.rotation },
            anchor: { ...base.anchor, ...patch.anchor },
          };
          if (patch.scale !== undefined) next.scale = patch.scale;
          if (patch.orientation !== undefined) next.orientation = patch.orientation;
          if (patch.receiveLight !== undefined) next.receiveLight = patch.receiveLight;
          return { ...clip, enable3D: true, transform3D: next };
        }),
      };
    }),

  // ---- 效果栈动作（图层式）----

  selectEffect: (effectId) => set({ selectedEffectId: effectId }),

  addEffect: (clipId, type) =>
    set((state) => {
      const preset = effectPreset(type);
      const effect: Effect = {
        id: newLocalId(`fx-${type}`),
        clipId,
        type,
        name: preset.name,
        bypassed: false,
        collapsed: false,
        // 深拷贝参数，避免多次添加共用同一份引用
        params: preset.params.map((p) => ({ ...p })),
      };
      const list = state.effects[clipId] ?? [];
      return {
        effects: { ...state.effects, [clipId]: [...list, effect] },
        selectedEffectId: effect.id,
      };
    }),

  removeEffect: (effectId) =>
    set((state) => {
      const effects: Record<Id, Effect[]> = {};
      for (const clipId of Object.keys(state.effects)) {
        effects[clipId] = state.effects[clipId].filter((e) => e.id !== effectId);
      }
      return {
        effects,
        effectKeyframes: state.effectKeyframes.filter((k) => k.effectId !== effectId),
        selectedEffectId:
          state.selectedEffectId === effectId ? null : state.selectedEffectId,
      };
    }),

  toggleEffectBypass: (effectId) =>
    set((state) => ({
      effects: mapEffect(state.effects, effectId, (e) => ({
        ...e,
        bypassed: !e.bypassed,
      })),
    })),

  toggleEffectCollapsed: (effectId) =>
    set((state) => ({
      effects: mapEffect(state.effects, effectId, (e) => ({
        ...e,
        collapsed: !e.collapsed,
      })),
    })),

  reorderEffects: (clipId, fromIndex, toIndex) =>
    set((state) => {
      const list = state.effects[clipId];
      if (!list) return {};
      if (
        fromIndex < 0 ||
        fromIndex >= list.length ||
        toIndex < 0 ||
        toIndex >= list.length ||
        fromIndex === toIndex
      ) {
        return {};
      }
      const arr = list.slice();
      const [moved] = arr.splice(fromIndex, 1);
      arr.splice(toIndex, 0, moved);
      return { effects: { ...state.effects, [clipId]: arr } };
    }),

  setAllEffectsCollapsed: (clipId, collapsed) =>
    set((state) => {
      const list = state.effects[clipId];
      if (!list) return {};
      return {
        effects: {
          ...state.effects,
          [clipId]: list.map((e) => ({ ...e, collapsed })),
        },
      };
    }),

  addFade: (clipId, kind) =>
    set((state) => {
      if (!state.project) return {};
      // 找到片段，算出淡变区间
      let target: Clip | null = null;
      for (const seq of state.project.sequences) {
        for (const track of seq.tracks) {
          const hit = track.clips.find((c) => c.id === clipId);
          if (hit) {
            target = hit;
            break;
          }
        }
        if (target) break;
      }
      if (!target) return {};

      const fadeMs = Math.min(500, target.durationMs / 2);
      const edgeMs = kind === "in" ? target.startMs : target.startMs + target.durationMs;
      const innerMs = kind === "in" ? edgeMs + fadeMs : edgeMs - fadeMs;

      // 已有不透明度效果就复用，没有就挂一个（照 catalog 默认值）
      const existing = (state.effects[clipId] ?? []).find((e) => e.type === "opacity");
      let effectId: Id;
      let effects = state.effects;
      if (existing) {
        effectId = existing.id;
      } else {
        const preset = effectPreset("opacity");
        const effect: Effect = {
          id: newLocalId("fx-opacity"),
          clipId,
          type: "opacity",
          name: preset.name,
          bypassed: false,
          collapsed: false,
          params: preset.params.map((p) => ({ ...p })),
        };
        effectId = effect.id;
        effects = { ...state.effects, [clipId]: [...(state.effects[clipId] ?? []), effect] };
      }

      // 在边缘与内侧各打一个关键帧：入点 0→100，出点 100→0
      const opacityParam = (state.effects[clipId] ?? [])
        .concat(existing ? [existing] : [])
        .find((e) => e.id === effectId)
        ?.params.find((p) => p.key === "opacity");
      const baseValue = typeof opacityParam?.value === "number" ? opacityParam.value : 100;
      const edgeValue = kind === "in" ? 0 : baseValue;
      const innerValue = kind === "in" ? baseValue : 0;

      let keyframes = state.effectKeyframes.filter(
        (k) => !(k.effectId === effectId && k.param === "opacity")
      );
      keyframes = upsertKeyframeRaw(keyframes, effectId, "opacity", edgeMs, edgeValue);
      keyframes = upsertKeyframeRaw(keyframes, effectId, "opacity", innerMs, innerValue);

      return {
        effects,
        effectKeyframes: keyframes,
        curveExpandedClipId: clipId,
        selectedEffectId: effectId,
      };
    }),

  resetEffect: (effectId) =>
    set((state) => {
      const target = findEffect(state.effects, effectId);
      if (!target) return {};
      // 参数回出厂默认（照 effectCatalog 的默认值重建），旁路解除，秒表全关
      const preset = effectPreset(target.type);
      const effects = mapEffect(state.effects, effectId, (e) => ({
        ...e,
        bypassed: false,
        params: preset.params.map((p) => {
          const keep = e.params.find((old) => old.key === p.key);
          return keep ? { ...keep, value: p.value, animated: false } : { ...p };
        }),
      }));
      return {
        effects,
        // 这条效果的关键帧一并清掉：参数都回默认了，留着曲线只会添乱
        effectKeyframes: state.effectKeyframes.filter((k) => k.effectId !== effectId),
        selectedKeyframeIds: [],
      };
    }),

  setEffectParam: (effectId, key, value) =>
    set((state) => {
      const target = findEffect(state.effects, effectId);
      const effects = mapEffect(state.effects, effectId, (e) => ({
        ...e,
        params: e.params.map((p) => (p.key === key ? { ...p, value } : p)),
      }));

      // 已打关键帧的数值参数：改值时同步在播放头处更新曲线
      const param = target?.params.find((p) => p.key === key);
      if (!param?.animated || typeof value !== "number") return { effects };
      return {
        effects,
        effectKeyframes: upsertKeyframeRaw(
          state.effectKeyframes,
          effectId,
          key,
          state.playheadMs,
          value
        ),
      };
    }),

  toggleEffectParamAnimation: (effectId, key) =>
    set((state) => {
      const target = findEffect(state.effects, effectId);
      const param = target?.params.find((p) => p.key === key);
      if (!target || !param) return {};
      const turningOn = !param.animated;

      const effects = mapEffect(state.effects, effectId, (e) => ({
        ...e,
        params: e.params.map((p) => (p.key === key ? { ...p, animated: turningOn } : p)),
      }));

      if (!turningOn) {
        // 关掉秒表 = 清除该参数曲线，避免留下看不见的动画
        return {
          effects,
          effectKeyframes: state.effectKeyframes.filter(
            (k) => !(k.effectId === effectId && k.param === key)
          ),
        };
      }
      // 打开秒表：数值参数且尚无关键帧时，在播放头处补一个
      if (typeof param.value !== "number") return { effects };
      const existing = state.effectKeyframes.some(
        (k) => k.effectId === effectId && k.param === key
      );
      if (existing) return { effects };
      return {
        effects,
        effectKeyframes: upsertKeyframeRaw(
          state.effectKeyframes,
          effectId,
          key,
          state.playheadMs,
          param.value
        ),
      };
    }),

  upsertEffectKeyframe: (effectId, param, timeMs, value) =>
    set((state) => ({
      effectKeyframes: upsertKeyframeRaw(
        state.effectKeyframes,
        effectId,
        param,
        timeMs,
        value
      ),
    })),

  updateEffectKeyframes: (updates) =>
    set((state) => {
      if (updates.length === 0) return {};
      const byId = new Map(updates.map((u) => [u.id, u]));
      return {
        effectKeyframes: state.effectKeyframes.map((k) => {
          const u = byId.get(k.id);
          if (!u) return k;
          return { ...k, timeMs: Math.max(0, u.timeMs), value: u.value };
        }),
      };
    }),

  setSelectedKeyframeIds: (ids) => set({ selectedKeyframeIds: ids }),

  navEffectKeyframe: (effectId, param, dir) =>
    set((state) => {
      const list = state.effectKeyframes.filter(
        (k) => k.effectId === effectId && k.param === param
      );
      const at = state.playheadMs;
      // 命中半径给半帧，与「在播放头处增删关键帧」的判定口径一致
      const frame = state.project?.sequences[0]?.frameRate ?? 25;
      const tolerance = 500 / frame;

      if (dir === 0) {
        const hit = list.find((k) => Math.abs(k.timeMs - at) <= tolerance);
        if (hit) {
          // 删掉这一帧的关键帧；删完就没人管这条曲线了
          const rest = state.effectKeyframes.filter((k) => k.id !== hit.id);
          return {
            effectKeyframes: rest,
            selectedKeyframeIds: state.selectedKeyframeIds.filter((id) => id !== hit.id),
          };
        }
        // 没有就补一个：值取当前参数值，没动画则先点亮秒表
        const target = findEffect(state.effects, effectId);
        const paramDef = target?.params.find((p) => p.key === param);
        const value =
          paramDef && typeof paramDef.value === "number"
            ? paramDef.value
            : list.length > 0
              ? evaluateKeyframeAt(list, at)
              : 0;
        return {
          effectKeyframes: upsertKeyframeRaw(state.effectKeyframes, effectId, param, at, value),
          effects:
            paramDef && !paramDef.animated
              ? mapEffect(state.effects, effectId, (e) => ({
                  ...e,
                  params: e.params.map((p) => (p.key === param ? { ...p, animated: true } : p)),
                }))
              : state.effects,
        };
      }

      const candidates = list
        .filter((k) => (dir < 0 ? k.timeMs < at - tolerance : k.timeMs > at + tolerance))
        .sort((a, b) => (dir < 0 ? b.timeMs - a.timeMs : a.timeMs - b.timeMs));
      const target = candidates[0];
      if (!target) return {};
      return { playheadMs: target.timeMs, selectedKeyframeIds: [target.id] };
    }),

  hasKeyframeAtPlayhead: (effectId, param) => {
    const state = get();
    const frame = state.project?.sequences[0]?.frameRate ?? 25;
    const tolerance = 500 / frame;
    return state.effectKeyframes.some(
      (k) =>
        k.effectId === effectId &&
        k.param === param &&
        Math.abs(k.timeMs - state.playheadMs) <= tolerance
    );
  },
}));

/** 取当前选中片段在内部图里对应的节点对象 */
export function useSelectedNode(): GraphNode | null {
  const project = useAppStore((s) => s.project);
  const nodeId = useAppStore((s) => s.selectedNodeId);
  if (!project || !nodeId) return null;
  for (const graph of Object.values(project.graphs)) {
    const hit = graph.nodes.find((n) => n.id === nodeId);
    if (hit) return hit;
  }
  return null;
}

/** 取当前选中的片段对象 */
export function useSelectedClip(): Clip | null {
  const project = useAppStore((s) => s.project);
  const clipId = useAppStore((s) => s.selectedClipId);
  if (!project || !clipId) return null;
  return findClip(project, clipId);
}

/** 取当前序列；未打开工程时返回 undefined */
export function useCurrentSequence(): Sequence | undefined {
  return useAppStore((s) => s.project?.sequences[0]);
}

/** 取当前工程的素材表；未打开工程时返回稳定的空数组 */
export function useAssets(): Project["assets"] {
  return useAppStore((s) => s.project?.assets ?? NO_ASSETS);
}
