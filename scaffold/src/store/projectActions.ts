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
import { audio, dialog, exportApi, generators, graph, history, media, project as projectApi, render as renderApi, subtitle, timeline } from "../services";
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

    // 自动适配（剪映习惯）：序列还没上过任何片段、且导入的是视频/图片时，
    // 把序列画幅与帧率改成这个素材的规格。
    const seq = store.project?.sequences[0];
    const seqEmpty = (seq?.tracks ?? []).every((t) => t.clips.length === 0);
    const firstVisual = added.find((a) => a.kind === "video" || a.kind === "image");
    if (seq && seqEmpty && firstVisual && (firstVisual.width ?? 0) > 0) {
      try {
        const { project } = await import("../services");
        const adapted = await project.adaptSequenceToAsset(seq.id, firstVisual.id);
        useAppStore.getState().syncProject(adapted);
        useAppStore
          .getState()
          .pushNotice("info", `已按素材适配画幅：${adapted.sequences[0].width}×${adapted.sequences[0].height}`);
      } catch {
        /* 适配失败不阻塞导入 */
      }
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

/** 给选中的片段加一个文字效果（图形与字幕 ▸ 新建图层 ▸ 文字）。真挂效果，不是摆设。 */
export async function addTextToSelectedClip(): Promise<boolean> {
  const ids = selectedClipIds();
  if (ids.length === 0) {
    useAppStore.getState().pushNotice("info", "先在时间线上选中一个片段");
    return false;
  }
  useAppStore.getState().addEffect(ids[0], "text");
  return true;
}

/**
 * 新建生成器素材（白底 / 黑场 / 彩条 / 颜色遮罩）并落到第一条视频轨末尾。
 * 后端 new_generator 用 ffmpeg lavfi 真生成 PNG，再按路径走 import_media 进工程——
 * 预览 / 合成 / 导出天然支持，不是摆设。
 */
export async function createGeneratorAsset(kind: string, seconds: number): Promise<boolean> {
  if (!useAppStore.getState().project) {
    useAppStore.getState().pushNotice("info", "先新建或打开一个工程");
    return false;
  }
  try {
    const gen = await generators.newGenerator(kind, seconds);
    await media.importMedia([gen.path]);
    await refreshProject();
    const snapshot = await projectApi.getProject();
    const asset = snapshot?.assets.find((a) => a.path === gen.path);
    const videoTrack = snapshot?.sequences[0]?.tracks
      .filter((t) => t.kind === "video")
      .sort((a, b) => a.index - b.index)[0];
    if (!asset || !videoTrack) {
      useAppStore.getState().pushNotice("error", "生成素材失败：工程里没有视频轨");
      return false;
    }
    // 落点 = 该视频轨上最后一个片段的末尾（没有片段就 0）
    let endMs = 0;
    for (const clip of videoTrack.clips) {
      endMs = Math.max(endMs, clip.startMs + clip.durationMs);
    }
    await placeAssetAt(asset.id, videoTrack.id, endMs);
    useAppStore.getState().pushNotice("info", `已添加「${gen.name}」并放到视频轨末尾`);
    return true;
  } catch (err) {
    reportFailure(err, "新建生成器素材失败");
    return false;
  }
}

/** 重新链接离线素材：改后端工程数据后拉快照（素材箱 404 页与「连接媒体」共用）。 */
export async function relinkAsset(assetId: Id, newPath: string): Promise<boolean> {
  try {
    await media.relinkMedia(assetId, newPath);
    await refreshProject();
    useAppStore.getState().pushNotice("info", "已重新链接素材");
    return true;
  } catch (err) {
    reportFailure(err, "重新链接失败");
    return false;
  }
}

/** 波纹删除：删掉选中片段，同轨后续片段整体前移，不留空（PR 的 Ripple Delete）。 */
export async function rippleDeleteSelected(): Promise<boolean> {
  const ids = selectedClipIds();
  if (ids.length === 0) return false;
  try {
    const snapshot = await projectApi.getProject();
    // 收集被删片段（轨道 + 起点 + 时长），按起点从晚到早逐个处理，避免连锁偏移
    const targets: Array<{ id: Id; trackId: Id; endMs: number; durationMs: number }> = [];
    for (const seq of snapshot?.sequences ?? []) {
      for (const track of seq.tracks) {
        for (const clip of track.clips) {
          if (ids.includes(clip.id)) {
            targets.push({
              id: clip.id,
              trackId: track.id,
              endMs: clip.startMs + clip.durationMs,
              durationMs: clip.durationMs,
            });
          }
        }
      }
    }
    targets.sort((a, b) => b.endMs - a.endMs);
    for (const t of targets) {
      await timeline.deleteClips([t.id]);
      // 删完后拉最新快照，把同轨上排在它后面的片段前移一个身位
      const after = await projectApi.getProject();
      for (const seq of after?.sequences ?? []) {
        for (const track of seq.tracks) {
          if (track.id !== t.trackId) continue;
          for (const clip of track.clips) {
            if (clip.startMs >= t.endMs) {
              await timeline.moveClip(clip.id, Math.max(0, clip.startMs - t.durationMs), track.id);
            }
          }
        }
      }
    }
    await refreshProject();
    useAppStore.getState().pushNotice("info", "已波纹删除");
    return true;
  } catch (err) {
    reportFailure(err, "波纹删除失败");
    return false;
  }
}

/** 切片段启用/禁用（右键「启用」）。禁用的片段预览与导出都跳过。 */
export async function setClipEnabled(clipId: Id, enabled: boolean): Promise<boolean> {
  try {
    await timeline.setClipFlags(clipId, { enabled });
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "切换片段启用失败");
    return false;
  }
}

