/**
 * 应用外壳。
 *
 * 达芬奇式四页面架构：素材 / 剪辑 / 特效 / 导出，页面导航条在顶栏下方。
 * - 素材页：素材箱以宽版铺满，专注整理；
 * - 剪辑页：上半区「素材箱 · 监视器 · 属性面板」，下半区时间线 / 曲线编辑器
 *   （二级页签），另有「剪辑 / 音频 / 调色」三个子页签换上半区的面板组合；
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

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { TopBar } from "./components/TopBar";
import { MediaBin } from "./components/MediaBin";
import { Monitor } from "./components/Monitor";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { TimelineView } from "./components/TimelineView";
import { EffectsBrowser } from "./components/EffectsBrowser";
import { EffectControls } from "./components/EffectControls";
import { ExportPage } from "./components/ExportPage";
import { RecordingPanel } from "./components/RecordingPanel";
import { SpatialPanel } from "./components/SpatialPanel";
import { StartScreen } from "./components/StartScreen";
import { useAppStore } from "./store/appStore";
import type { PageTab } from "./store/appStore";
import {
  addSubtitleAtPlayhead,
  bootstrapProject,
  deleteSelectedClips,
  initExportProgress,
  openProject,
  openStartScreen,
  redo,
  saveProject,
  saveProjectAs,
  splitAtPlayhead,
  undo,
} from "./store/projectActions";
import { snapToFrame } from "./core/timecode";

/** 大页面的页签定义，顺序即界面顺序 */
const PAGES: Array<{ key: PageTab; label: string }> = [
  { key: "media", label: "素材" },
  { key: "edit", label: "剪辑" },
  { key: "fx", label: "特效" },
  { key: "deliver", label: "导出" },
];

