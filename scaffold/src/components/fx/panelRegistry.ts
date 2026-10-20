/**
 * 特效页面板注册表。
 *
 * 与 EC 参考 的 `PanelKind::ALL` 一一对应：34 个面板，中文标题、窗口快捷键、
 * 默认停靠位置全部照抄 `dock.rs`。面板可以暂时没有引擎支持，但必须真实存在、
 * 打开后能看到诚实的内容——绝不放点不动的假按钮。
 */

export type FxPanelId =
  | "project"
  | "effectControls"
  | "composition"
  | "layer"
  | "timeline"
  | "info"
  | "audio"
  | "preview"
  | "effectsPresets"
  | "properties"
  | "character"
  | "paragraph"
  | "align"
  | "tracker"
  | "wiggler"
  | "smoother"
  | "motionSketch"
  | "paint"
  | "brushes"
  | "renderQueue"
  | "flowchart"
  | "history"
  | "markers"
  | "maskInterpolation"
  | "scriptConsole"
  | "essentialGraphics"
  | "lumetriScopes"
  | "footage"
  | "mediaBrowser"
  | "metadata"
  | "progress"
  | "contentAwareFill"
  | "createNullsFromPaths"
  | "vrCompEditor"
  /** Reelix 自有入口：3D 空间识别（从效果和预设面板进入，不占 34 面板名额） */
  | "spatial";

export interface FxPanelMeta {
  id: FxPanelId;
  title: string;
  /** 窗口菜单里的快捷键（Windows 习惯，Ctrl 代替 Cmd） */
  shortcut?: string;
  /** 关闭后从窗口菜单重新打开时，默认回到哪个分组 */
  home: "left" | "center" | "bottom" | "right";
}

export const FX_PANELS: FxPanelMeta[] = [
  { id: "project", title: "项目", shortcut: "Ctrl+0", home: "left" },
  { id: "effectControls", title: "效果控件", shortcut: "F3", home: "left" },
  { id: "composition", title: "合成", home: "center" },
  { id: "layer", title: "图层", home: "center" },
  { id: "timeline", title: "时间轴", home: "bottom" },
  { id: "info", title: "信息", shortcut: "Ctrl+2", home: "center" },
  { id: "audio", title: "音频", shortcut: "Ctrl+4", home: "right" },
  { id: "preview", title: "预览", shortcut: "Ctrl+3", home: "right" },
  { id: "effectsPresets", title: "效果和预设", shortcut: "Ctrl+5", home: "right" },
  { id: "properties", title: "属性", home: "right" },
  { id: "character", title: "字符", shortcut: "Ctrl+6", home: "center" },
  { id: "paragraph", title: "段落", shortcut: "Ctrl+7", home: "center" },
  { id: "align", title: "对齐", home: "right" },
  { id: "tracker", title: "跟踪器", home: "center" },
  { id: "wiggler", title: "摇摆器", home: "center" },
  { id: "smoother", title: "平滑器", home: "center" },
  { id: "motionSketch", title: "运动素描", home: "center" },
  { id: "paint", title: "绘画", shortcut: "Ctrl+8", home: "center" },
  { id: "brushes", title: "画笔", shortcut: "Ctrl+9", home: "center" },
  { id: "renderQueue", title: "渲染队列", shortcut: "Ctrl+Alt+0", home: "bottom" },
  { id: "flowchart", title: "流程图", home: "center" },
  { id: "history", title: "历史记录", home: "center" },
  { id: "markers", title: "标记", home: "center" },
  { id: "maskInterpolation", title: "蒙版插值", home: "center" },
  { id: "scriptConsole", title: "脚本控制台", home: "center" },
  { id: "essentialGraphics", title: "基本图形", home: "center" },
  { id: "lumetriScopes", title: "示波器", home: "center" },
  { id: "footage", title: "素材", home: "left" },
  { id: "mediaBrowser", title: "媒体浏览器", home: "left" },
  { id: "metadata", title: "元数据", home: "center" },
  { id: "progress", title: "进度", home: "center" },
  { id: "contentAwareFill", title: "内容识别填充", home: "center" },
  { id: "createNullsFromPaths", title: "从路径创建空对象", home: "center" },
  { id: "vrCompEditor", title: "VR 合成编辑器", home: "center" },
  { id: "spatial", title: "3D 空间识别", home: "center" },
];

const BY_ID = new Map(FX_PANELS.map((p) => [p.id, p]));

export function panelMeta(id: FxPanelId): FxPanelMeta {
  return BY_ID.get(id) ?? { id, title: id, home: "center" };
}

/** 窗口菜单里的 34 个面板（不含 Reelix 自有的空间识别） */
export const AE_PANEL_IDS: FxPanelId[] = FX_PANELS.filter((p) => p.id !== "spatial").map(
  (p) => p.id
);

// ---------------------------------------------------------------------------
// 停靠树：与 EC 参考 `workspace("Default")` 完全一致
//   hsplit(FixedB 300,
//     vsplit(0.56,
//       hsplit(FixedA 300, tabs[项目|效果控件], tabs[合成|图层]),
//       tabs[时间轴|渲染队列]),
//     stack[预览(46%) / 属性 / 对齐(折叠) / 音频(折叠) / 效果和预设(折叠)])
// ---------------------------------------------------------------------------

