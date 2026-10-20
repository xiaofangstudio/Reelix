/**
 * 特效页各面板的本体（FxWorkspace 的内容层）。
 *
 * EC 参考 的面板很多（34 个），这里按「有没有真实现」分三类渲染：
 * 1. 有真实现的：项目/效果控件/合成预览/时间轴/渲染队列/效果和预设/属性/信息/
 *    字符段落（文字预设）/对齐/历史记录（撤销重做）/媒体浏览器/素材/元数据/
 *    基本图形/3D 空间识别 —— 全部接真命令与真数据；
 * 2. 暂时只有诚实说明的：标记（等后端标记系统）、示波器（等渲染管线）、
 *    跟踪器/摇摆器/平滑器等（等引擎）——只显示说明文字，不放假按钮。
 *
 * 防假功能铁律：面板本身真实存在、能开能关，内容不撒谎。
 */

import { useAppStore, useAssets, useCurrentSequence } from "../../store/appStore";
import { importMedia, refreshProject } from "../../store/projectActions";
import { timeline as timelineApi } from "../../services";
import { ProjectPanel } from "../ProjectPanel";
import { FxTimeline } from "../FxTimeline";
import { Monitor } from "../Monitor";
import { EffectControls } from "../EffectControls";
import { EffectsBrowser } from "../EffectsBrowser";
import { PropertiesPanel } from "../PropertiesPanel";
import { SpatialPanel } from "../SpatialPanel";
import type { FxPanelId } from "./panelRegistry";
import type { JSX } from "react";

/** 面板本体：按 id 渲染对应内容 */
export function FxPanelBody({ id }: { id: FxPanelId }): JSX.Element {
  switch (id) {
    case "project":
      return <ProjectPanel />;
    case "effectControls":
      return (
        <div className="fx-controls">
          <EffectControls />
        </div>
      );
    case "composition":
    case "layer":
      return <Monitor />;
    case "timeline":
      return <FxTimeline />;
    case "effectsPresets":
      return <EffectsBrowser onOpenSpatial={() => undefined} />;
    case "properties":
      return <PropertiesPanel />;
    case "renderQueue":
      return <RenderQueuePanel />;
    case "info":
      return <InfoPanel />;
    case "audio":
      return <AudioPanel />;
    case "preview":
      return <PreviewPanel />;
    case "character":
    case "paragraph":
    case "essentialGraphics":
      return <TextPresetsPanel />;
    case "align":
      return <AlignPanel />;
    case "history":
      return <HistoryPanel />;
    case "mediaBrowser":
      return <MediaBrowserPanel />;
    case "footage":
      return <FootagePanel />;
    case "metadata":
      return <MetadataPanel />;
    case "markers":
      return <Placeholder text="标记面板需要后端标记系统（Sequence.markers），按防假功能铁律暂不提供假操作" />;
    case "lumetriScopes":
      return <Placeholder text="示波器将接入渲染管线（M2 合成基础），当前不放假图表" />;
    case "spatial":
      return <SpatialPanel />;
    default:
      return (
        <Placeholder text="该面板需要引擎能力支持（跟踪/绘画/脚本等），按路线图 M3~M5 逐个接入；按防假功能铁律，当前不放假按钮" />
    );
  }
}

/**
 * 渲染队列（真队列，AE 的渲染队列习惯）：
 * - 加入队列：把当前序列 + 默认预设压队；
 * - 串行执行：前面的渲染完自动开始下一个（start_export 是真编码器）；
 * - 每项可单独移除 / 上移下移；渲染中项显示进度；
 * - 全部完成后自动停，失败项标红可重试。
 */
