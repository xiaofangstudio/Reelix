/**
 * 工程动作编排。
 *
 * 组件不直接碰 services，也不自己拼多步流程：新建、打开、保存、另存、导入、
 * 撤销重做这些跨越多个后端命令的动作集中到这里。每一步做完，都用后端返回的
 * 权威快照回填 store，前端不留第二份工程数据——这是「界面与后端接上」的规矩。
 *
 * 失败一律转成中文人话提示，不把错误码或英文堆栈丢到界面上。
 */

import { useAppStore } from "./appStore";
import type { Asset, Clip, Id, Project, Track } from "../types/project";
import type { ProjectSettings } from "../services/project";
import { dialog, exportApi, history, media, project as projectApi, render as renderApi, subtitle, timeline } from "../services";
import { rememberRecentProject } from "../core/recentProjects";

/** 没起名字时用的默认工程名 */
const DEFAULT_PROJECT_NAME = "未命名项目";

/** 开场界面不填时的默认画幅：1920×1080 / 25fps / Rec.709 */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  width: 1920,
  height: 1080,
  frameRate: 25,
  colorSpace: "Rec.709",
};

/** 素材探测不出时长时的兜底片段长度，避免放上轨道只剩一格 */
const FALLBACK_CLIP_MS = 5000;

/**
 * 把后端抛出来的东西转成一句中文。Rust 侧的错误本来就是中文人话，
 * 直接透传；遇到意外类型给一句兜底，绝不把英文对象塞进提示条。
 */
function toMessage(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim() !== "") return err;
  if (err instanceof Error && err.message.trim() !== "") return err.message;
  return fallback;
}

/** 统一的失败提示。 */
function reportFailure(err: unknown, fallback: string): void {
  useAppStore.getState().pushNotice("error", toMessage(err, fallback));
}

/** 从后端拉一份权威快照回填界面；顺手丢掉已经不存在的选中项。 */
export async function refreshProject(): Promise<Project | null> {
  if (!useAppStore.getState().project) return null;
  try {
    const project = await projectApi.getProject();
    const store = useAppStore.getState();
    store.syncProject(project);
    pruneSelection(project);
    return project;
  } catch (err) {
    reportFailure(err, "读取项目失败");
    return null;
  }
}

/** 选中项在后端已经不存在时清掉，避免属性面板挂着一个空片段。 */
function pruneSelection(project: Project): void {
  const state = useAppStore.getState();
  if (state.selectedClipIds.length === 0 && !state.selectedClipId) return;

  const alive = new Set<Id>();
  for (const seq of project.sequences) {
    for (const track of seq.tracks) {
      for (const clip of track.clips) alive.add(clip.id);
    }
  }

  const kept = state.selectedClipIds.filter((id) => alive.has(id));
  const primaryAlive = state.selectedClipId !== null && alive.has(state.selectedClipId);

  // 集合里一个都不剩：主选中还在就退回单选，否则整体清空
  if (kept.length === 0) {
    if (primaryAlive && state.selectedClipId) state.selectClips([state.selectedClipId]);
    else state.clearSelection();
    return;
  }
  // 有增删才回写，避免每次回填都触发一次无谓的重渲染
  if (kept.length !== state.selectedClipIds.length || !primaryAlive) {
    state.selectClips(kept);
  }
}

/**
 * 应用启动时调一次：后端若已经打开了工程就回填，否则把界面置为「未打开」。
 * 没有工程不是错误，不弹提示，界面显示新建 / 打开引导即可。
 */
export async function bootstrapProject(): Promise<void> {
  try {
    const project = await projectApi.getProject();
    useAppStore.getState().loadProject(project);
  } catch {
    useAppStore.getState().clearProject();
  }
}

/**
 * 全局订阅导出进度，App 启动时调一次。
 *
 * 导出是后台真编码，动辄几分钟——用户不可能守在导出页。
 * 进度一律进 store，导出页与顶栏的「导出中 xx%」胶囊共用同一份状态，
 * 中途切去剪辑、特效页都不丢，完成后顶栏下方提示条会告知一声。
 */
