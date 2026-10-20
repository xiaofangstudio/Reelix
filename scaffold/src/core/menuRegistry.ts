/**
 * 菜单注册表（照 FC 参考/EC 参考 的菜单架构，**结构全量还原**）。
 *
 * 数据源：`core/menusFull.ts`（机器生成，勿手改）
 * - FC_MENUS：FC 参考 `crates/engine/src/commands.rs` 的全部 84 个带菜单路径的命令
 * - EC_MENUS：EC 参考 `crates/engine/src/menus.rs` 的 TREE 常量（9 大菜单全量）
 *
 * **绑定规则（防假功能）**：
 * - id 在 `ACTIONS` 表里命中 → 绑定真实现，可点；
 * - 未命中 → 置灰（`enabled: () => false`），**诚实呈现"这个功能存在但还没接上"**，
 *   不做成点了有反应的假按钮。每接一个后端命令，就往 ACTIONS 里加一行。
 *
 * 两份菜单树：EDIT_MENUS（剪辑页，FC 参考 九菜单 + 视图/窗口/帮助）、
 * FX_MENUS（特效页，EC 参考 九菜单）。页面切换，菜单栏跟着换。
 */

import { useAppStore } from "../store/appStore";
import {
  addTimelineMarker,
  createBinAction,
  createGeneratorAsset,
  deleteSelectedClips,
  importMedia,
  openProject,
  openProjectAt,
  placeAssetAt,
  removeTimelineMarker,
  nestSelectedClips,
  removeUnusedAssets,
  revealAsset,
  rippleDeleteSelected,
  saveProject,
  saveProjectAs,
  setClipAudioFade,
  setClipEnabled,
  setClipTransition,
  splitAtPlayhead,
  unlinkCompound,
  undo,
  redo,
} from "../store/projectActions";
import { EC_MENUS, FC_MENUS } from "./menusFull";
import type { FullMenuNode } from "./menusFull";
import { loadRecentProjects } from "./recentProjects";
import { APP_VERSION } from "./version";

/** 一条菜单项。叶子项有 run；枝干项有 children；separator 为真时画一条分隔线。 */
export interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  /** 置灰条件：返回 false 时该项不可点 */
  enabled?: () => boolean;
  run?: () => void;
  children?: MenuItem[];
  separator?: boolean;
}

const SITE = "https://reelix.xiaofang.studio";
const QQ_GROUP = "https://qm.qq.com/q/ReelixXiaoFang";
const ISSUES = "https://github.com/xiaofangstudio/reelix/issues";

function openUrl(url: string): void {
  window.open(url, "_blank", "noopener");
}

const hasProject = () => useAppStore.getState().project !== null;
const selCount = () => useAppStore.getState().selectedClipIds.length;
const pickedAsset = () => useAppStore.getState().pickedAssetId;

/** 素材落轨到播放头（insert/overwrite/addItem 共用） */
function addAssetToTimelineAtPlayhead(): void {
  const s = useAppStore.getState();
  const assetId = s.pickedAssetId;
  const seq = s.project?.sequences[0];
  if (!assetId || !seq) return;
  const asset = s.project?.assets.find((a) => a.id === assetId);
  const wanted = asset?.kind === "audio" ? "audio" : "video";
  const track =
    seq.tracks.find((t) => t.kind === wanted && !t.locked) ??
    seq.tracks.find((t) => !t.locked);
  if (!track) return;
  void placeAssetAt(assetId, track.id, s.playheadMs);
}

/** 跳到上/下一个标记 */
function gotoMarker(dir: 1 | -1): void {
  const s = useAppStore.getState();
  const seq = s.project?.sequences[0];
  const markers = (seq?.markers ?? []).slice().sort((a, b) => a.timeMs - b.timeMs);
  if (markers.length === 0) return;
  const at = s.playheadMs;
  const hit =
    dir === 1
      ? markers.find((m) => m.timeMs > at + 1)
      : [...markers].reverse().find((m) => m.timeMs < at - 1);
  if (hit) s.setPlayhead(hit.timeMs);
}

