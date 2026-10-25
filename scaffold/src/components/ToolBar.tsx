/**
 * 左侧竖排工具栏（照 FC 参考 的工具集，槽位分组照 EC 参考 的 SLOTS 思路）。
 *
 * 交互规则（与 EC 参考 一致）：
 * - **单击**槽位 = 选中该槽的当前工具；
 * - **右键**槽位 = 弹出组内全部工具（右下角小三角表示该槽有多个工具）；
 * - **快捷键**（V/A/B/R/U/C/Y/P/H/Z/T）= 组内循环，见 App.tsx 全局键盘；
 * - 每个工具都接真实行为：剃刀点片段即切、波纹/滚动/速度拉伸拖边缘、滑移拖内部、
 *   抓手平移、缩放点时间线、文字点片段加字幕、选择/轨道选择点片段选整段。
 * 图标全是内联 SVG（icons.tsx），无 emoji 无文字单字。
 */

import { useState } from "react";
import { useAppStore } from "../store/appStore";
import { TextTab, GeneratorsTab } from "./BinPanel";
import { splitAtPlayhead, addTextToSelectedClip, addTimelineMarker, refreshProject } from "../store/projectActions";
import { timeline as timelineApi } from "../services";
import { TOOL_ICONS, IconCurve, IconCut, IconPlus, IconText, IconKeyframe, IconKeyPrev, IconKeyNext, IconTrimLeft, IconTrimRight, IconMoveToPlayhead } from "./icons";
import type { ToolKind } from "../store/appStore";

/** 一个工具槽：第一个是单击默认工具，全部成员可右键/循环切换 */
interface ToolSlot {
  tools: Array<{ kind: ToolKind; label: string; key: string }>;
}

/** 槽位定义（照 EC 参考 的 Tool::SLOTS：同组工具共用一个按钮位） */
const SLOTS: ToolSlot[] = [
  {
    tools: [
      { kind: "selection", label: "选择工具", key: "V" },
      { kind: "trackSelectForward", label: "轨道向前选择", key: "A" },
      { kind: "trackSelectBackward", label: "轨道向后选择", key: "Shift+A" },
    ],
  },
  {
    tools: [
      { kind: "rippleEdit", label: "波纹编辑（拖边缘挤压后续）", key: "B" },
      { kind: "rolling", label: "滚动编辑（拖衔接点同时修两侧）", key: "R" },
      { kind: "rateStretch", label: "速度拉伸（拖边缘改速度）", key: "U" },
    ],
  },
  { tools: [{ kind: "razor", label: "剃刀工具（点片段即切开）", key: "C" }] },
  {
    tools: [
      { kind: "slip", label: "滑移工具（拖片段内部换内容）", key: "Y" },
      { kind: "slide", label: "滑移位置（拖片段调整左右邻接）", key: "Shift+Y" },
    ],
  },
  { tools: [{ kind: "pen", label: "钢笔工具", key: "P" }] },
  {
    tools: [
      { kind: "hand", label: "抓手工具（按住平移）", key: "H" },
      { kind: "zoom", label: "缩放工具（点时间线缩放）", key: "Z" },
    ],
  },
  { tools: [{ kind: "text", label: "文字工具（点片段加字幕）", key: "T" }] },
];