/** 给选中片段打标签（右键「标签 ▸ 颜色」，高饱和标签色）。 */
export async function setClipLabel(label: string): Promise<boolean> {
  const ids = selectedClipIds();
  if (ids.length === 0) return false;
  try {
    for (const id of ids) {
      await timeline.setClipFlags(id, { label: label || "" });
    }
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "设置标签失败");
    return false;
  }
}

/**
 * 取消视音频链接（右键「取消链接」）：
 * 选中片段所在链接组（compound_id）整体解除，画面与声音从此各自独立。
 * PR 语义：点组内任意一段的「取消链接」，整组分开。
 */
export async function unlinkCompound(clipId: Id): Promise<boolean> {
  try {
    await timeline.unlinkCompound(clipId);
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "取消链接失败");
    return false;
  }
}

/** 在资源管理器里打开素材所在目录（右键「编辑原始素材」）。 */
export async function revealAsset(assetId: Id): Promise<boolean> {
  const snapshot = await projectApi.getProject();
  const asset = snapshot?.assets.find((a) => a.id === assetId);
  if (!asset || !asset.path) {
    useAppStore.getState().pushNotice("info", "这个素材没有磁盘文件（生成器素材）");
    return false;
  }
  try {
    await audio.revealPath(asset.path);
    return true;
  } catch (err) {
    reportFailure(err, "打开素材目录失败");
    return false;
  }
}

/**
 * 嵌套（Pre-compose / Nest）：把选中片段的效果图节点折叠成一个复合节点。
 * 后端 `collapse_compound` 已有实现，这里只是把片段 → 节点的对应关系接上。
 */
export async function nestSelectedClips(): Promise<boolean> {
  const ids = selectedClipIds();
  if (ids.length === 0) {
    useAppStore.getState().pushNotice("info", "先选中要嵌套的片段");
    return false;
  }
  try {
    const snapshot = await projectApi.getProject();
    const nodeIds: string[] = [];
    for (const seq of snapshot?.sequences ?? []) {
      for (const track of seq.tracks) {
        for (const clip of track.clips) {
          if (ids.includes(clip.id) && clip.nodeId) nodeIds.push(clip.nodeId);
        }
      }
    }
    if (nodeIds.length === 0) return false;
    await graph.collapseCompound(nodeIds);
    await refreshProject();
    useAppStore.getState().pushNotice("info", `已把 ${nodeIds.length} 个片段嵌套成复合节点`);
    return true;
  } catch (err) {
    reportFailure(err, "嵌套失败");
    return false;
  }
}