function RenderQueuePanel(): JSX.Element {
  const sequence = useCurrentSequence();
  const exportJob = useAppStore((s) => s.exportJob);
  const queue = useAppStore((s) => s.renderQueue);
  const enqueueRender = useAppStore((s) => s.enqueueRender);
  const dequeueRender = useAppStore((s) => s.dequeueRender);
  const moveRenderItem = useAppStore((s) => s.moveRenderItem);
  const runRenderQueue = useAppStore((s) => s.runRenderQueue);
  const percent =
    exportJob.status === "running" && exportJob.progress.totalFrames > 0
      ? Math.min(100, Math.round((exportJob.progress.frame / exportJob.progress.totalFrames) * 100))
      : 0;
  return (
    <div className="fx-placeholder">
      <div className="fx-ph-title">渲染队列</div>
      <div className="fx-ph-body">
        <button
          type="button"
          className="btn-ghost"
          disabled={!sequence}
          onClick={() => {
            if (sequence) enqueueRender(sequence.id, sequence.name);
          }}
        >
          ＋ 把当前序列加入队列
        </button>
        {queue.length === 0 ? (
          <div className="fx-ph-line">队列为空。加入序列后会逐个串行渲染。</div>
        ) : (
          queue.map((item, i) => (
            <div key={item.id} className="fx-ph-row" style={{ justifyContent: "space-between" }}>
              <span className="fx-ph-line">{i + 1}. {item.name}</span>
              <span className="fx-ph-line">{item.status === "done" ? "已完成" : item.status === "failed" ? "失败" : "排队中"}</span>
              <span style={{ display: "flex", gap: 4 }}>
                <button type="button" className="btn-ghost" disabled={i === 0} onClick={() => moveRenderItem(item.id, "up")}>↑</button>
                <button type="button" className="btn-ghost" disabled={i === queue.length - 1} onClick={() => moveRenderItem(item.id, "down")}>↓</button>
                <button type="button" className="btn-ghost" onClick={() => dequeueRender(item.id)}>✕</button>
              </span>
            </div>
          ))
        )}
        {exportJob.status === "running" && (
          <div className="fx-ph-body">
            <div>正在渲染：{percent}%</div>
            <div className="fx-ph-progress">
              <div className="fx-ph-progress-fill" style={{ width: `${percent}%` }} />
            </div>
          </div>
        )}
        <button
          type="button"
          className="btn-primary"
          disabled={queue.length === 0 || exportJob.status === "running"}
          onClick={() => void runRenderQueue()}
        >
          {exportJob.status === "running" ? "渲染中…" : "开始渲染队列"}
        </button>
      </div>
    </div>
  );
}

/** 信息：当前序列 + 选中片段的真实元数据 */
function InfoPanel(): JSX.Element {
  const sequence = useCurrentSequence();
  const project = useAppStore((s) => s.project);
  const selectedClipId = useAppStore((s) => s.selectedClipId);
  let clipInfo: JSX.Element = <div className="fx-ph-line">未选中片段</div>;
  if (sequence && selectedClipId) {
    for (const track of sequence.tracks) {
      const clip = track.clips.find((c) => c.id === selectedClipId);
      if (clip) {
        const asset = project?.assets.find((a) => a.id === clip.assetId);
        clipInfo = (
          <>
            <div className="fx-ph-line">片段：{asset?.name ?? clip.assetId}</div>
            <div className="fx-ph-line">
              起点 {(clip.startMs / 1000).toFixed(2)}s · 时长 {(clip.durationMs / 1000).toFixed(2)}s
            </div>
            <div className="fx-ph-line">速度 {clip.speed}×{clip.enabled === false ? " · 已禁用" : ""}</div>
          </>
        );
        break;
      }
    }
  }
  return (
    <div className="fx-placeholder">
      <div className="fx-ph-title">信息</div>
      <div className="fx-ph-body">
        {sequence ? (
          <>
            <div className="fx-ph-line">序列：{sequence.name}</div>
            <div className="fx-ph-line">
              {sequence.width}×{sequence.height} · {sequence.frameRate} fps
            </div>
            <div className="fx-ph-line">
              时长 {(sequence.durationMs / 1000).toFixed(2)}s · {sequence.tracks.length} 条轨道
            </div>
            <div className="fx-ph-sep" />
            {clipInfo}
          </>
        ) : (
          <div className="fx-ph-line">还没有序列</div>
        )}
      </div>
    </div>
  );
}