/** 剪辑页的上半区子页签 */
type EditorTab = "cut" | "audio" | "grade" | "spatial";

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
  // 剪辑页的子页签：剪辑 / 音频 / 调色，只换上半区的面板组合
  const [editorTab, setEditorTab] = useState<EditorTab>("cut");
  // 右上角工具条按有没有选中片段决定切割 / 删除能不能点
  const selectedCount = useAppStore((s) => s.selectedClipIds.length);

  // 特效页左栏（效果库）宽度：可拖，存本地，下次启动保持
  const [fxBrowserW, setFxBrowserW] = useState(() => {
    const raw = Number(localStorage.getItem("reelix:fx-browser-w"));
    return Number.isFinite(raw) && raw >= 180 && raw <= 420 ? raw : 240;
  });
  const fxUpperRef = useRef<HTMLDivElement>(null);

  const startFxSplit = (e: ReactPointerEvent<HTMLDivElement>) => {
    const upper = fxUpperRef.current;
    if (!upper) return;
    e.preventDefault();
    const rect = upper.getBoundingClientRect();
    let last = fxBrowserW;
    const move = (ev: PointerEvent) => {
      last = Math.round(Math.max(180, Math.min(420, ev.clientX - rect.left)));
      setFxBrowserW(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem("reelix:fx-browser-w", String(last));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // 没有工程、或用户主动开了开场界面时，整屏让给开场，不铺空面板
  const showEditor = project !== null && !startScreen;

  // 主题令牌挂在 <html data-theme> 上，tokens.css 靠它切换浅色主题
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // 启动时问一次后端：已经打开工程就回填，否则进入「未打开」引导态
  useEffect(() => {
    void bootstrapProject();
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const state = useAppStore.getState();
      const mod = e.ctrlKey || e.metaKey;

      // 组合键：不管焦点在哪都要生效（存盘、撤销这类动作不该被输入框挡住）
      if (mod) {
        switch (e.key.toLowerCase()) {
          case "n":
            e.preventDefault();
            // 新建工程先出开场，把画幅 / 帧率 / 色彩空间定下来再建
            openStartScreen();
            return;
          case "o":
            e.preventDefault();
            void openProject();
            return;
          case "s":
            e.preventDefault();
            if (e.shiftKey) void saveProjectAs();
            else void saveProject();
            return;
          case "z":
            e.preventDefault();
            if (e.shiftKey) void redo();
            else void undo();
            return;
          case "y":
            e.preventDefault();
            void redo();
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
      {showEditor ? (
        <div className="app-pages">
          <TopBar />

          <div className="page-shell">
            <div className="page-tabs">
              {PAGES.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className={`page-tab${page === p.key ? " active" : ""}`}
                  onClick={() => setPage(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="page-body">
              {page === "media" && (
                <div className="page-media">
                  <div className="page-media-bin">
                    <MediaBin />
                  </div>
                  <div className="page-media-hint">
                    导入的素材先收在素材箱里：拖到剪辑页时间线的轨道上轨；带声音的视频会自动拆成画面 + 声音两段并粘在一起
                  </div>
                </div>
              )}

              {page === "edit" && (
                <div className="page-edit">
                  <div className="editor-tabs">
                    <div className="editor-tabs-group">
                      {(
                        [
                          { key: "cut", label: "剪辑" },
                          { key: "audio", label: "音频" },
                          { key: "grade", label: "调色" },
                          { key: "spatial", label: "空间" },
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
                      <button
                        type="button"
                        className="editor-tool"
                        title="在播放头处加字幕"
                        onClick={() => void addSubtitleAtPlayhead()}
                      >
                        字幕
                      </button>
                      <span className="editor-tool-sep" />
                      <button
                        type="button"
                        className={`editor-tool${editorTab === "spatial" ? " active" : ""}`}
                        title="3D 空间场景识别"
                        onClick={() => setEditorTab("spatial")}
                      >
                        空间识别
                      </button>
                      <button
                        type="button"
                        className="editor-tool"
                        title="打开特效工作区"
                        onClick={() => setPage("fx")}
                      >
                        特效
                      </button>
                      <button
                        type="button"
                        className="editor-tool primary"
                        title="去导出"
                        onClick={() => setPage("deliver")}
                      >
                        导出
                      </button>
                    </div>
                  </div>

                  {editorTab === "cut" && (
                    <div className="upper">
                      <MediaBin />
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
                  {editorTab === "grade" && (
                    <div className="upper upper-grade">
                      <Monitor />
                      <div className="grade-side">
                        <div className="grade-hint">
                          选中片段后在效果栈调「调色」类效果，参数拖动即时生效
                        </div>
                        <PropertiesPanel />
                      </div>
                    </div>
                  )}
                  {editorTab === "spatial" && (
                    <div className="upper upper-spatial">
                      <SpatialPanel />
                    </div>
                  )}

                  <div className="lower">
                    {/* 曲线不再单独占一格：选中片段打了关键帧后，
                        曲线行在时间线轨道下方就地展开（点片段右上角的菱形，
                        或右键「显示关键帧曲线」） */}
                    <TimelineView />
                  </div>
                </div>
              )}

              {page === "fx" && (
                <div className="page-fx">
                  {/* 曲线不再单独占页签：点亮秒表后，曲线行在剪辑页时间线该片段下方就地展开 */}
                  <div className="fx-page-hint">
                    <span>
                      点亮效果参数的秒表打关键帧，曲线行会就地长在剪辑页时间线该片段的下方；这里先调数值
                    </span>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        // 曲线不再单独占页签：跳回剪辑页并就地展开选中片段的曲线行
                        const clipId = useAppStore.getState().selectedClipId;
                        setPage("edit");
                        useAppStore.getState().setCurveExpanded(clipId);
                      }}
                    >
                      显示关键帧曲线
                    </button>
                  </div>
                  <div
                    className="upper upper-fx"
                    ref={fxUpperRef}
                    style={{ gridTemplateColumns: `${fxBrowserW}px 6px 1fr 340px` }}
                  >
                    <EffectsBrowser
                      onOpenSpatial={() => {
                        setPage("edit");
                        setEditorTab("spatial");
                      }}
                    />
                    <div
                      className="fx-split"
                      title="拖动调整效果库宽度（双击恢复 240px）"
                      onPointerDown={startFxSplit}
                      onDoubleClick={() => {
                        setFxBrowserW(240);
                        localStorage.setItem("reelix:fx-browser-w", "240");
                      }}
                    />
                    <Monitor />
                    <EffectControls />
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