/** 移除没被任何片段引用的素材（编辑 ▸ 移除未使用项）。 */
export async function removeUnusedAssets(): Promise<boolean> {
  const snapshot = await projectApi.getProject();
  if (!snapshot) return false;
  const used = new Set<Id>();
  for (const seq of snapshot.sequences) {
    for (const track of seq.tracks) {
      for (const clip of track.clips) used.add(clip.assetId);
    }
  }
  const unused = snapshot.assets.filter((a) => !used.has(a.id));
  if (unused.length === 0) {
    useAppStore.getState().pushNotice("info", "没有未使用的素材");
    return true;
  }
  try {
    for (const asset of unused) {
      await media.removeMedia(asset.id);
    }
    await refreshProject();
    useAppStore.getState().pushNotice("info", `已移除 ${unused.length} 个未使用素材`);
    return true;
  } catch (err) {
    reportFailure(err, "移除未使用素材失败");
    return false;
  }
}

/** 加一条轨道并拉快照（序列 ▸ 添加视频轨 / 音频轨）。 */
export async function addTrackOfKind(kind: Track["kind"]): Promise<boolean> {
  try {
    await timeline.addTrack(kind);
    await refreshProject();
    useAppStore.getState().pushNotice("info", kind === "video" ? "已添加视频轨" : "已添加音频轨");
    return true;
  } catch (err) {
    reportFailure(err, "添加轨道失败");
    return false;
  }
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
 * 按文字预设真加一条字幕片段（文本库双击 / 回车用）。
 * 不需要先选中任何片段：直接落在字幕轨的播放头处，3 秒起步。
 */
export async function addTextAtPlayhead(preset: { text: string }): Promise<boolean> {
  const state = useAppStore.getState();
  const sequence = state.project?.sequences[0];
  if (!state.project || !sequence) {
    state.pushNotice("info", "先新建或打开一个工程");
    return false;
  }
  try {
    const clip = await subtitle.addSubtitleClip(
      sequence.id,
      Math.max(0, state.playheadMs),
      3000,
      preset.text
    );
    await refreshProject();
    useAppStore.getState().selectClip(clip.id);
    useAppStore.getState().pushNotice("info", "已添加文字片段，右侧属性里可继续改样式");
    return true;
  } catch (err) {
    reportFailure(err, "添加文字失败");
    return false;
  }
}

/** 把素材归入文件夹；binId 传 null 表示移出到「全部」。 */
export async function setAssetBinAction(assetId: Id, binId: Id | null): Promise<boolean> {
  try {
    await timeline.setAssetBin(assetId, binId);
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "素材归类失败");
    return false;
  }
}

/** 新建素材箱文件夹，返回新文件夹 id（失败返回 null）。 */
export async function createBinAction(name: string): Promise<Id | null> {
  try {
    const bin = await timeline.createBin(name);
    await refreshProject();
    return bin.id;
  } catch (err) {
    reportFailure(err, "新建文件夹失败");
    return null;
  }
}

/** 删除素材箱文件夹：文件夹没了，里面的素材回到「全部」。 */
export async function removeBinAction(binId: Id): Promise<boolean> {
  try {
    await timeline.removeBin(binId);
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "删除文件夹失败");
    return false;
  }
}

/** 重命名素材箱文件夹。 */
export async function renameBinAction(binId: Id, name: string): Promise<boolean> {
  try {
    await timeline.renameBin(binId, name);
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "重命名文件夹失败");
    return false;
  }
}

/** 在播放头处加一个时间线标记（M 键 / 标记面板 / 时间轴右键共用）。 */
export async function addMarkerAtPlayhead(name?: string | null): Promise<boolean> {
  const state = useAppStore.getState();
  const sequence = state.project?.sequences[0];
  if (!sequence) return false;
  try {
    await timeline.addMarker(sequence.id, Math.max(0, state.playheadMs), name ?? null);
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "添加标记失败");
    return false;
  }
}

/** 删除一个时间线标记（标记页签行尾 × 用）。 */
export async function removeMarkerAction(markerId: Id): Promise<boolean> {
  const sequence = useAppStore.getState().project?.sequences[0];
  if (!sequence) return false;
  try {
    await timeline.removeMarker(sequence.id, markerId);
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "删除标记失败");
    return false;
  }
}

/**
 * 跳到某个历史点（Rust 侧 jump_history：游标移到该步，
 * 工程与关键帧快照一起回放——即这一步操作完成后的状态）。
 */