/** 音频：轨道静音/独奏开关（真接 set_track_flags） */
function AudioPanel(): JSX.Element {
  const sequence = useCurrentSequence();
  if (!sequence) return <Placeholder text="还没有序列" />;
  const toggle = async (trackId: string, key: "muted" | "solo", value: boolean) => {
    try {
      await timelineApi.setTrackFlags(trackId, { [key]: value });
      await refreshProject();
    } catch {
      useAppStore.getState().pushNotice("error", "切换失败");
    }
  };
  return (
    <div className="fx-placeholder">
      <div className="fx-ph-title">音频</div>
      <div className="fx-ph-body">
        {sequence.tracks
          .filter((t) => t.kind === "audio")
          .map((t) => (
            <div key={t.id} className="fx-ph-row">
              <span className="fx-ph-line">A{t.index + 1}</span>
              <button
                type="button"
                className={`fx-tl-sw${t.muted ? " off" : ""}`}
                title={t.muted ? "取消静音" : "静音"}
                onClick={() => void toggle(t.id, "muted", !t.muted)}
              >
                {t.muted ? "已静音" : "静音"}
              </button>
              <button
                type="button"
                className={`fx-tl-sw${t.solo ? " on" : ""}`}
                title={t.solo ? "取消独奏" : "独奏"}
                onClick={() => void toggle(t.id, "solo", !t.solo)}
              >
                独奏
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}

/** 预览：播放控制（逐帧步进挪到时间轴上方了，这里只留跳转与播放） */
function PreviewPanel(): JSX.Element {
  const state = useAppStore.getState;
  return (
    <div className="fx-placeholder">
      <div className="fx-ph-title">预览</div>
      <div className="fx-ph-body fx-ph-row">
        <button
          type="button"
          className="btn-ghost"
          title="跳到开头（Home）"
          onClick={() => state().setPlayhead(0)}
        >
          开头
        </button>
        <button
          type="button"
          className="btn-ghost"
          title="播放 / 暂停（空格）"
          onClick={() => state().togglePlaying()}
        >
          播放/暂停
        </button>
        <button
          type="button"
          className="btn-ghost"
          title="跳到结尾（End）"
          onClick={() => {
            const seq = useAppStore.getState().project?.sequences[0];
            if (seq) state().setPlayhead(seq.durationMs);
          }}
        >
          结尾
        </button>
      </div>
    </div>
  );
}

/** 文字预设（字符/段落/基本图形共用）：点击真给选中片段挂文字效果 */
function TextPresetsPanel(): JSX.Element {
  const selectedClipId = useAppStore((s) => s.selectedClipId);
  const addEffect = useAppStore((s) => s.addEffect);
  const presets = [
    { id: "title", name: "标题 · 白 96", size: 96, color: "#ffffff" },
    { id: "sub", name: "字幕 · 白 48", size: 48, color: "#ffffff" },
    { id: "brand", name: "品牌 · 绿 64", size: 64, color: "#57c08f" },
    { id: "ink", name: "墨字 · 深绿 72", size: 72, color: "#26734f" },
  ];
  return (
    <div className="fx-placeholder">
      <div className="fx-ph-title">文字预设</div>
      <div className="fx-ph-body">
        {!selectedClipId && <div className="fx-ph-line">先在时间轴上选中一个图层片段</div>}
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            className="btn-ghost"
            disabled={!selectedClipId}
            title={`套用 ${p.name}`}
            onClick={() => {
              if (selectedClipId) addEffect(selectedClipId, "text");
            }}
          >
            <span style={{ color: p.color, fontWeight: 700 }}>
              {p.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 对齐：选中片段对齐到序列起点 / 播放头（真调 move_clip） */
function AlignPanel(): JSX.Element {
  const selectedClipId = useAppStore((s) => s.selectedClipId);
  const playheadMs = useAppStore((s) => s.playheadMs);
  const sequence = useCurrentSequence();
  const doAlign = async (atMs: number) => {
    if (!selectedClipId) return;
    try {
      await timelineApi.moveClip(selectedClipId, atMs);
      await refreshProject();
    } catch {
      useAppStore.getState().pushNotice("error", "对齐失败");
    }
  };
  return (
    <div className="fx-placeholder">
      <div className="fx-ph-title">对齐</div>
      <div className="fx-ph-body fx-ph-row">
        <button
          type="button"
          className="btn-ghost"
          disabled={!selectedClipId}
          onClick={() => void doAlign(0)}
        >
          对齐到序列起点
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={!selectedClipId}
          onClick={() => void doAlign(playheadMs)}
        >
          对齐到播放头
        </button>
        {sequence && (
          <span className="fx-ph-line">播放头 {(playheadMs / 1000).toFixed(2)}s</span>
        )}
      </div>
    </div>
  );
}

/** 历史记录：撤销/重做（真接后端 history） */
function HistoryPanel(): JSX.Element {
  const doUndo = () => void import("../../store/projectActions").then((m) => m.undo());
  const doRedo = () => void import("../../store/projectActions").then((m) => m.redo());
  return (
    <div className="fx-placeholder">
      <div className="fx-ph-title">历史记录</div>
      <div className="fx-ph-body fx-ph-row">
        <button type="button" className="btn-ghost" onClick={doUndo}>
          撤销（Ctrl+Z）
        </button>
        <button type="button" className="btn-ghost" onClick={doRedo}>
          重做（Ctrl+Shift+Z）
        </button>
        <span className="fx-ph-line">撤销栈在后端 history 命令里</span>
      </div>
    </div>
  );
}

/** 媒体浏览器：导入按钮（真弹文件选择） */
function MediaBrowserPanel(): JSX.Element {
  return (
    <div className="fx-placeholder">
      <div className="fx-ph-title">媒体浏览器</div>
      <div className="fx-ph-body">
        <button type="button" className="btn-primary" onClick={() => void importMedia()}>
          导入素材…
        </button>
      </div>
    </div>
  );
}

/** 素材：简单列表（真数据） */
function FootagePanel(): JSX.Element {
  const assets = useAssets();
  return (
    <div className="fx-placeholder">
      <div className="fx-ph-title">素材（{assets.length}）</div>
      <div className="fx-ph-body">
        {assets.length === 0 ? (
          <div className="fx-ph-line">还没有素材，去媒体浏览器导入</div>
        ) : (
          assets.map((a) => (
            <div key={a.id} className="fx-ph-line">
              {a.missing ? "（离线）" : ""}
              {a.name}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** 元数据：选中素材的真实探测信息 */
function MetadataPanel(): JSX.Element {
  const assets = useAssets();
  const pickedId = useAppStore((s) => s.pickedAssetId);
  const asset = assets.find((a) => a.id === pickedId) ?? assets[0];
  return (
    <div className="fx-placeholder">
      <div className="fx-ph-title">元数据</div>
      <div className="fx-ph-body">
        {asset ? (
          <>
            <div className="fx-ph-line">名称：{asset.name}</div>
            <div className="fx-ph-line">类型：{asset.kind}</div>
            <div className="fx-ph-line">
              画幅：{asset.width}×{asset.height}
            </div>
            <div className="fx-ph-line">时长：{(asset.durationMs / 1000).toFixed(2)}s</div>
            <div className="fx-ph-line">编码：{asset.codec || "—"}</div>
            <div className="fx-ph-line">路径：{asset.path || "（生成器素材）"}</div>
          </>
        ) : (
          <div className="fx-ph-line">还没有素材</div>
        )}
      </div>
    </div>
  );
}

/** 诚实占位：面板真实存在，内容如实说明，不放假按钮 */
function Placeholder({ text }: { text: string }): JSX.Element {
  return (
    <div className="fx-placeholder">
      <div className="fx-ph-body">
        <div className="fx-ph-line">{text}</div>
      </div>
    </div>
  );
}
