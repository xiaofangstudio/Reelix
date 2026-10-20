/**
 * 工具条图标（内联 SVG，16×16 网格，stroke=currentColor 跟随主题色）。
 * 既不是 emoji 也不是文字单字——纯图形，任何主题下都清晰。
 */

import type { JSX } from "react";

/** 描边类图标的公共属性 */
const S = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** 轨道向前选择：右向实心箭头 */
export function IconSelectForward(): JSX.Element {
  return (
    <svg {...S} fill="currentColor" stroke="none">
      <path d="M3.5 2.5 L13 8 L3.5 13.5 Z" />
    </svg>
  );
}

/** 轨道向后选择：左向实心箭头 */
export function IconSelectBackward(): JSX.Element {
  return (
    <svg {...S} fill="currentColor" stroke="none">
      <path d="M12.5 2.5 L3 8 L12.5 13.5 Z" />
    </svg>
  );
}

/** 波纹编辑：波浪线 */
export function IconRipple(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M1.5 5 Q4 2 6.5 5 T11.5 5 T14.5 5" />
      <path d="M1.5 11 Q4 8 6.5 11 T11.5 11 T14.5 11" />
    </svg>
  );
}

/** 剃刀：剪刀 */
export function IconRazor(): JSX.Element {
  return (
    <svg {...S}>
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M5.2 11.2 L13 2.5 M10.8 11.2 L3 2.5" />
    </svg>
  );
}

/** 错动：双向横箭头 */
export function IconSlip(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M2 8 H14 M11 5 L14 8 L11 11 M5 5 L2 8 L5 11" />
    </svg>
  );
}

/** 钢笔：笔尖 */
export function IconPen(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M8 1.5 L13.5 7 L7 13.5 L2.5 9 Z" />
      <path d="M8 1.5 L13.5 7" />
      <path d="M7 13.5 L2.5 9 L5.5 11.5 L7 13.5 Z" />
    </svg>
  );
}

/** 抓手：手掌 */
export function IconHand(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M5.5 7.5 V3.5 a1 1 0 0 1 2 0 V7 M7.5 7 V2.5 a1 1 0 0 1 2 0 V7 M9.5 7 V3.5 a1 1 0 0 1 2 0 V10 c0 2 -1.5 3.5 -3.5 3.5 c-1.5 0 -2.5 -0.8 -3 -2 L3.5 9 c-0.4 -0.8 0.4 -1.8 1.2 -1.4 L5.5 8" />
    </svg>
  );
}

/** 文字：T */
export function IconText(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M3 3.5 H13 M8 3.5 V13" />
    </svg>
  );
}

/** 曲线：折线 */
export function IconCurve(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M1.5 13 L5.5 8 L9 10.5 L14 3.5" />
      <circle cx="5.5" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="9" cy="10.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 切割：竖线 */
export function IconCut(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M8 1.5 V14.5" />
      <path d="M3.5 4 L3.5 12 M12.5 4 L12.5 12" opacity="0.45" />
    </svg>
  );
}

/** 新增：加号 */
export function IconPlus(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M8 3 V13 M3 8 H13" />
    </svg>
  );
}

/** 播放：实心三角 */
export function IconPlay(): JSX.Element {
  return (
    <svg {...S} fill="currentColor" stroke="none">
      <path d="M4.5 2.5 L13 8 L4.5 13.5 Z" />
    </svg>
  );
}

/** 暂停：双竖条 */
export function IconPause(): JSX.Element {
  return (
    <svg {...S} fill="currentColor" stroke="none">
      <rect x="4" y="2.5" width="3" height="11" rx="0.6" />
      <rect x="9" y="2.5" width="3" height="11" rx="0.6" />
    </svg>
  );
}

/** 上一帧：竖线 + 左箭头 */
export function IconPrevFrame(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M4 2.5 V13.5" />
      <path d="M12.5 3.5 L6 8 L12.5 12.5 Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 下一帧：右箭头 + 竖线 */
export function IconNextFrame(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M12 2.5 V13.5" />
      <path d="M3.5 3.5 L10 8 L3.5 12.5 Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 跳到开头：左箭头 + 竖线（双三角） */
export function IconToStart(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M3 2.5 V13.5" />
      <path d="M13 3.5 L6.5 8 L13 12.5 Z" fill="currentColor" stroke="none" />
      <path d="M8.5 3.5 L2 8 L8.5 12.5 Z" fill="currentColor" stroke="none" opacity="0.5" />
    </svg>
  );
}

/** 跳到结尾：双三角 + 竖线 */
export function IconToEnd(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M13 2.5 V13.5" />
      <path d="M3 3.5 L9.5 8 L3 12.5 Z" fill="currentColor" stroke="none" />
      <path d="M7.5 3.5 L14 8 L7.5 12.5 Z" fill="currentColor" stroke="none" opacity="0.5" />
    </svg>
  );
}