export async function jumpHistoryTo(index: number): Promise<boolean> {
  if (!useAppStore.getState().project) return false;
  try {
    const ok = await history.jumpHistory(index);
    if (!ok) {
      useAppStore.getState().pushNotice("info", "这个历史点已经不在栈里了");
      return false;
    }
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "跳转历史失败");
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

/** 设置片段入场转场（叠化 / 黑场 / 白场）；kind 传 null 清除。 */
export async function setClipTransition(
  clipId: Id,
  kind: "crossDissolve" | "dipToBlack" | "dipToWhite" | null,
  durationMs = 500
): Promise<boolean> {
  try {
    await timeline.setTransition(clipId, kind, durationMs);
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "设置转场失败");
    return false;
  }
}

/** 设置音频片段淡入淡出（毫秒，0 表示取消）。 */
export async function setClipAudioFade(
  clipId: Id,
  fadeInMs: number,
  fadeOutMs: number
): Promise<boolean> {
  try {
    await timeline.setAudioFade(clipId, Math.max(0, fadeInMs), Math.max(0, fadeOutMs));
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "设置音频淡变失败");
    return false;
  }
}

/** 在播放头处加一个时间线标记（右键「添加标记」）。 */
export async function addTimelineMarker(sequenceId: Id, atMs: number): Promise<boolean> {
  try {
    await timeline.addMarker(sequenceId, Math.max(0, atMs), null);
    await refreshProject();
    useAppStore.getState().pushNotice("info", "已添加标记");
    return true;
  } catch (err) {
    reportFailure(err, "添加标记失败");
    return false;
  }
}

/** 删除时间线标记。 */
export async function removeTimelineMarker(sequenceId: Id, markerId: Id): Promise<boolean> {
  try {
    await timeline.removeMarker(sequenceId, markerId);
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "删除标记失败");
    return false;
  }
}

/** 拖动时间线标记到新时刻。 */
export async function moveTimelineMarker(
  sequenceId: Id,
  markerId: Id,
  atMs: number
): Promise<boolean> {
  try {
    await timeline.moveMarker(sequenceId, markerId, Math.max(0, atMs));
    await refreshProject();
    return true;
  } catch (err) {
    reportFailure(err, "移动标记失败");
    return false;
  }
}

/**
 * 裁剪到播放头：left = 删掉播放头左边的部分（trim-in），
 * right = 删掉播放头右边的部分（trim-out）。对选中片段有效（含摄像机/音频）。
 */
export async function trimSelectedToPlayhead(side: "left" | "right"): Promise<boolean> {
  const st = useAppStore.getState();
  const project = st.project;
  const ids = st.selectedClipIds;
  if (!project || ids.length === 0) return false;
  const playhead = st.playheadMs;
  let ok = false;
  for (const id of ids) {
    const found = locateClip(project, id);
    if (!found) continue;
    const c = found.clip;
    const local = playhead - c.startMs; // 播放头落在片段内的相对毫秒
    if (local <= 0 || local >= c.durationMs) continue; // 播放头不在片段内：跳过
    if (side === "left") {
      await trimClipTo(id, {
        startMs: playhead,
        inMs: c.inMs + local,
        outMs: c.outMs,
      });
    } else {
      await trimClipTo(id, {
        startMs: c.startMs,
        inMs: c.inMs,
        outMs: c.inMs + local,
      });
    }
    ok = true;
  }
  if (ok) st.pushNotice("info", side === "left" ? "已裁剪掉播放头左边的部分" : "已裁剪掉播放头右边的部分");
  return ok;
}

/**
 * 把选中片段移到播放头：片段在播放头左边的移到右侧贴合，右边的移到左侧贴合。
 */
export async function moveSelectedToPlayhead(): Promise<boolean> {
  const st = useAppStore.getState();
  const project = st.project;
  const ids = st.selectedClipIds;
  if (!project || ids.length === 0) return false;
  const playhead = st.playheadMs;
  let moved = 0;
  for (const id of ids) {
    const found = locateClip(project, id);
    if (!found) continue;
    const c = found.clip;
    const target = c.startMs + c.durationMs <= playhead
      ? playhead                                   // 片段整体在播放头左侧：起点贴到播放头
      : playhead - c.durationMs;                   // 在右侧：终点贴到播放头
    if (Math.abs(target - c.startMs) < 0.5) continue;
    await moveClipsTo([{ id, startMs: Math.max(0, target) }]);
    moved += 1;
  }
  if (moved > 0) {
    useAppStore.getState().pushNotice("info", `已把 ${moved} 个片段移到播放头`);
    return true;
  }
  return false;
}