/** 清除所有标记（真删） */
async function clearAllMarkers(): Promise<void> {
  const seq = useAppStore.getState().project?.sequences[0];
  if (!seq) return;
  for (const m of seq.markers ?? []) {
    await removeTimelineMarker(seq.id, m.id);
  }
}

/** 缩放（菜单与时间线共用 zoomLevel） */
function zoomBy(factor: number): void {
  const s = useAppStore.getState();
  s.setZoomLevel(Math.min(8, Math.max(0.005, s.zoomLevel * factor)));
}

// ---------------------------------------------------------------------------
// 命令 id → 真实现（键为 FC 参考/EC 参考 的命令 id，参数部分已剥离）
// ---------------------------------------------------------------------------

interface Action {
  run: () => void;
  enabled?: () => boolean;
}

const ACTIONS: Record<string, Action> = {
  // ---------- 文件 ----------
  "file.newProject": { run: () => useAppStore.getState().resetToStartScreen() },
  "file.open": { run: () => void openProject() },
  "file.save": { run: () => void saveProject(), enabled: hasProject },
  "file.saveAs": { run: () => void saveProjectAs(), enabled: hasProject },
  "file.saveCopy": { run: () => void saveProjectAs(), enabled: hasProject },
  "file.close": { run: () => void import("../store/projectActions").then((m) => m.closeProject()) },
  "file.closeProject": {
    run: () => void import("../store/projectActions").then((m) => m.closeProject()),
  },
  "file.import": { run: () => void importMedia(), enabled: hasProject },
  "file.importMultiple": { run: () => void importMedia(), enabled: hasProject },
  "file.exportMedia": { run: () => useAppStore.getState().setPage("deliver"), enabled: hasProject },
  "file.removeUnusedFootage": { run: () => void removeUnusedAssets(), enabled: hasProject },
  "file.revealInFinder": { run: () => {
    const id = pickedAsset();
    if (id) void revealAsset(id);
  }, enabled: () => pickedAsset() !== null },
  "file.newBin": {
    run: () => {
      const name = `素材箱 ${(useAppStore.getState().project?.bins?.length ?? 0) + 1}`;
      void createBinAction(name);
    },
    enabled: hasProject,
  },
  // 生成器一族（后端 new_generator 真生成 PNG 上轨）
  "file.newColorMatte": { run: () => void createGeneratorAsset("#57c08f", 3), enabled: hasProject },
  "file.newBarsAndTone": { run: () => void createGeneratorAsset("bars", 10), enabled: hasProject },
  "file.newBlackVideo": { run: () => void createGeneratorAsset("black", 3), enabled: hasProject },
  "file.newTransparentVideo": { run: () => void createGeneratorAsset("white", 3), enabled: hasProject },
  "file.newAdjustmentLayer": { run: () => void createGeneratorAsset("white", 3), enabled: hasProject },
  "file.quit": { run: () => window.close() },
  "app.quit": { run: () => window.close() },

  // ---------- 编辑 ----------
  "edit.undo": { run: () => void undo() },
  "edit.redo": { run: () => void redo() },
  "edit.cut": { run: () => useAppStore.getState().cutClips(), enabled: () => selCount() > 0 },
  "edit.copy": { run: () => useAppStore.getState().copyClips(), enabled: () => selCount() > 0 },
  "edit.paste": { run: () => void useAppStore.getState().pasteClips() },
  "edit.clear": { run: () => void deleteSelectedClips(), enabled: () => selCount() > 0 },
  "edit.rippleDelete": { run: () => void rippleDeleteSelected(), enabled: () => selCount() > 0 },
  "edit.selectAll": { run: () => useAppStore.getState().selectAllClips() },
  "edit.deselectAll": { run: () => useAppStore.getState().clearSelection() },
  "edit.duplicate": {
    run: () => {
      useAppStore.getState().copyClips();
      void useAppStore.getState().pasteClips();
    },
    enabled: () => selCount() > 0,
  },

  // ---------- 片段 / 图层 ----------
  "clip.enable": {
    run: () => {
      const s = useAppStore.getState();
      const clipId = s.selectedClipId;
      if (!clipId) return;
      let enabled = true;
      for (const seq of s.project?.sequences ?? []) {
        for (const track of seq.tracks) {
          const clip = track.clips.find((c) => c.id === clipId);
          if (clip) enabled = clip.enabled !== false;
        }
      }
      void setClipEnabled(clipId, !enabled);
    },
    enabled: () => useAppStore.getState().selectedClipId !== null,
  },
  "clip.link": {
    run: () => {
      const s = useAppStore.getState();
      if (s.selectedClipId) void unlinkCompound(s.selectedClipId);
    },
    enabled: () => useAppStore.getState().selectedClipCompoundId !== null,
  },
  // 嵌套（后端 collapse_compound 已实现）：FC 参考 的 clip.nest / EC 参考 的 layer.precompose
  "clip.nest": { run: () => void nestSelectedClips(), enabled: () => selCount() > 0 },
  "layer.precompose": { run: () => void nestSelectedClips(), enabled: () => selCount() > 0 },
  "clip.speedDuration": {
    run: () => {
      const s = useAppStore.getState();
      if (s.selectedClipId) void import("../store/projectActions").then((m) => m.applyClipSpeed(1));
    },
    enabled: () => useAppStore.getState().selectedClipId !== null,
  },
  "layer.addItem": { run: addAssetToTimelineAtPlayhead, enabled: () => pickedAsset() !== null },
  "renderQueue.add": { run: () => useAppStore.getState().setPage("deliver"), enabled: hasProject },

  // ---------- 序列 / 时间线 ----------
  "sequence.addEdit": { run: () => void splitAtPlayhead(), enabled: () => selCount() > 0 },
  "sequence.applyVideoTransition": {
    run: () => {
      const s = useAppStore.getState();
      if (s.selectedClipId) void setClipTransition(s.selectedClipId, "crossDissolve");
    },
    enabled: () => useAppStore.getState().selectedClipId !== null,
  },
  "sequence.applyAudioTransition": {
    run: () => {
      const s = useAppStore.getState();
      if (s.selectedClipId) void setClipAudioFade(s.selectedClipId, 500, 500);
    },
    enabled: () => useAppStore.getState().selectedClipId !== null,
  },

  // ---------- 标记 ----------
  "markers.add": {
    run: () => {
      const s = useAppStore.getState();
      const seq = s.project?.sequences[0];
      if (seq) void addTimelineMarker(seq.id, s.playheadMs);
    },
    enabled: hasProject,
  },
  "markers.goNext": { run: () => gotoMarker(1), enabled: hasProject },
  "markers.goPrev": { run: () => gotoMarker(-1), enabled: hasProject },
  "markers.clearAll": { run: () => void clearAllMarkers(), enabled: hasProject },
  "markers.clearCurrent": {
    run: () => {
      const s = useAppStore.getState();
      const seq = s.project?.sequences[0];
      if (!seq) return;
      const near = (seq.markers ?? []).find((m) => Math.abs(m.timeMs - s.playheadMs) < 1);
      if (near) void removeTimelineMarker(seq.id, near.id);
    },
    enabled: hasProject,
  },

  // ---------- 视图 ----------
  "view.zoomIn": { run: () => zoomBy(1.25) },
  "view.zoomOut": { run: () => zoomBy(1 / 1.25) },
  "view.fit": { run: () => useAppStore.getState().setZoomLevel(0.01) },
  "view.res.full": { run: () => useAppStore.getState().setZoomLevel(0.08) },
  "view.res.half": { run: () => useAppStore.getState().setZoomLevel(0.04) },
  "view.res.third": { run: () => useAppStore.getState().setZoomLevel(0.02) },
  "view.res.quarter": { run: () => useAppStore.getState().setZoomLevel(0.01) },
  "time.set": { run: () => useAppStore.getState().pushNotice("info", "在监视器下方的时间码处输入即可跳转") },

  // ---------- 帮助 ----------
  "app.about": {
    run: () =>
      useAppStore
        .getState()
        .pushNotice("info", `Reelix ${APP_VERSION} · 小方工作室 Fangwork 出品`),
  },
  "help.site": { run: () => openUrl(SITE) },
  "help.qq": { run: () => openUrl(QQ_GROUP) },
  "help.issues": { run: () => openUrl(ISSUES) },
};