/** 缩放：放大镜 */
export function IconZoom(): JSX.Element {
  return (
    <svg {...S}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 L14 14" />
    </svg>
  );
}

/** 旋转：圆弧箭头 */
export function IconRotate(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M13 8 A5 5 0 1 1 8 3" />
      <path d="M8 1 L8 5 L12 5" />
    </svg>
  );
}

/** 摄像机：机身 + 镜头 */
export function IconCamera(): JSX.Element {
  return (
    <svg {...S}>
      <rect x="1.5" y="5" width="8" height="6" rx="1" />
      <path d="M9.5 7.5 L14 5 V11 L9.5 8.5 Z" />
    </svg>
  );
}

/** 形状：方形 */
export function IconShape(): JSX.Element {
  return (
    <svg {...S}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    </svg>
  );
}

/** 月亮（切深色） */
export function IconMoon(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M13 9.5 A5.6 5.6 0 0 1 6.5 3 A5.8 5.8 0 1 0 13 9.5 Z" />
    </svg>
  );
}

/** 太阳（切浅色） */
export function IconSun(): JSX.Element {
  return (
    <svg {...S}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5 V3 M8 13 V14.5 M1.5 8 H3 M13 8 H14.5 M3.4 3.4 L4.5 4.5 M11.5 11.5 L12.6 12.6 M12.6 3.4 L11.5 4.5 M4.5 11.5 L3.4 12.6" />
    </svg>
  );
}

/** 眼睛（图层显示开关） */
export function IconEye(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M1.5 8 C3 4.8 5.3 3.5 8 3.5 C10.7 3.5 13 4.8 14.5 8 C13 11.2 10.7 12.5 8 12.5 C5.3 12.5 3 11.2 1.5 8 Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

/** 喇叭（音频静音开关） */
export function IconSpeaker(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M3 6.5 H5.5 L9 3.5 V12.5 L5.5 9.5 H3 Z" />
      <path d="M11.5 5.5 Q13 8 11.5 10.5" />
    </svg>
  );
}

/** 圆环（独奏） */
export function IconSolo(): JSX.Element {
  return (
    <svg {...S}>
      <circle cx="8" cy="8" r="5" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 锁（锁定图层） */
export function IconLock(): JSX.Element {
  return (
    <svg {...S}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7 V5 a2.5 2.5 0 0 1 5 0 V7" />
    </svg>
  );
}

/** 速度拉伸：左右箭头 + 速度弧 */
export function IconRateStretch(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M2 8 H6 M10 8 H14" />
      <path d="M5 5 L2 8 L5 11 M11 5 L14 8 L11 11" />
      <path d="M6.5 12 Q8 6 9.5 12" opacity="0.7" />
    </svg>
  );
}

/** 滑移位置：片段框 + 左右外箭头 */
export function IconSlide(): JSX.Element {
  return (
    <svg {...S}>
      <rect x="5.5" y="4.5" width="5" height="7" rx="0.8" />
      <path d="M3.5 8 L1.5 8 M2 6.5 L0.5 8 L2 9.5 M12.5 8 L14.5 8 M14 6.5 L15.5 8 L14 9.5" />
    </svg>
  );
}

/** 选择：箭头光标 */
export function IconSelection(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M3 2 L3 13 L6.5 9.8 L9 14 L11 13 L8.6 8.8 L13 8.8 Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 关键帧菱形（AE 风格：秒表点亮后参数行显示的关键帧图标） */
export function IconKeyframe(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M8 1.5 L14.5 8 L8 14.5 L1.5 8 Z" />
    </svg>
  );
}

/** 关键帧导航：上一个 */
export function IconKeyPrev(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M8 1.5 L14.5 8 L8 14.5 L1.5 8 Z" fill="currentColor" stroke="none" />
      <path d="M3 2 V14" />
    </svg>
  );
}

/** 关键帧导航：下一个 */
export function IconKeyNext(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M8 1.5 L14.5 8 L8 14.5 L1.5 8 Z" fill="currentColor" stroke="none" />
      <path d="M13 2 V14" />
    </svg>
  );
}

/** 工具区页签图标（素材区竖排纯 icon，无文字） */

/** 素材：胶片 */
export function IconTabMedia(): JSX.Element {
  return (
    <svg {...S}>
      <rect x="1.5" y="3.5" width="13" height="9" rx="1" />
      <path d="M5 3.5 V12.5 M10 3.5 V12.5" />
    </svg>
  );
}

/** 音频：音符 */
export function IconTabAudio(): JSX.Element {
  return (
    <svg {...S}>
      <circle cx="5" cy="11.5" r="2" />
      <path d="M7 11.5 V3 L12 4.5 V10" />
      <circle cx="10" cy="10" r="1.6" />
    </svg>
  );
}