export async function initExportProgress(): Promise<() => void> {
  return exportApi.onExportProgress((payload) => {
    const before = useAppStore.getState().exportJob.status;
    useAppStore.getState().applyExportProgress(payload);
    const after = useAppStore.getState().exportJob.status;
    if (before === "running" && after === "done") {
      useAppStore.getState().pushNotice("info", "导出完成，成片已保存");
    }
  });
}

/** 打开开场界面：新建工程前先把工程名与画幅定下来。 */
export function openStartScreen(): void {
  useAppStore.getState().showStartScreen();
}

/** 新建工程。工程名与画幅设置都来自开场界面；成功后落到编辑器。 */
export async function newProject(
  name = DEFAULT_PROJECT_NAME,
  settings: ProjectSettings = DEFAULT_PROJECT_SETTINGS
): Promise<boolean> {
  try {
    const project = await projectApi.newProject(name, settings);
    const store = useAppStore.getState();
    store.loadProject(project);
    store.pushNotice("info", `已新建工程《${project.name}》`);
    return true;
  } catch (err) {
    reportFailure(err, "新建工程失败");
    return false;
  }
}

/** 打开工程：先弹系统打开框，用户取消就什么都不做。 */
export async function openProject(): Promise<boolean> {
  try {
    const path = await dialog.pickProjectFile();
    if (!path) return false;
    return openProjectAt(path);
  } catch (err) {
    reportFailure(err, "打开工程失败");
    return false;
  }
}

/** 按已知路径直接打开——开场界面的「打开最近工程」用它，不再多弹一次框。 */
export async function openProjectAt(path: string): Promise<boolean> {
  try {
    const project = await projectApi.openProject(path);
    const store = useAppStore.getState();
    store.loadProject(project);
    rememberRecentProject(path, project.name);
    store.pushNotice("info", `已打开《${project.name}》`);
    return true;
  } catch (err) {
    reportFailure(err, "打开工程失败");
    return false;
  }
}

/**
 * 保存工程。从未保存过的工程先弹保存框问路径，已经保存过的直接写回原处。
 * 返回是否真的落盘（用户取消保存框时为 false）。
 */
export async function saveProject(): Promise<boolean> {
  const project = useAppStore.getState().project;
  if (!project) return false;
  try {
    let target = await projectApi.getProjectPath();
    if (!target) {
      target = await dialog.pickSavePath(`${project.name}.reelix`);
      if (!target) return false;
    }
    const result = await projectApi.saveProject(target);
    rememberRecentProject(result.path, project.name);
    useAppStore.getState().pushNotice("info", `已保存到 ${result.path}`);
    return true;
  } catch (err) {
    reportFailure(err, "保存工程失败");
    return false;
  }
}

/** 另存为：不管有没有保存过，都重新弹保存框。 */
export async function saveProjectAs(): Promise<boolean> {
  const project = useAppStore.getState().project;
  if (!project) return false;
  try {
    const target = await dialog.pickSavePath(`${project.name}.reelix`);
    if (!target) return false;
    const result = await projectApi.saveProject(target);
    rememberRecentProject(result.path, project.name);
    useAppStore.getState().pushNotice("info", `已另存为 ${result.path}`);
    return true;
  } catch (err) {
    reportFailure(err, "另存为失败");
    return false;
  }
}

/** 关闭工程，回到「未打开」态。 */
export async function closeProject(): Promise<void> {
  try {
    await projectApi.closeProject();
    useAppStore.getState().clearProject();
  } catch (err) {
    reportFailure(err, "关闭工程失败");
  }
}

/**
 * 导入素材。素材只进素材箱，**不自动上轨**——
 * 达芬奇 / PR 的规矩：导入是收料，上轨由用户手动拖拽决定落点。
 * 想上轨就把素材从素材箱拖到时间线的某条轨道上（见 TimelineView 的拖放处理）。
 */
export async function importMedia(): Promise<boolean> {
  const store = useAppStore.getState();
  if (!store.project) {
    store.pushNotice("error", "先新建或打开一个工程，再导入素材");
    return false;
  }
  try {
    const paths = await dialog.pickMediaFiles();
    if (paths.length === 0) return false;

    const added = await media.importMedia(paths);
    if (added.length === 0) {
      store.pushNotice("info", "这些素材已经在素材箱里了");
      return false;
    }

    await refreshProject();
    useAppStore
      .getState()
      .pushNotice("info", `已导入 ${added.length} 项素材，拖到时间线上轨`);
    return true;
  } catch (err) {
    reportFailure(err, "导入素材失败");
    return false;
  }
}

