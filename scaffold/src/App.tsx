/**
 * 应用外壳。
 *
 * 达芬奇式四页面架构：素材 / 剪辑 / 特效 / 导出，页面导航条在顶栏下方。
 * - 素材页：素材箱以宽版铺满，专注整理；
 * - 剪辑页：上半区「素材箱 · 监视器 · 属性面板」（剪辑 / 音频两个子页签换组合），
 *   下半区时间线（关键帧曲线在时间线轨道下方就地展开）；
 * - 特效页：效果库（左）+ 监视器（中）+ 效果控件（右），三栏照 AE 工作区
 *   的骨架搭——效果检索在左、参数与关键帧在右。关键帧曲线只归剪辑页时间线的
 *   二级页签管，这里给一条跳转提示，不再重复挂一份曲线编辑器；
 * - 导出页：整页让给 ExportPage。
 *
 * 这里还管三件全局的事：
 * 1. 启动时问后端当前有没有打开的工程，有就回填、没有就置为「未打开」引导；
 * 2. 全局快捷键（播放 / 逐帧 / 穿梭 / 文件与编辑）；
 * 3. 全局订阅导出进度——导出是后台任务，进度进 store，顶栏与导出页共用；
 * 4. 底部的提示条——所有失败与结果都以中文人话在这里露一次面。
 */

import { useEffect, useState } from "react";
import { MenuBar, runMenuCommand } from "./components/MenuBar";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ImmersiveMode } from "./components/ImmersiveMode";
import { GroupWizard } from "./components/GroupWizard";
import { SettingsPanel } from "./components/SettingsPanel";
import { TutorialPanel } from "./components/TutorialPanel";
import { IconPageMedia, IconPageEdit, IconPageFx, IconPageDeliver } from "./components/icons";
import { ToolBar } from "./components/ToolBar";
import { FxShell } from "./components/fx/FxShell";
import { EDIT_MENUS, FX_MENUS } from "./core/menuRegistry";
import { BinPanel } from "./components/BinPanel";
import { Monitor } from "./components/Monitor";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { TimelineView } from "./components/TimelineView";
import { ExportPage } from "./components/ExportPage";
import { RecordingPanel } from "./components/RecordingPanel";
import { StartScreen } from "./components/StartScreen";
import { useAppStore } from "./store/appStore";
import { importDropbox } from "./services/interop";
import { getSettings } from "./services/settings";
import { project as projectApi } from "./services";
import { projectIsDirty } from "./services/project";
import type { PageTab, ToolKind } from "./store/appStore";
import {
  bootstrapProject,
  addTimelineMarker,
  deleteSelectedClips,
  initExportProgress,
  moveSelectedToPlayhead,
  openStartScreen,
  redo,
  splitAtPlayhead,
  trimSelectedToPlayhead,
  undo,
} from "./store/projectActions";
import { snapToFrame } from "./core/timecode";

/** 大页面的页签定义，顺序即界面顺序 */
const PAGE_ICONS: Record<PageTab, () => JSX.Element> = {
  media: IconPageMedia,
  edit: IconPageEdit,
  fx: IconPageFx,
  deliver: IconPageDeliver,
};

const PAGES: Array<{ key: PageTab; label: string }> = [
  { key: "media", label: "素材" },
  { key: "edit", label: "剪辑" },
  { key: "fx", label: "特效" },
  { key: "deliver", label: "导出" },
];

/** 剪辑页的上半区子页签 */
type EditorTab = "cut" | "audio";