export function ToolBar() {
  const tool = useAppStore((s) => s.tool);
  const setTool = useAppStore((s) => s.setTool);
  const selectedCount = useAppStore((s) => s.selectedClipIds.length);
  const hasProject = useAppStore((s) => s.project !== null);
  const setPage = useAppStore((s) => s.setPage);
  const setCurveExpanded = useAppStore((s) => s.setCurveExpanded);
  /** 左侧弹出面板：文字预设 / 系统素材（剪映式放在左侧工具区，不占素材库） */
  const [popover, setPopover] = useState<null | "text" | "generators">(null);
  /** 右键打开的槽位 flyout（组内选择） */
  const [flyout, setFlyout] = useState<number | null>(null);
  /** 每个槽当前显示的工具（初始为组内第一个） */
  const [slotTools, setSlotTools] = useState<ToolKind[]>(() => SLOTS.map((s) => s.tools[0].kind));

  const pick = (si: number, kind: ToolKind) => {
    setTool(kind);
    setSlotTools((prev) => prev.map((t, i) => (i === si ? kind : t)));
    setFlyout(null);
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="工具栏">
      {SLOTS.map((slot, si) => {
        const currentKind = slotTools[si];
        const current = slot.tools.find((t) => t.kind === currentKind) ?? slot.tools[0];
        const Icon = TOOL_ICONS[current.kind];
        const active = slot.tools.some((t) => t.kind === tool);
        const multi = slot.tools.length > 1;
        return (
          <div key={si} className="tool-slot">
            <button
              type="button"
              className={`tool-btn${active ? " active" : ""}`}
              title={`${current.label}（${current.key}）${multi ? " · 右键切换同组工具" : ""}`}
              onClick={() => pick(si, current.kind)}
              onContextMenu={(e) => {
                // 右键弹组内选择（EC 参考 长按 flyout 的桌面等价物）
                e.preventDefault();
                if (multi) setFlyout(flyout === si ? null : si);
              }}
            >
              <span className="tool-icon">
                <Icon />
              </span>
              {multi && <span className="tool-slot-corner" aria-hidden="true" />}
            </button>
            {flyout === si && multi && (
              <div className="tool-flyout" onPointerDown={(e) => e.stopPropagation()}>
                {slot.tools.map((t) => {
                  const ItemIcon = TOOL_ICONS[t.kind];
                  return (
                    <button
                      key={t.kind}
                      type="button"
                      className={`tool-flyout-item${t.kind === currentKind ? " active" : ""}`}
                      onClick={() => pick(si, t.kind)}
                    >
                      <span className="tool-flyout-icon">
                        <ItemIcon />
                      </span>
                      {t.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <div className="tool-sep" />

      {/* 文字预设 / 系统素材：左侧弹出面板 */}
      <div className="tool-pop-wrap">
        <button
          type="button"
          className={`tool-btn${popover === "text" ? " active" : ""}`}
          title="文字预设（在播放头处加一条字幕，独占字幕轨）"
          onClick={() => setPopover(popover === "text" ? null : "text")}
        >
          <span className="tool-icon">
            <IconText />
          </span>
        </button>
        {popover === "text" && (
          <div className="tool-popover" onPointerDown={(e) => e.stopPropagation()}>
            <div className="tool-popover-head">文字预设</div>
            <TextTab keyword="" />
          </div>
        )}
      </div>

      <div className="tool-pop-wrap">
        <button
          type="button"
          className={`tool-btn${popover === "generators" ? " active" : ""}`}
          title="系统素材：白底 / 黑场 / 彩条 / 颜色遮罩（真生成并落到视频轨）"
          onClick={() => setPopover(popover === "generators" ? null : "generators")}
        >
          <span className="tool-icon">
            <IconPlus />
          </span>
        </button>
        {popover === "generators" && (
          <div className="tool-popover" onPointerDown={(e) => e.stopPropagation()}>
            <div className="tool-popover-head">系统素材</div>
            <GeneratorsTab keyword="" hasProject={hasProject} />
          </div>
        )}
      </div>

      <div className="tool-sep" />

      {/* 波纹落地：裁剪并删除播放头左侧 / 右侧（限制在单个素材内） */}
      <div className="tool-kf-group">
        <button
          type="button"
          className="tool-btn"
          title="裁剪并删除播放头左侧（只作用于选中素材：把入点推到播放头）"
          disabled={selectedCount === 0}
          onClick={() => {
            const s = useAppStore.getState();
            const clipId = s.selectedClipId;
            const seq = s.project?.sequences[0];
            if (!clipId || !seq) return;
            for (const track of seq.tracks) {
              const clip = track.clips.find((c) => c.id === clipId);
              if (!clip) continue;
              const at = s.playheadMs;
              if (at <= clip.startMs || at >= clip.startMs + clip.durationMs) {
                s.pushNotice("info", "播放头要落在这个素材里面");
                return;
              }
              void timelineApi
                .trimClip(clipId, clip.inMs + (at - clip.startMs) * clip.speed, clip.outMs)
                .then(() => refreshProject());
              return;
            }
          }}
        >
          <span className="tool-icon">
            <IconTrimLeft />
          </span>
        </button>
        <button
          type="button"
          className="tool-btn"
          title="裁剪并删除播放头右侧（只作用于选中素材：把出点收到播放头）"
          disabled={selectedCount === 0}
          onClick={() => {
            const s = useAppStore.getState();
            const clipId = s.selectedClipId;
            const seq = s.project?.sequences[0];
            if (!clipId || !seq) return;
            for (const track of seq.tracks) {
              const clip = track.clips.find((c) => c.id === clipId);
              if (!clip) continue;
              const at = s.playheadMs;
              if (at <= clip.startMs || at >= clip.startMs + clip.durationMs) {
                s.pushNotice("info", "播放头要落在这个素材里面");
                return;
              }
              void timelineApi
                .trimClip(clipId, clip.inMs, clip.inMs + (at - clip.startMs) * clip.speed)
                .then(() => refreshProject());
              return;
            }
          }}
        >
          <span className="tool-icon">
            <IconTrimRight />
          </span>
        </button>
        {/* 将素材移动到播放头（判断素材在播放头左还是右） */}
        <button
          type="button"
          className="tool-btn"
          title="将选中素材移动到播放头（素材在左就往右挪，在右就往左挪）"
          disabled={selectedCount === 0}
          onClick={() => {
            const s = useAppStore.getState();
            const clipId = s.selectedClipId;
            const seq = s.project?.sequences[0];
            if (!clipId || !seq) return;
            for (const track of seq.tracks) {
              const clip = track.clips.find((c) => c.id === clipId);
              if (!clip) continue;
              void timelineApi
                .moveClip(clipId, Math.max(0, s.playheadMs), track.id)
                .then(() => refreshProject());
              return;
            }
          }}
        >
          <span className="tool-icon">
            <IconMoveToPlayhead />
          </span>
        </button>
        {/* 标记（颜色分类，打在时间轴顶上） */}
        <button
          type="button"
          className="tool-btn"
          title="在播放头处添加标记（右键时间尺上的标记可删除）"
          disabled={!hasProject}
          onClick={() => {
            const s = useAppStore.getState();
            const seq = s.project?.sequences[0];
            if (seq) void addTimelineMarker(seq.id, s.playheadMs);
          }}
        >
          <span className="tool-icon">
            <IconKeyframe />
          </span>
        </button>
      </div>

      <div className="tool-sep" />
      <div className="tool-kf-group">
        <button
          type="button"
          className="tool-btn"
          title="在播放头处切换关键帧（作用于选中效果里已点亮秒表的参数）"
          disabled={selectedCount === 0}
          onClick={() => {
            const s = useAppStore.getState();
            const effectId = s.selectedEffectId;
            if (!effectId) {
              s.pushNotice("info", "先在效果栈里选中一个效果");
              return;
            }
            const animated = s.effectKeyframes.filter((k) => k.effectId === effectId);
            if (animated.length === 0) {
              s.pushNotice("info", "先在效果栈里给参数点亮秒表（菱形）");
              return;
            }
            const params = [...new Set(animated.map((k) => k.param))];
            for (const param of params) {
              s.navEffectKeyframe(effectId, param, 0);
            }
          }}
        >
          <span className="tool-icon">
            <IconKeyframe />
          </span>
        </button>
        <button
          type="button"
          className="tool-btn tool-kf-nav"
          title="上一个关键帧"
          disabled={selectedCount === 0}
          onClick={() => {
            const s = useAppStore.getState();
            const effectId = s.selectedEffectId;
            if (!effectId) return;
            const first = s.effectKeyframes.find((k) => k.effectId === effectId);
            if (first) s.navEffectKeyframe(effectId, first.param, -1);
          }}
        >
          <span className="tool-icon">
            <IconKeyPrev />
          </span>
        </button>
        <button
          type="button"
          className="tool-btn tool-kf-nav"
          title="下一个关键帧"
          disabled={selectedCount === 0}
          onClick={() => {
            const s = useAppStore.getState();
            const effectId = s.selectedEffectId;
            if (!effectId) return;
            const first = s.effectKeyframes.find((k) => k.effectId === effectId);
            if (first) s.navEffectKeyframe(effectId, first.param, 1);
          }}
        >
          <span className="tool-icon">
            <IconKeyNext />
          </span>
        </button>
      </div>

      {/* 曲线开关：就地展开选中片段的曲线行 */}
      <button
        type="button"
        className="tool-btn"
        title="显示关键帧曲线（就地长在片段下方）"
        disabled={selectedCount === 0}
        onClick={() => {
          const id = useAppStore.getState().selectedClipId;
          if (id) setCurveExpanded(id);
          setPage("edit");
        }}
      >
        <span className="tool-icon">
          <IconCurve />
        </span>
      </button>

      {/* 剃刀落地：在播放头处切割 */}
      <button
        type="button"
        className="tool-btn"
        title="在播放头处切割（Ctrl+K）"
        disabled={selectedCount === 0}
        onClick={() => void splitAtPlayhead()}
      >
        <span className="tool-icon">
          <IconCut />
        </span>
      </button>

      {/* 文字落地：给选中片段加文字图层 */}
      <button
        type="button"
        className="tool-btn"
        title="给选中片段加文字图层"
        disabled={selectedCount === 0}
        onClick={() => void addTextToSelectedClip()}
      >
        <span className="tool-icon">
          <IconPlus />
        </span>
      </button>
    </div>
  );
}