/** 链接组 id：同一段视频的画面与声音共用（达芬奇式默认粘起来） */
function newCompoundId(): Id {
  return `compound-${Date.now().toString(36)}-${Math.round(Math.random() * 1e6).toString(36)}`;
}

/**
 * 把一个素材接到指定类型轨道的末尾。录音面板复用：
 * 录完的音频直接接到音频轨末尾（录音场景里用户预期落轨，与普通导入不同）。
 */
export async function appendAssetToTrackEnd(asset: Asset): Promise<boolean> {
  const snapshot = await projectApi.getProject();
  const sequence = snapshot.sequences[0];
  if (!sequence) return false;
  const wanted: Track["kind"] = asset.kind === "audio" ? "audio" : "video";
  const track = sequence.tracks.find((t) => t.kind === wanted);
  if (!track) return false;
  const end = track.clips.reduce(
    (max, clip) => Math.max(max, clip.startMs + clip.durationMs),
    0
  );
  const durationMs = asset.durationMs > 0 ? asset.durationMs : FALLBACK_CLIP_MS;
  try {
    await timeline.addClip(track.id, asset.id, end, durationMs);
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "放置素材失败");
    return false;
  }
}

/**
 * 把一个素材放到时间线的指定起点（拖拽落点用）。
 *
 * 视频素材带音轨时照达芬奇的规矩拆两段：画面进落点所在的视频轨、
 * 声音进最靠近落点轨道下方的音频轨，两段同起点同长、共用一个
 * compound_id——默认粘起来，选中与移动都联动。
 */
export async function placeAssetAt(
  assetId: Id,
  trackId: Id,
  startMs: number
): Promise<boolean> {
  const snapshot = await projectApi.getProject();
  const sequence = snapshot.sequences[0];
  if (!sequence) return false;
  const asset = snapshot.assets.find((a) => a.id === assetId);
  if (!asset) return false;
  const durationMs = asset.durationMs > 0 ? asset.durationMs : FALLBACK_CLIP_MS;

  try {
    const compound = asset.kind === "video" && asset.hasAudio ? newCompoundId() : undefined;
    await timeline.addClip(trackId, asset.id, startMs, durationMs, compound);

    // 带音轨的视频：声音另落到音频轨（优先落点轨道下方的第一条，找不到就用最后一条音频轨）
    if (compound) {
      const droppedIndex = sequence.tracks.findIndex((t) => t.id === trackId);
      const audioTrack =
        sequence.tracks
          .map((t, i) => ({ t, i }))
          .filter(({ t }) => t.kind === "audio")
          .filter(({ i }) => i > droppedIndex)
          .map(({ t }) => t)
          .sort((a, b) => a.index - b.index)[0] ??
        sequence.tracks.find((t) => t.kind === "audio");
      if (audioTrack) {
        await timeline.addClip(audioTrack.id, asset.id, startMs, durationMs, compound);
      }
    }

    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "放置素材失败");
    return false;
  }
}

/** 撤销上一步，撤销后把权威快照回填。 */
export async function undo(): Promise<void> {
  if (!useAppStore.getState().project) return;
  try {
    const result = await history.undo();
    if (!result.ok) {
      useAppStore.getState().pushNotice("info", "没有可撤销的操作");
      return;
    }
    await refreshProject();
    useAppStore.getState().pushNotice("info", `已撤销：${result.description}`);
  } catch (err) {
    reportFailure(err, "撤销失败");
  }
}

/** 重做下一步，重做后把权威快照回填。 */
export async function redo(): Promise<void> {
  if (!useAppStore.getState().project) return;
  try {
    const result = await history.redo();
    if (!result.ok) {
      useAppStore.getState().pushNotice("info", "没有可重做的操作");
      return;
    }
    await refreshProject();
    useAppStore.getState().pushNotice("info", `已重做：${result.description}`);
  } catch (err) {
    reportFailure(err, "重做失败");
  }
}