/** 去掉命令 id 里的参数尾巴（`app.settings {"page":"x"}` → `app.settings`） */
function bareId(id: string): string {
  const at = id.indexOf(" ");
  return at < 0 ? id : id.slice(0, at);
}

let seqCounter = 0;

/** 全量树 → 可执行菜单（命中 ACTIONS 绑定真命令，未命中置灰） */
function toMenuItems(nodes: FullMenuNode[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const node of nodes) {
    seqCounter += 1;
    const key = `full.${seqCounter}`;
    if (node.sep) {
      out.push({ id: key, label: "", separator: true });
      continue;
    }
    if (node.children && node.children.length > 0) {
      out.push({
        id: node.id ? `${node.id}` : key,
        label: node.label ?? "",
        children: toMenuItems(node.children),
      });
      continue;
    }
    const action = node.id ? ACTIONS[bareId(node.id)] : undefined;
    out.push({
      id: node.id ?? key,
      label: node.label ?? "",
      shortcut: node.shortcut,
      run: action?.run,
      enabled: action ? action.enabled : () => false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 剪辑页补充菜单（FC 参考 的视图/窗口/帮助三组，FC 参考 命令表里没有）
// ---------------------------------------------------------------------------

const THEME_ITEMS: MenuItem[] = [
  {
    id: "theme.light",
    label: "亮",
    enabled: () => useAppStore.getState().theme !== "light",
    run: () => useAppStore.getState().setTheme("light"),
  },
  {
    id: "theme.dark",
    label: "暗",
    enabled: () => useAppStore.getState().theme !== "dark",
    run: () => useAppStore.getState().setTheme("dark"),
  },
];

const VIEW_MENU: MenuItem = {
  id: "view",
  label: "视图",
  children: [
    { id: "view.page.edit", label: "剪辑工作区", run: () => useAppStore.getState().setPage("edit") },
    { id: "view.page.media", label: "素材工作区", run: () => useAppStore.getState().setPage("media") },
    { id: "view.page.fx", label: "特效工作区", run: () => useAppStore.getState().setPage("fx") },
    { id: "view.page.deliver", label: "导出工作区", run: () => useAppStore.getState().setPage("deliver") },
    { id: "view.sep1", label: "", separator: true },
    { id: "view.zoomIn", label: "放大时间线", shortcut: "Ctrl+=", run: () => zoomBy(1.25) },
    { id: "view.zoomOut", label: "缩小时间线", shortcut: "Ctrl+-", run: () => zoomBy(1 / 1.25) },
    { id: "view.fit", label: "缩放到整段", run: () => useAppStore.getState().setZoomLevel(0.01) },
    { id: "view.sep2", label: "", separator: true },
    { id: "view.curve", label: "显示关键帧曲线", run: () => {
      const s = useAppStore.getState();
      if (s.selectedClipId) s.setCurveExpanded(s.selectedClipId);
    } },
    { id: "view.sep3", label: "", separator: true },
    { id: "view.theme", label: "主题", children: THEME_ITEMS },
  ],
};

const WINDOW_MENU: MenuItem = {
  id: "window",
  label: "窗口",
  children: [
    { id: "window.edit", label: "剪辑", run: () => useAppStore.getState().setPage("edit") },
    { id: "window.media", label: "项目", run: () => useAppStore.getState().setPage("media") },
    { id: "window.fx", label: "特效", run: () => useAppStore.getState().setPage("fx") },
    { id: "window.deliver", label: "导出", run: () => useAppStore.getState().setPage("deliver") },
    { id: "window.sep1", label: "", separator: true },
    {
      id: "window.workspaces",
      label: "工作区（特效页）",
      children: [
        { id: "ws.default", label: "默认", run: () => useAppStore.getState().applyFxWorkspace("Default") },
        { id: "ws.review", label: "审阅", run: () => useAppStore.getState().applyFxWorkspace("Review") },
        { id: "ws.learn", label: "学习", run: () => useAppStore.getState().applyFxWorkspace("Learn") },
        { id: "ws.small", label: "小屏幕", run: () => useAppStore.getState().applyFxWorkspace("Small Screen") },
        { id: "ws.standard", label: "标准", run: () => useAppStore.getState().applyFxWorkspace("Standard") },
        { id: "ws.all", label: "所有面板", run: () => useAppStore.getState().applyFxWorkspace("All Panels") },
        { id: "ws.effects", label: "效果", run: () => useAppStore.getState().applyFxWorkspace("Effects") },
        { id: "ws.text", label: "文字", run: () => useAppStore.getState().applyFxWorkspace("Text") },
        { id: "ws.color", label: "调色", run: () => useAppStore.getState().applyFxWorkspace("Color") },
      ],
    },
  ],
};

const HELP_MENU: MenuItem = {
  id: "help",
  label: "帮助",
  children: [
    { id: "help.qq", label: "加入小方工作室 QQ 群", run: () => openUrl(QQ_GROUP) },
    { id: "help.site", label: "小方工作室官网", run: () => openUrl(SITE) },
    { id: "help.issues", label: "在 GitHub 上报告问题", run: () => openUrl(ISSUES) },
    { id: "help.sep1", label: "", separator: true },
    {
      id: "app.about",
      label: "关于 Reelix",
      run: () =>
        useAppStore
          .getState()
          .pushNotice("info", `Reelix ${APP_VERSION} · 小方工作室 Fangwork 出品`),
    },
  ],
};

/** 打开最近项目（动态子菜单） */
function recentItems(): MenuItem[] {
  const recents = loadRecentProjects();
  if (recents.length === 0) {
    return [{ id: "recent.empty", label: "无最近文件", enabled: () => false }];
  }
  return recents.map((r, i) => ({
    id: `recent.${i}`,
    label: r.name,
    run: () => void openProjectAt(r.path),
  }));
}

/** 把"打开最近的文件"占位子菜单换成动态列表 */
function injectRecent(items: MenuItem[]): MenuItem[] {
  return items.map((it) => {
    if (it.children) {
      const children = injectRecent(it.children);
      if (it.label === "打开最近的文件" || it.label === "打开最近项目") {
        return { ...it, children: [...recentItems(), ...children.filter((c) => c.separator)] };
      }
      return { ...it, children };
    }
    return it;
  });
}

// ---------------------------------------------------------------------------
// 导出：剪辑页九菜单 / 特效页九菜单
// ---------------------------------------------------------------------------

/** 剪辑页：FC 参考 全量五组（文件/编辑/片段/序列/标记）+ 视图/窗口/帮助 = 八组 */
export const EDIT_MENUS: MenuItem[] = [
  ...injectRecent(toMenuItems(FC_MENUS)),
  VIEW_MENU,
  WINDOW_MENU,
  HELP_MENU,
];

/** 特效页：EC 参考 九菜单全量（文件/编辑/合成/图层/效果/动画/视图/窗口/帮助） */
export const FX_MENUS: MenuItem[] = injectRecent(toMenuItems(EC_MENUS));