/** 文字：T */
export function IconTabText(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M3 3.5 H13 M8 3.5 V12.5" />
    </svg>
  );
}

/** 默认素材：方块 */
export function IconTabSolid(): JSX.Element {
  return (
    <svg {...S}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    </svg>
  );
}

/** 默认音频：喇叭 */
export function IconTabSound(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M2.5 6 H5 L9 3 V13 L5 10 H2.5 Z" />
      <path d="M11.5 5.5 Q13 8 11.5 10.5" />
    </svg>
  );
}

/** 贴纸：星 */
export function IconTabSticker(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M8 1.5 L10 6 L14.5 6.5 L11 10 L12 14.5 L8 12 L4 14.5 L5 10 L1.5 6.5 L6 6 Z" />
    </svg>
  );
}

/** 画中画：方框套方框 */
export function IconTabPip(): JSX.Element {
  return (
    <svg {...S}>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1" />
      <rect x="6" y="7" width="7" height="5.5" rx="0.8" />
    </svg>
  );
}

/** 摄像机：相机 */
export function IconTabCamera(): JSX.Element {
  return (
    <svg {...S}>
      <rect x="1.5" y="5" width="8" height="6" rx="1" />
      <path d="M9.5 7.5 L14 5 V11 L9.5 8.5 Z" />
    </svg>
  );
}

/** 特效：魔法棒 */
export function IconTabFx(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M3 13 L10 6" />
      <path d="M10 2 L11 5 L14 6 L11 7 L10 10 L9 7 L6 6 L9 5 Z" />
    </svg>
  );
}

/** 全局属性：齿轮 */
export function IconTabGlobal(): JSX.Element {
  return (
    <svg {...S}>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.5 V3 M8 13 V14.5 M1.5 8 H3 M13 8 H14.5 M3.4 3.4 L4.5 4.5 M11.5 11.5 L12.6 12.6 M12.6 3.4 L11.5 4.5 M4.5 11.5 L3.4 12.6" />
    </svg>
  );
}

/** 粒子：点阵 */
export function IconTabParticles(): JSX.Element {
  return (
    <svg {...S}>
      <circle cx="4" cy="4" r="1.2" />
      <circle cx="11" cy="3.5" r="1.6" />
      <circle cx="7" cy="8" r="2" />
      <circle cx="12.5" cy="10" r="1.2" />
      <circle cx="4" cy="12" r="1.6" />
    </svg>
  );
}

/** 页签图标：导入（素材） */
export function IconPageMedia(): JSX.Element {
  return (
    <svg {...S}>
      <rect x="1.5" y="3.5" width="13" height="9" rx="1" />
      <path d="M5 3.5 V12.5 M10 3.5 V12.5" />
    </svg>
  );
}

/** 页签图标：剪辑 */
export function IconPageEdit(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M2 4 H14 M2 8 H10 M2 12 H12" />
    </svg>
  );
}

/** 页签图标：特效 */
export function IconPageFx(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M3 13 L10 6" />
      <path d="M10 2 L11 5 L14 6 L11 7 L10 10 L9 7 L6 6 L9 5 Z" />
    </svg>
  );
}

/** 页签图标：导出 */
export function IconPageDeliver(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M8 1.5 V9 M5 6.5 L8 9.5 L11 6.5" />
      <path d="M2.5 11 V13.5 H13.5 V11" />
    </svg>
  );
}


/** 裁剪删除左侧：左箭头 + 竖线 */
export function IconTrimLeft(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M4 2.5 V13.5" />
      <path d="M13 4 L7 8 L13 12 Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 裁剪删除右侧：竖线 + 右箭头 */
export function IconTrimRight(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M12 2.5 V13.5" />
      <path d="M3 4 L9 8 L3 12 Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 移动到播放头：竖线 + 双向箭头 */
export function IconMoveToPlayhead(): JSX.Element {
  return (
    <svg {...S}>
      <path d="M8 2.5 V13.5" />
      <path d="M3 5 L1 8 L3 11 M13 5 L15 8 L13 11" />
    </svg>
  );
}

/** 工具种类 → 图标组件（覆盖全部 ToolKind） */
export const TOOL_ICONS: Record<string, () => JSX.Element> = {
  selection: IconSelection,
  trackSelectForward: IconSelectForward,
  trackSelectBackward: IconSelectBackward,
  rippleEdit: IconRipple,
  rolling: IconRipple,
  rateStretch: IconRateStretch,
  razor: IconRazor,
  slip: IconSlip,
  slide: IconSlide,
  pen: IconPen,
  hand: IconHand,
  zoom: IconZoom,
  text: IconText,
  curve: IconCurve,
  cut: IconCut,
  plus: IconPlus,
};