/** 在权威快照里同时拿到片段与它所在轨道的类型。 */
function locateClip(project: Project, clipId: Id): { clip: Clip; kind: Track["kind"] } | null {
  for (const seq of project.sequences) {
    for (const track of seq.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return { clip, kind: track.kind };
    }
  }
  return null;
}

/** 时间线当前选中的片段集合：多选优先，退回单选。 */
function selectedClipIds(): Id[] {
  const state = useAppStore.getState();
  if (state.selectedClipIds.length > 0) return state.selectedClipIds;
  return state.selectedClipId ? [state.selectedClipId] : [];
}

/** 删除选中的片段（Delete / Backspace）。 */
export async function deleteSelectedClips(): Promise<boolean> {
  const ids = selectedClipIds();
  if (ids.length === 0) return false;
  try {
    await timeline.deleteClips(ids);
    await refreshProject();
    useAppStore
      .getState()
      .pushNotice("info", ids.length > 1 ? `已删除 ${ids.length} 个片段` : "已删除片段");
    return true;
  } catch (err) {
    reportFailure(err, "删除片段失败");
    return false;
  }
}

/**
 * 在播放头处切割当前选中的片段（Ctrl+K）。
 * 切割点必须落在片段内部，否则后端会拒绝——这里先拦一道，给中文提示。
 */
export async function splitAtPlayhead(): Promise<boolean> {
  const state = useAppStore.getState();
  const project = state.project;
  const clipId = state.selectedClipId;
  if (!project || !clipId) {
    state.pushNotice("info", "先在时间线上选中一个片段");
    return false;
  }

  const found = locateClip(project, clipId);
  if (!found) {
    state.pushNotice("info", "先在时间线上选中一个片段");
    return false;
  }
  if (found.kind === "camera") {
    state.pushNotice("info", "摄像机轨道的片段不能切割");
    return false;
  }

  const atMs = state.playheadMs;
  const { startMs, durationMs } = found.clip;
  if (atMs <= startMs + 1 || atMs >= startMs + durationMs - 1) {
    state.pushNotice("info", "把播放头移到片段中间再切割");
    return false;
  }

  try {
    await timeline.splitClip(clipId, atMs);
    await refreshProject();
    useAppStore.getState().pushNotice("info", "已切割片段");
    return true;
  } catch (err) {
    reportFailure(err, "切割片段失败");
    return false;
  }
}

/** 给选中的片段统一改速度（右键菜单里的 0.5× / 1× / 2×）。 */
export async function applyClipSpeed(speed: number): Promise<boolean> {
  const ids = selectedClipIds();
  if (ids.length === 0) return false;
  try {
    for (const id of ids) await timeline.setClipSpeed(id, speed);
    await refreshProject();
    useAppStore.getState().pushNotice("info", `已把速度改为 ${speed}×`);
    return true;
  } catch (err) {
    reportFailure(err, "修改片段速度失败");
    return false;
  }
}

/**
 * 拖动一组片段到新的起点。多选时整组一起走，落点由界面算好（含吸附），
 * 这里只负责逐个落库、最后回填一次权威快照。
 * `trackId` 只在单片段跨轨拖动时传，多选整组不换轨。
 */
export async function moveClipsTo(
  targets: { id: Id; startMs: number; trackId?: Id }[]
): Promise<boolean> {
  if (targets.length === 0) return false;
  try {
    for (const target of targets) {
      await timeline.moveClip(target.id, Math.max(0, target.startMs), target.trackId);
    }
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "移动片段失败");
    return false;
  }
}

/**
 * 修剪片段的入出点（素材内毫秒）。左端修剪会同时挪时间线起点——
 * 后端的裁剪只改入出点与时长、不动起点，所以这里补一次移动。
 */
export async function trimClipTo(
  clipId: Id,
  next: { startMs: number; inMs: number; outMs: number }
): Promise<boolean> {
  const project = useAppStore.getState().project;
  if (!project) return false;
  const found = locateClip(project, clipId);
  if (!found) return false;
  try {
    await timeline.trimClip(clipId, next.inMs, next.outMs);
    if (Math.abs(found.clip.startMs - next.startMs) > 0.001) {
      await timeline.moveClip(clipId, Math.max(0, next.startMs));
    }
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "裁剪片段失败");
    return false;
  }
}