/** 光标正在输入框 / 文本域里时，单键快捷键要让路，不能抢字。 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

export function App() {
  const theme = useAppStore((s) => s.theme);
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const notice = useAppStore((s) => s.notice);
  const dismissNotice = useAppStore((s) => s.dismissNotice);
  const project = useAppStore((s) => s.project);
  const startScreen = useAppStore((s) => s.startScreen);
  // 剪辑页的子页签：剪辑 / 音频，只换上半区的面板组合
  const [editorTab, setEditorTab] = useState<EditorTab>("cut");
  /** 编组向导：工具栏「编组」按下后弹出（左侧点选 + 右下确认） */
  const [groupWizard, setGroupWizard] = useState(false);
  // 右上角工具条按有没有选中片段决定切割 / 删除能不能点
  const selectedCount = useAppStore((s) => s.selectedClipIds.length);
  // 时间线高度可拖（用户要求窗口能自由缩放，别绷死）
  const [lowerH, setLowerH] = useState(360);
  /** 偏好设置面板（模态）：主题 / 预览性能 / 自动保存 / 缓存。
   *  开关在 store 里——顶栏按钮、编辑菜单、Ctrl+, 三处都能开 */
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  /** 内置入门教程（模态）：开场界面与「帮助 ▸ 内置教程」共用，
   *  完全离线，不再依赖已经不通的官网 */
  const tutorialOpen = useAppStore((s) => s.tutorialOpen);
  const setTutorialOpen = useAppStore((s) => s.setTutorialOpen);



  // 没有工程、或用户主动开了开场界面时，整屏让给开场，不铺空面板
  const showEditor = project !== null && !startScreen;

  // 主题令牌挂在 <html data-theme> 上，tokens.css 靠它切换浅色主题
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // 启动时问一次后端：已经打开工程就回填，否则进入「未打开」引导态
  useEffect(() => {
    void bootstrapProject();
    // 后端设置里的主题优先：刷新 / 重启后保持用户选的主题
    void (async () => {
      try {
        const s = await getSettings();
        useAppStore.getState().setTheme(s.theme === "dark" ? "dark" : "light");
      } catch {
        /* 设置读不到就用默认浅色，不阻塞启动 */
      }
    })();
  }, []);

  /**
   * 自动保存（偏好设置里可调间隔 / 关闭）。
   * 两条底线：工程落过盘（有路径）才写——从没保存过的不弹框打扰，
   * 让用户先手动存一次；有未保存改动才写——没改动不反复刷盘。
   * 每 ticks 重新读一次间隔：在偏好设置里改了，下一班就生效。
   */
  useEffect(() => {
    let timer = 0;
    const schedule = async () => {
      let interval = 0;
      try {
        interval = (await getSettings()).autoSaveIntervalMs;
      } catch {
        interval = 0;
      }
      if (interval <= 0) return; // 设成「关闭」：不排下一班
      timer = window.setTimeout(async () => {
        const st = useAppStore.getState();
        if (st.project) {
          try {
            const [path, dirty] = await Promise.all([
              projectApi.getProjectPath(),
              projectIsDirty(),
            ]);
            if (path && dirty) await projectApi.saveProject(path);
          } catch {
            /* 自动保存失败不弹窗：下一班再试，手动 Ctrl+S 会给明确错误 */
          }
        }
        void schedule();
      }, interval);
    };
    void schedule();
    return () => window.clearTimeout(timer);
  }, []);

  // Strata 联动：每 3 秒扫一次投递箱（Strata 把改好的 PNG 写进来），
  // 有就自动导入素材箱并弹提示。窗口重新获得焦点时也立刻扫一次。
  useEffect(() => {
    const scan = async () => {
      try {
        const n = await importDropbox();
        if (n > 0) {
          useAppStore.getState().pushNotice("info", `Strata 送来 ${n} 张图，已进素材箱`);
        }
      } catch {
        /* 没开工程等场景安静失败 */
      }
    };
    const timer = window.setInterval(() => void scan(), 3000);
    window.addEventListener("focus", () => void scan());
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  // 全局订阅导出进度：任务跨页面存活，进度进 store，顶栏与导出页共用
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void initExportProgress().then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 全局快捷键。挂在 window 上只注册一次，运行时用 getState 读最新状态，避免闭包过期。
  // 快捷键以 menuRegistry 为唯一来源（菜单上标的全部真生效）：
  // 组合键先查注册表，查不到再走兜底；单键先查注册表，再走播放控制这套内置键。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const state = useAppStore.getState();

      /** 组合键折成注册表的写法：Ctrl+Shift+Z、Ctrl+S、Ctrl+Alt+N… */
      const modChord = (() => {
        const parts: string[] = [];
        if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
        if (e.shiftKey) parts.push("Shift");
        if (e.altKey) parts.push("Alt");
        if (parts.length === 0) return null;
        const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
        return `${parts.join("+")}+${key}`;
      })();

      if (modChord) {
        const menus = state.page === "fx" ? FX_MENUS : EDIT_MENUS;
        if (runMenuCommand(menus, modChord)) {
          e.preventDefault();
          return;
        }
        // 注册表没接的组合键兜底（Ctrl+Y 是历史习惯重做键；Ctrl+Alt+N 同 Ctrl+N）
        switch (e.key.toLowerCase()) {
          case "y":
            e.preventDefault();
            void redo();
            return;
          case "n":
            e.preventDefault();
            openStartScreen();
            return;
          case "z":
            e.preventDefault();
            if (e.shiftKey) void redo();
            else void undo();
            return;
          case "k":
            // 在播放头处切割选中的片段（单键 K 已经被「暂停」占用，所以走组合键）
            e.preventDefault();
            void splitAtPlayhead();
            return;
          default:
            return;
        }
      }

      // 单键快捷键：在输入框里打字时不抢
      if (isTypingTarget(e.target)) return;

      // 开场界面占着屏幕时不响应单键，免得空格把底下的工程播起来
      if (state.startScreen) return;

      if (e.key === "Escape") {
        state.dismissNotice();
        return;
      }

      // 单键 / Shift 单键也先查注册表（Delete 删除、Shift+Delete 波纹删除、\ 缩放到序列）
      if (e.key === "Delete" || e.key === "Backspace" || e.key === "\\") {
        const menus = state.page === "fx" ? FX_MENUS : EDIT_MENUS;
        const single = `${e.shiftKey ? "Shift+" : ""}${e.key}`;
        if (runMenuCommand(menus, single)) {
          e.preventDefault();
          return;
        }
      }

      // 工具快捷键（照 EC 参考：同一个键在组内循环）
      // V 选择组 / A 轨道选择 / B 波纹组 / C 剃刀 / Y 滑移组 / P 钢笔 / H 抓手组 / T 文字 / Z 缩放
      // S 在播放头处切割（剪映同款，比 Ctrl+K 更快）
      if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (state.selectedClipIds.length > 0) {
          e.preventDefault();
          void splitAtPlayhead();
          return;
        }
      }
      // Ctrl 组合快捷键（剪映基础组）
      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        // 撤销 / 重做：后端 history 栈早就有，只是以前没绑键
        if (key === "z") {
          e.preventDefault();
          if (e.shiftKey) state.redo();
          else state.undo();
          return;
        }
        if (key === "y") {
          e.preventDefault();
          state.redo();
          return;
        }
        if (key === "x") {
          e.preventDefault();
          state.cutClips();
          return;
        }
        if (key === "c") {
          e.preventDefault();
          state.copyClips();
          return;
        }
        if (key === "v") {
          e.preventDefault();
          void state.pasteClips();
          return;
        }
        if (key === "a") {
          e.preventDefault();
          state.selectAllClips();
          return;
        }
        if (key === "d") {
          // Ctrl+D = 复制并粘贴（剪映的快速复制）
          e.preventDefault();
          state.copyClips();
          void state.pasteClips();
          return;
        }
        if (key === ",") {
          // Ctrl+, = 偏好设置（PR / AE 同款快捷键）
          e.preventDefault();
          state.setSettingsOpen(true);
          return;
        }
      }
      const TOOL_CYCLES: Record<string, ToolKind[]> = {
        v: ["selection", "trackSelectForward", "trackSelectBackward"],
        a: ["trackSelectForward", "trackSelectBackward", "selection"],
        b: ["rippleEdit", "rolling", "rateStretch"],
        c: ["razor"],
        y: ["slip", "slide"],
        p: ["pen"],
        h: ["hand", "zoom"],
        z: ["zoom", "hand"],
        t: ["text"],
        u: ["rateStretch", "rippleEdit", "rolling"],
        r: ["rolling", "rippleEdit", "rateStretch"],
      };
      const cycle = TOOL_CYCLES[e.key.toLowerCase()];
      if (cycle && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        const cur = state.tool;
        const idx = cycle.indexOf(cur);
        state.setTool(cycle[(idx + 1) % cycle.length]);
        return;
      }

      // 没有工程就没有播放头可动，播放类快捷键直接不响应
      const sequence = state.project?.sequences[0];
      if (!sequence) return;

      const frameRate = sequence.frameRate ?? 25;
      const durationMs = sequence.durationMs ?? 0;
      const frameMs = 1000 / frameRate;

      /** 逐帧步进：先停下播放，再把播放头按帧吸附着挪。 */
      const step = (frames: number) => {
        state.pause();
        state.setPlayhead(snapToFrame(state.playheadMs + frames * frameMs, frameRate));
      };

      switch (e.key) {
        case " ":
          e.preventDefault();
          state.togglePlaying();
          return;
        case "j":
        case "J":
          e.preventDefault();
          state.shuttle(-1);
          return;
        case "k":
        case "K":
          e.preventDefault();
          state.pause();
          return;
        case "l":
        case "L":
          e.preventDefault();
          state.shuttle(1);
          return;
        case "ArrowLeft":
          e.preventDefault();
          step(e.shiftKey ? -10 : -1);
          return;
        case "ArrowRight":
          e.preventDefault();
          step(e.shiftKey ? 10 : 1);
          return;
        case "Delete":
        case "Backspace":
          // 删掉时间线上选中的片段（多选一次全删）
          e.preventDefault();
          void deleteSelectedClips();
          return;
        case "Home":
          e.preventDefault();
          state.pause();
          state.setPlayhead(0);
          return;
        case "End":
          e.preventDefault();
          state.pause();
          state.setPlayhead(durationMs);
          return;
        default:
          return;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <ImmersiveMode />
      {groupWizard && <GroupWizard onClose={() => setGroupWizard(false)} />}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {tutorialOpen && <TutorialPanel onClose={() => setTutorialOpen(false)} />}
      {showEditor ? (
        <div className="app-pages">
          {/* 唯一顶栏：菜单随页面切换（剪辑页 FC 参考 九菜单 / 特效页 EC 参考 九菜单），
              全部项来自 menuRegistry 且都接真实现；旧 TopBar 的假占位菜单已删除 */}
          {page === "fx" ? <MenuBar menus={FX_MENUS} /> : <MenuBar menus={EDIT_MENUS} />}

          <div className="page-shell">
            <div className="page-tabs">
              {PAGES.map((p) => {
                const Icon = PAGE_ICONS[p.key];
                return (
                  <button
                    key={p.key}
                    type="button"
                    className={`page-tab${page === p.key ? " active" : ""}`}
                    onClick={() => setPage(p.key)}
                    title={p.label}
                  >
                    <Icon />
                  </button>
                );
              })}
            </div>

            <div className="page-body">
              {page === "media" && (
                <div className="page-media">
                  <div className="page-media-bin">
                    <BinPanel />
                  </div>
                  <div className="page-media-hint">
                    导入的素材先收在素材箱里：拖到剪辑页时间线的轨道上轨；带声音的视频会自动拆成画面 + 声音两段并粘在一起
                  </div>
                </div>
              )}

              {page === "edit" && (
                <ErrorBoundary area="剪辑页">
                <div className="page-edit with-tools">
                  <div className="page-edit-main">
                  <div className="editor-tabs">
                    <div className="editor-tabs-group">
                      {(
                        [
                          { key: "cut", label: "剪辑" },
                          { key: "audio", label: "音频" },
                        ] as Array<{ key: EditorTab; label: string }>
                      ).map((t) => (
                        <button
                          key={t.key}
                          type="button"
                          className={`editor-tab${editorTab === t.key ? " active" : ""}`}
                          onClick={() => setEditorTab(t.key)}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>

                    {/* 常用动作不藏进菜单：撤销、切割、字幕、特效、导出随手就能点 */}
                    <div className="editor-tabs-actions">
                      <button
                        type="button"
                        className="editor-tool"
                        title="撤销（Ctrl+Z）"
                        onClick={() => void undo()}
                      >
                        撤销
                      </button>
                      <button
                        type="button"
                        className="editor-tool"
                        title="重做（Ctrl+Shift+Z）"
                        onClick={() => void redo()}
                      >
                        重做
                      </button>
                      <span className="editor-tool-sep" />
                      <button
                        type="button"
                        className="editor-tool"
                        title="在播放头处切割（Ctrl+K）"
                        disabled={selectedCount === 0}
                        onClick={() => void splitAtPlayhead()}
                      >
                        切割
                      </button>
                      <button
                        type="button"
                        className="editor-tool"
                        title="删除选中片段（Delete）"
                        disabled={selectedCount === 0}
                        onClick={() => void deleteSelectedClips()}
                      >
                        删除
                      </button>
                      <span className="editor-tool-sep" />
                      {/* 编组（弹点选向导：左侧勾选 + 右下角确认，真合并到一个轨道） */}
                      <button
                        type="button"
                        className="editor-tool"
                        title="创建编组：选成员 → 确认后合并到一个轨道"
                        disabled={selectedCount < 2}
                        onClick={() => setGroupWizard(true)}
                      >
                        编组
                      </button>
                      {/* 裁剪到播放头（对选中片段；摄像机/音频同样有效） */}
                      <button
                        type="button"
                        className="editor-tool"
                        title="裁剪并删除播放头左边的部分"
                        disabled={selectedCount === 0}
                        onClick={() => void trimSelectedToPlayhead("left")}
                      >
                        ✂ 删左
                      </button>
                      <button
                        type="button"
                        className="editor-tool"
                        title="裁剪并删除播放头右边的部分"
                        disabled={selectedCount === 0}
                        onClick={() => void trimSelectedToPlayhead("right")}
                      >
                        ✂ 删右
                      </button>
                      {/* 移到播放头：自动判断片段在播放头左/右 */}
                      <button
                        type="button"
                        className="editor-tool"
                        title="把选中片段移到播放头（按左右方向自动贴合）"
                        disabled={selectedCount === 0}
                        onClick={() => void moveSelectedToPlayhead()}
                      >
                        ⤢ 移到播放头
                      </button>
                      {/* 标记（打在时间轴顶部，带颜色分类） */}
                      <button
                        type="button"
                        className="editor-tool"
                        title="在播放头处打一个标记（时间轴顶部）"
                        onClick={() => {
                          const s = useAppStore.getState();
                          const seq = s.project?.sequences[0];
                          if (seq) void addTimelineMarker(seq.id, s.playheadMs);
                        }}
                      >
                        ⚑ 标记
                      </button>
                    </div>
                  </div>

                  {editorTab === "cut" && (
                    <div className="upper">
                      <BinPanel />
                      <Monitor />
                      <PropertiesPanel />
                    </div>
                  )}
                  {editorTab === "audio" && (
                    <div className="upper upper-audio">
                      <Monitor />
                      <RecordingPanel />
                      <PropertiesPanel />
                    </div>
                  )}

                  {/* 可拖分隔条：上下拖改时间线高度（用户要求窗口能自由缩放） */}
                  <div
                    className="edit-split"
                    title="拖动调整时间线高度（双击恢复默认）"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      const startY = e.clientY;
                      const startH = lowerH;
                      const move = (ev: PointerEvent) => {
                        const next = Math.max(
                          140,
                          Math.min(window.innerHeight - 300, startH - (ev.clientY - startY))
                        );
                        setLowerH(next);
                      };
                      const up = () => {
                        window.removeEventListener("pointermove", move);
                        window.removeEventListener("pointerup", up);
                      };
                      window.addEventListener("pointermove", move);
                      window.addEventListener("pointerup", up);
                    }}
                    onDoubleClick={() => setLowerH(360)}
                  />

                  <div className="lower" style={{ height: lowerH }}>
                    {/* 工具栏移到时间线顶部横排（用户要求：更常用） */}
                    <ToolBar />
                    {/* 调色不走底部 Tab（用户否决）：调色在右上属性面板的
                        「调节」页里（属性面板顶部小页签切换，剪映式布局） */}
                    <TimelineView />
                  </div>
                  </div>
                </div>
                </ErrorBoundary>
              )}


              {page === "fx" && (
                <div className="page-fx">
                  {/* EC 参考 停靠工作区（照 dock.rs）：可拖分隔条、页签组、
                      右列可折叠面板栈、15 个工作区预设；面板本体 FxPanels.tsx 全真实现 */}
                  <div className="page-fx-main">
                    <FxShell />
                  </div>
                </div>
              )}

              {page === "deliver" && <ExportPage />}
            </div>
          </div>
        </div>
      ) : (
        <StartScreen />
      )}

      {notice && (
        <div className={`notice-bar ${notice.kind}`} role="status">
          <span className="notice-text">{notice.text}</span>
          <button
            type="button"
            className="notice-close"
            onClick={dismissNotice}
            title="关闭提示"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}

export default App;
