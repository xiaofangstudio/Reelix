/**
 * 特效页外壳（1:1 EC 参考 的骨架）：
 *
 *   ┌ 顶栏：工具按钮排（选择/手/缩放/旋转/摄像机/文字/钢笔/形状）+ 工作区切换器 ┐
 *   ├ 停靠工作区（FxWorkspace：34 面板 / 15 工作区，照 dock.rs）              ┤
 *   └ 状态栏：8bpc · 缩放 · 时间码 · 渲染耗时                                 ┘
 *
 * EC 参考 没有左侧竖排工具条——工具在菜单下的一横排。这里照做。
 */

import { useState } from "react";
import { useAppStore } from "../../store/appStore";
import { FxWorkspace } from "./FxWorkspace";
import type { WorkspaceName } from "./panelRegistry";
import {
  IconSelectForward,
  IconHand,
  IconZoom,
  IconRotate,
  IconCamera,
  IconText,
  IconPen,
  IconShape,
} from "../icons";
import { msToTimecode } from "../../core/timecode";

/** 特效页工具（EC 参考 顶栏那一排；每个都接真实行为） */
/**
 * 特效页顶栏工具。
 * 前三个（选择/手/缩放）有真实行为；旋转/摄像机/形状/钢笔/文字
 * **暂未接入**——置灰并标注，不做成点了只有高亮的假按钮（零假功能铁律）。
 */
const FX_TOOLS: Array<{
  icon: () => JSX.Element;
  label: string;
  ready: boolean;
}> = [
  { icon: IconSelectForward, label: "选择工具（V）", ready: true },
  { icon: IconHand, label: "手形工具（H）：拖动平移时间轴", ready: true },
  { icon: IconZoom, label: "缩放工具（Z）：点时间轴放大", ready: true },
  { icon: IconRotate, label: "旋转工具（W）· 待接入", ready: false },
  { icon: IconCamera, label: "统一摄像机工具（C）· 待接入", ready: false },
  { icon: IconShape, label: "形状工具（Q）· 待接入", ready: false },
  { icon: IconPen, label: "钢笔工具（G）· 待接入", ready: false },
  { icon: IconText, label: "文字工具（Ctrl+T）· 待接入", ready: false },
];

/** 顶栏只展示 5 个主工作区（EC 参考 也是这一排） */
const QUICK_WORKSPACES: WorkspaceName[] = ["Default", "Review", "Learn", "Small Screen"];

export function FxShell() {
  const applyFxWorkspace = useAppStore((s) => s.applyFxWorkspace);
  const request = useAppStore((s) => s.fxWorkspaceRequest);
  const [activeWs, setActiveWs] = useState<WorkspaceName>("Default");
  const [tool, setTool] = useState(0);
  const sequence = useAppStore((s) => s.project?.sequences[0] ?? null);
  const playheadMs = useAppStore((s) => s.playheadMs);
  const zoomLevel = useAppStore((s) => s.zoomLevel);

  const frameRate = sequence?.frameRate || 25;

  return (
    <>
      {/* 顶栏：工具排 + 工作区切换器（EC 参考 的位置） */}
      <div className="fx-topbar">
        {FX_TOOLS.map((t, i) => {
          const Icon = t.icon;
          return (
            <button
              key={t.label}
              type="button"
              className={`fx-tool${tool === i ? " active" : ""}`}
              title={t.label}
              disabled={!t.ready}
              onClick={() => {
                setTool(i);
                // 选择/手/缩放三个工具真驱动画布：手与缩放落到时间轴的鼠标行为上
                if (t.label.startsWith("手形")) {
                  useAppStore.getState().setFxCanvasTool("hand");
                } else if (t.label.startsWith("缩放")) {
                  useAppStore.getState().setFxCanvasTool("zoom");
                } else if (t.label.startsWith("选择")) {
                  useAppStore.getState().setFxCanvasTool("selection");
                }
              }}
            >
              <Icon />
            </button>
          );
        })}
        <div className="fx-topbar-sep" />
        <button
          type="button"
          className="fx-tool"
          title="缩放适配：把时间线缩放到整段可见"
          onClick={() => useAppStore.getState().setZoomLevel(0.01)}
        >
          <IconZoom />
        </button>
        <div className="fx-topbar-spacer" />
        <div className="fx-workspaces">
          {QUICK_WORKSPACES.map((name) => (
            <button
              key={name}
              type="button"
              className={`fx-ws${activeWs === name ? " active" : ""}`}
              title={`切换到「${name}」工作区`}
              onClick={() => {
                setActiveWs(name);
                applyFxWorkspace(name);
              }}
            >
              {name === "Default" ? "默认" : name === "Review" ? "审阅" : name === "Learn" ? "学习" : "小屏幕"}
            </button>
          ))}
        </div>
      </div>

      {/* 停靠工作区：34 面板 + 15 工作区，全真数据 */}
      <div className="fxw-root" key={request?.seq ?? 0}>
        <FxWorkspace />
      </div>

      {/* 状态栏（EC 参考 底部信息条） */}
      <div className="fx-statusbar">
        <span>8bpc</span>
        <span>·</span>
        <span>缩放 {Math.round(zoomLevel * 1000) / 10}%</span>
        <span>·</span>
        <span>{msToTimecode(playheadMs, frameRate)}</span>
        <span className="push-right">
          {sequence ? `${sequence.width}×${sequence.height} · ${frameRate} fps` : "未打开序列"}
        </span>
      </div>
    </>
  );
}