/**
 * 轨道开关（静音 / 隐藏 / 锁定 / 独奏）。改完回填权威快照，
 * 时间线 gutter 与渲染都读后端这一份状态。
 */
export async function updateTrackFlags(
  trackId: Id,
  flags: { muted?: boolean; hidden?: boolean; locked?: boolean; solo?: boolean }
): Promise<boolean> {
  try {
    await timeline.setTrackFlags(trackId, flags);
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "修改轨道状态失败");
    return false;
  }
}

/**
 * 对指定视频片段跑本地语音识别，并把结果写成字幕轨片段。
 *
 * 识别完全在本机进行（sherpa-onnx + SenseVoice），不联网也不上传素材。
 * 音频抽取、切句、映射时间线都在 Rust 侧完成，这里只管编排与提示。
 */
export async function generateSubtitlesForClip(clipId: Id): Promise<boolean> {
  const state = useAppStore.getState();
  const project = state.project;
  if (!project) return false;
  const found = locateClip(project, clipId);
  if (!found) return false;
  if (found.kind !== "video") {
    state.pushNotice("info", "只能对视频片段识别语音");
    return false;
  }
  const sequence = project.sequences.find((s) =>
    s.tracks.some((t) => t.id === found.clip.trackId)
  );
  if (!sequence) return false;

  const status = await subtitle.asrStatus().catch(() => null);
  if (status && !status.available) {
    state.pushNotice("error", status.detail || "本地语音识别组件未安装");
    return false;
  }

  try {
    state.pushNotice("info", "正在本机识别语音，片段越长耗时越久…");
    const segments = await subtitle.generateSubtitles(clipId);
    const count = await subtitle.applySubtitles(sequence.id, segments);
    await refreshProject();
    useAppStore.getState().pushNotice("info", `已生成 ${count} 条字幕`);
    return true;
  } catch (err) {
    reportFailure(err, "生成字幕失败");
    return false;
  }
}

/** 在播放头处手写一条 2 秒字幕；没有字幕轨就建一条。 */
export async function addSubtitleAtPlayhead(): Promise<boolean> {
  const state = useAppStore.getState();
  const project = state.project;
  const sequence = project?.sequences[0];
  if (!project || !sequence) return false;
  try {
    const clip = await subtitle.addSubtitleClip(
      sequence.id,
      Math.max(0, state.playheadMs),
      2000,
      "新字幕"
    );
    await refreshProject();
    useAppStore.getState().selectClip(clip.id);
    useAppStore.getState().pushNotice("info", "已加一条字幕，在右侧属性里改文字");
    return true;
  } catch (err) {
    reportFailure(err, "添加字幕失败");
    return false;
  }
}

/** 改字幕片段的文字。 */
export async function updateClipText(clipId: Id, text: string): Promise<boolean> {
  try {
    await subtitle.setClipText(clipId, text);
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "修改字幕文字失败");
    return false;
  }
}

/**
 * 向 Rust 侧要一帧监视器画面。后端按序列、播放时刻与画幅上限渲染出 PNG，
 * 直接把字节回给调用方；怎么显示（Blob / objectURL）是视图的事。
 *
 * 这里只做转发，不落持久状态——监视器每次拖播放头都会要一帧，
 * 写进 store 会让整个界面跟着重渲染，得不偿失。
 */
export async function requestMonitorFrame(
  sequenceId: Id,
  timeMs: number,
  maxWidth?: number,
  maxHeight?: number
): Promise<ArrayBuffer> {
  return renderApi.requestFrame(sequenceId, timeMs, maxWidth, maxHeight);
}

/** 切换预览质量（0.25 ~ 1.0）。下一次请求帧就会用新画幅。 */
export async function setPreviewQuality(scale: number): Promise<boolean> {
  try {
    return await renderApi.setPreviewQuality(scale);
  } catch (err) {
    reportFailure(err, "设置预览质量失败");
    return false;
  }
}