export type SplitSize =
  | { type: "ratio"; value: number }
  | { type: "fixedA"; px: number }
  | { type: "fixedB"; px: number };

export interface DockSplit {
  kind: "split";
  vertical: boolean;
  size: SplitSize;
  a: DockNode;
  b: DockNode;
}

export interface DockTabs {
  kind: "tabs";
  panels: FxPanelId[];
  active: number;
}

export interface StackEntry {
  panels: FxPanelId[];
  active: number;
  open: boolean;
  /** 展开后的高度百分比（0-100）；null = 平分剩余空间 */
  height: number | null;
}

export interface DockStack {
  kind: "stack";
  entries: StackEntry[];
}

export type DockNode = DockSplit | DockTabs | DockStack;

export function defaultDock(): DockNode {
  // 用户指定的布局（AE 式）：
  // - **右列属性栈从顶贯穿到底**（预览 + 属性 + 对齐/音频/效果预设）
  // - 左侧「该加就加，默认没有」：默认只留合成窗口，项目面板需要时再从菜单加
  // - 时间轴在左+中区域的下方
  return {
    kind: "split",
    vertical: false,
    size: { type: "fixedB", px: 320 },
    a: {
      kind: "split",
      vertical: true,
      size: { type: "ratio", value: 0.58 },
      a: { kind: "tabs", panels: ["composition", "layer"], active: 0 },
      b: { kind: "tabs", panels: ["timeline", "renderQueue"], active: 0 },
    },
    b: {
      kind: "stack",
      entries: [
        { panels: ["preview"], active: 0, open: true, height: 40 },
        { panels: ["properties"], active: 0, open: true, height: null },
        { panels: ["align"], active: 0, open: false, height: null },
        { panels: ["audio"], active: 0, open: false, height: null },
        { panels: ["effectsPresets"], active: 0, open: false, height: null },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// 15 个工作区，逐字对照 EC 参考 `WORKSPACES` / `workspace(name)`
// ---------------------------------------------------------------------------

export const WORKSPACE_NAMES = [
  "Default",
  "Standard",
  "Small Screen",
  "Animation",
  "Effects",
  "Motion Tracking",
  "Paint",
  "Text",
  "Minimal",
  "All Panels",
  "Review",
  "Learn",
  "Essential Graphics",
  "Color",
  "Undocked Panels",
] as const;

export type WorkspaceName = (typeof WORKSPACE_NAMES)[number];

const tabs = (panels: FxPanelId[], active = 0): DockTabs => ({ kind: "tabs", panels, active });
const hsplit = (size: SplitSize, a: DockNode, b: DockNode): DockSplit => ({
  kind: "split",
  vertical: false,
  size,
  a,
  b,
});
const vsplit = (size: SplitSize, a: DockNode, b: DockNode): DockSplit => ({
  kind: "split",
  vertical: true,
  size,
  a,
  b,
});
const stack = (entries: Array<[FxPanelId, boolean, number | null]>): DockStack => ({
  kind: "stack",
  entries: entries.map(([id, open, height]) => ({
    panels: [id],
    active: 0,
    open,
    height,
  })),
});
/** EC 参考 的 right()：竖分 0.45，上下两组页签 */
const right = (p: FxPanelId[], q: FxPanelId[]): DockSplit =>
  vsplit({ type: "ratio", value: 0.45 }, tabs(p), tabs(q));

export function workspace(name: WorkspaceName): DockNode {
  switch (name) {
    case "Animation":
      return vsplit(
        { type: "ratio", value: 0.55 },
        hsplit(
          { type: "fixedA", px: 300 },
          tabs(["project", "effectControls"], 1),
          hsplit(
            { type: "fixedB", px: 300 },
            tabs(["composition", "layer"]),
            right(
              ["info", "preview", "audio"],
              ["effectsPresets", "smoother", "wiggler", "motionSketch"]
            )
          )
        ),
        tabs(["timeline", "renderQueue"])
      );
    case "Effects":
      return vsplit(
        { type: "ratio", value: 0.58 },
        hsplit(
          { type: "fixedA", px: 340 },
          tabs(["effectControls", "project"]),
          hsplit(
            { type: "fixedB", px: 300 },
            tabs(["composition", "layer"]),
            right(["info", "preview"], ["effectsPresets"])
          )
        ),
        tabs(["timeline", "renderQueue"])
      );
    case "Motion Tracking":
      return vsplit(
        { type: "ratio", value: 0.6 },
        hsplit(
          { type: "fixedA", px: 300 },
          tabs(["project", "effectControls"]),
          hsplit(
            { type: "fixedB", px: 300 },
            tabs(["layer", "composition"]),
            right(["info", "preview"], ["tracker"])
          )
        ),
        tabs(["timeline"])
      );
    case "Paint":
      return vsplit(
        { type: "ratio", value: 0.6 },
        hsplit(
          { type: "fixedA", px: 300 },
          tabs(["project", "effectControls"]),
          hsplit(
            { type: "fixedB", px: 300 },
            tabs(["layer", "composition"]),
            right(["paint", "info"], ["brushes", "preview"])
          )
        ),
        tabs(["timeline"])
      );
    case "Text":
      return vsplit(
        { type: "ratio", value: 0.58 },
        hsplit(
          { type: "fixedA", px: 300 },
          tabs(["project", "effectControls"]),
          hsplit(
            { type: "fixedB", px: 300 },
            tabs(["composition"]),
            right(["character", "paragraph"], ["align", "preview", "effectsPresets"])
          )
        ),
        tabs(["timeline"])
      );
    case "Minimal":
      return vsplit(
        { type: "ratio", value: 0.6 },
        tabs(["composition"]),
        tabs(["timeline"])
      );
    case "Review":
      return vsplit(
        { type: "ratio", value: 0.66 },
        hsplit(
          { type: "fixedA", px: 280 },
          tabs(["project", "markers"]),
          hsplit(
            { type: "fixedB", px: 260 },
            tabs(["composition", "layer"]),
            right(["preview", "info"], ["audio"])
          )
        ),
        tabs(["timeline", "renderQueue"])
      );
    case "Essential Graphics":
      return hsplit(
        { type: "fixedB", px: 320 },
        vsplit(
          { type: "ratio", value: 0.58 },
          hsplit(
            { type: "fixedA", px: 280 },
            tabs(["project", "effectControls"]),
            hsplit(
              { type: "fixedB", px: 260 },
              tabs(["composition", "layer"]),
              right(["character", "paragraph"], ["align", "preview"])
            )
          ),
          tabs(["timeline"])
        ),
        stack([
          ["properties", true, null],
          ["effectsPresets", false, null],
        ])
      );
    case "Color":
      return vsplit(
        { type: "ratio", value: 0.6 },
        hsplit(
          { type: "fixedA", px: 360 },
          tabs(["effectControls", "project"]),
          hsplit(
            { type: "fixedB", px: 340 },
            tabs(["composition", "layer"]),
            right(["lumetriScopes", "info", "preview"], ["effectsPresets"])
          )
        ),
        tabs(["timeline"])
      );
    case "Undocked Panels":
      // 浮动组由工作区的 floating 层承载，根只留合成页签
      return tabs(["composition", "layer", "flowchart"]);
    case "Small Screen":
      return vsplit(
        { type: "ratio", value: 0.55 },
        hsplit(
          { type: "fixedA", px: 240 },
          tabs(["project", "effectControls"]),
          hsplit(
            { type: "fixedB", px: 240 },
            tabs(["composition"]),
            tabs(["info", "preview", "effectsPresets"], 1)
          )
        ),
        tabs(["timeline"])
      );
    case "All Panels":
      return vsplit(
        { type: "ratio", value: 0.55 },
        hsplit(
          { type: "fixedA", px: 300 },
          tabs(["project", "effectControls", "flowchart", "history", "mediaBrowser", "metadata"]),
          hsplit(
            { type: "fixedB", px: 300 },
            tabs(["composition", "layer", "footage"]),
            right(
              ["info", "preview", "audio", "align", "character", "paragraph", "lumetriScopes"],
              [
                "effectsPresets",
                "properties",
                "tracker",
                "wiggler",
                "smoother",
                "motionSketch",
                "paint",
                "brushes",
                "markers",
                "contentAwareFill",
                "createNullsFromPaths",
                "vrCompEditor",
              ]
            )
          )
        ),
        tabs(["timeline", "renderQueue", "progress"])
      );
    case "Standard":
      return vsplit(
        { type: "ratio", value: 0.56 },
        hsplit(
          { type: "fixedA", px: 300 },
          tabs(["project", "effectControls"]),
          hsplit(
            { type: "fixedB", px: 290 },
            tabs(["composition", "layer"]),
            right(["info", "audio"], ["preview", "effectsPresets"])
          )
        ),
        tabs(["timeline", "renderQueue"])
      );
    case "Learn":
    case "Default":
    default:
      return defaultDock();
  }
}

/** 树里所有面板 */
export function dockPanels(node: DockNode, out: FxPanelId[] = []): FxPanelId[] {
  if (node.kind === "split") {
    dockPanels(node.a, out);
    dockPanels(node.b, out);
  } else if (node.kind === "tabs") {
    out.push(...node.panels);
  } else {
    for (const entry of node.entries) out.push(...entry.panels);
  }
  return out;
}

/** 找面板所在的页签组 / Stack 项路径 */
export function findPanel(
  node: DockNode,
  id: FxPanelId,
  path: number[] = []
): { path: number[]; node: DockTabs | DockStack; entry?: number } | null {
  if (node.kind === "split") {
    return findPanel(node.a, id, [...path, 0]) ?? findPanel(node.b, id, [...path, 1]);
  }
  if (node.kind === "tabs") {
    return node.panels.includes(id) ? { path, node } : null;
  }
  const entry = node.entries.findIndex((e) => e.panels.includes(id));
  return entry >= 0 ? { path, node, entry } : null;
}
