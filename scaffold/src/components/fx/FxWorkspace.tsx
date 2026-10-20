/**
 * 特效工作区：EC 参考 的停靠树。
 *
 * 结构与 `reference/.../crates/ui-egui/src/dock.rs` 一一对应：
 * - Split：左右 / 上下分栏，分隔条可拖，尺寸支持 fixedA / fixedB / ratio；
 * - Tabs：一组页签，点击切换、中键或 × 关闭、拖拽重排 / 跨组停靠；
 * - Stack：右列可折叠的纵向面板栈，拖项间缝隙改上下高度。
 *
 * 所有操作都落在同一棵树上，没有第二份布局状态。面板本身在 `FxPanels.tsx`，
 * 这里只负责「面板放哪儿、怎么摆」。
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, DragEvent as ReactDragEvent } from "react";
import { useAppStore } from "../../store/appStore";
import {
  WORKSPACE_NAMES,
  defaultDock,
  dockPanels,
  findPanel,
  panelMeta,
  workspace,
} from "./panelRegistry";
import type {
  DockNode,
  DockSplit,
  DockStack,
  DockTabs,
  FxPanelId,
  WorkspaceName,
} from "./panelRegistry";
import { FxPanelBody } from "./FxPanels";

// ---------------------------------------------------------------------------
// 纯函数：树操作
// ---------------------------------------------------------------------------

function replaceAt(node: DockNode, path: number[], next: DockNode): DockNode {
  if (path.length === 0) return next;
  if (node.kind !== "split") return node;
  const [head, ...rest] = path;
  return head === 0
    ? { ...node, a: replaceAt(node.a, rest, next) }
    : { ...node, b: replaceAt(node.b, rest, next) };
}

/** 激活某个面板：页签组换 active，Stack 项展开并换 active。 */
function activatePanel(node: DockNode, id: FxPanelId): DockNode {
  if (node.kind === "split") {
    if (findPanel(node.a, id)) return { ...node, a: activatePanel(node.a, id) };
    if (findPanel(node.b, id)) return { ...node, b: activatePanel(node.b, id) };
    return node;
  }
  if (node.kind === "tabs") {
    const index = node.panels.indexOf(id);
    return index >= 0 ? { ...node, active: index } : node;
  }
  const index = node.entries.findIndex((entry) => entry.panels.includes(id));
  if (index < 0) return node;
  const entries = node.entries.map((entry, i) =>
    i === index
      ? { ...entry, open: true, active: Math.max(0, entry.panels.indexOf(id)) }
      : entry
  );
  return { ...node, entries };
}

/** 移除面板；节点空了返回 null，交给上层用兄弟节点顶替。 */
function removePanel(node: DockNode, id: FxPanelId): DockNode | null {
  if (node.kind === "split") {
    const a = removePanel(node.a, id);
    const b = removePanel(node.b, id);
    if (a === null) return b;
    if (b === null) return a;
    return a === node.a && b === node.b ? node : { ...node, a, b };
  }
  if (node.kind === "tabs") {
    if (!node.panels.includes(id)) return node;
    const panels = node.panels.filter((panel) => panel !== id);
    if (panels.length === 0) return null;
    return { ...node, panels, active: Math.min(node.active, panels.length - 1) };
  }
  const index = node.entries.findIndex((entry) => entry.panels.includes(id));
  if (index < 0) return node;
  const entries = node.entries
    .map((entry, i) =>
      i === index
        ? { ...entry, panels: entry.panels.filter((panel) => panel !== id) }
        : entry
    )
    .filter((entry) => entry.panels.length > 0)
    .map((entry) => ({ ...entry, active: Math.min(entry.active, entry.panels.length - 1) }));
  if (entries.length === 0) return null;
  return { ...node, entries };
}

type AnchorPredicate = (node: DockTabs | DockStack) => boolean;

function tryInsert(node: DockNode, predicate: AnchorPredicate, id: FxPanelId): DockNode | null {
  if (node.kind === "split") {
    const a = tryInsert(node.a, predicate, id);
    if (a) return { ...node, a };
    const b = tryInsert(node.b, predicate, id);
    if (b) return { ...node, b };
    return null;
  }
  if (!predicate(node)) return null;
  if (node.kind === "tabs") {
    return { ...node, panels: [...node.panels, id], active: node.panels.length };
  }
  return {
    ...node,
    entries: [...node.entries, { panels: [id], active: 0, open: true, height: null }],
  };
}

const HOME_ANCHORS: Record<string, AnchorPredicate> = {
  left: (node) =>
    node.kind === "tabs" &&
    (node.panels.includes("project") || node.panels.includes("effectControls")),
  center: (node) =>
    node.kind === "tabs" &&
    (node.panels.includes("composition") || node.panels.includes("layer")),
  bottom: (node) =>
    node.kind === "tabs" &&
    (node.panels.includes("timeline") || node.panels.includes("renderQueue")),
  right: (node) =>
    node.kind === "stack" &&
    node.entries.some((entry) =>
      entry.panels.some(
        (panel) => panel === "preview" || panel === "properties" || panel === "effectsPresets"
      )
    ),
};

/** 面板关闭后从「窗口」菜单再打开：按 home 放回对应分组，找不到就退到同类分组。 */
function insertIntoHome(tree: DockNode, id: FxPanelId, home: string): DockNode {
  const anchored = tryInsert(tree, HOME_ANCHORS[home] ?? (() => false), id);
  if (anchored) return anchored;
  const fallback = tryInsert(tree, home === "right" ? (n) => n.kind === "stack" : (n) => n.kind === "tabs", id);
  if (fallback) return fallback;
  return {
    kind: "split",
    vertical: true,
    size: { type: "ratio", value: 0.6 },
    a: tree,
    b: { kind: "tabs", panels: [id], active: 0 },
  };
}

function ensurePanel(tree: DockNode, id: FxPanelId): DockNode {
  if (findPanel(tree, id)) return activatePanel(tree, id);
  return insertIntoHome(tree, id, panelMeta(id).home);
}

/** 把面板搬进目标页签组；anchor 为目标组里的任意一个面板。 */
function movePanel(
  tree: DockNode,
  id: FxPanelId,
  anchor: FxPanelId | null,
  index: number
): DockNode {
  const stripped = removePanel(tree, id);
  if (stripped === null) return tree;
  if (anchor === null) {
    const inserted = tryInsert(stripped, (node) => node.kind === "tabs", id);
    return inserted ?? tree;
  }
  const hit = findPanel(stripped, anchor);
  if (!hit || hit.node.kind !== "tabs") return ensurePanel(tree, id);
  const panels = [...hit.node.panels];
  const at = Math.min(Math.max(0, index), panels.length);
  panels.splice(at, 0, id);
  return replaceAt(stripped, hit.path, { ...hit.node, panels, active: at });
}

// ---------------------------------------------------------------------------
// 工作区主体
// ---------------------------------------------------------------------------

interface DockApi {
  setNode: (path: number[], node: DockNode) => void;
  activate: (path: number[], panel: FxPanelId) => void;
  toggleEntry: (path: number[], index: number) => void;
  setStackHeights: (path: number[], index: number, aPercent: number, bPercent: number) => void;
  closePanel: (id: FxPanelId) => void;
  closeOthers: (path: number[], keep: FxPanelId) => void;
  movePanelTo: (id: FxPanelId, anchor: FxPanelId | null, index: number) => void;
  openPanel: (id: FxPanelId) => void;
  applyWorkspace: (name: WorkspaceName) => void;
  reset: () => void;
}

/** 布局在页面切换后保留：模块级一份缓存，组件卸载不丢。 */
let memoTree: DockNode | null = null;

export function FxWorkspace() {
  const [tree, setTreeState] = useState<DockNode>(() => memoTree ?? defaultDock());
  const panelRequest = useAppStore((s) => s.fxPanelRequest);
  const workspaceRequest = useAppStore((s) => s.fxWorkspaceRequest);

  const setTree = useCallback(
    (updater: DockNode | ((prev: DockNode) => DockNode)) => {
      setTreeState((prev) => {
        const next =
          typeof updater === "function" ? (updater as (p: DockNode) => DockNode)(prev) : updater;
        memoTree = next;
        return next;
      });
    },
    []
  );

  const apiRef = useRef<DockApi | null>(null);
  if (apiRef.current === null) {
    apiRef.current = {
      setNode: (path, node) => setTree((prev) => replaceAt(prev, path, node)),
      activate: (path, panel) =>
        setTree((prev) => {
          const target = path.length === 0 ? prev : findNodeAt(prev, path);
          if (!target) return prev;
          return replaceAt(prev, path, activatePanel(target, panel));
        }),
      toggleEntry: (path, index) =>
        setTree((prev) => {
          const node = findNodeAt(prev, path);
          if (!node || node.kind !== "stack") return prev;
          const entries = node.entries.map((entry, i) =>
            i === index ? { ...entry, open: !entry.open } : entry
          );
          return replaceAt(prev, path, { ...node, entries });
        }),
      setStackHeights: (path, index, aPercent, bPercent) =>
        setTree((prev) => {
          const node = findNodeAt(prev, path);
          if (!node || node.kind !== "stack") return prev;
          const entries = node.entries.map((entry, i) => {
            if (i === index) return { ...entry, height: Math.max(40, aPercent) };
            if (i === index + 1) return { ...entry, height: Math.max(40, bPercent) };
            return entry;
          });
          return replaceAt(prev, path, { ...node, entries });
        }),
      closePanel: (id) =>
        setTree((prev) => {
          const next = removePanel(prev, id);
          return next ?? { kind: "tabs", panels: [], active: 0 };
        }),
      closeOthers: (path, keep) =>
        setTree((prev) => {
          const node = findNodeAt(prev, path);
          if (!node) return prev;
          if (node.kind === "tabs") {
            return replaceAt(prev, path, { ...node, panels: [keep], active: 0 });
          }
          if (node.kind === "stack") {
            const entry = node.entries.find((item) => item.panels.includes(keep));
            if (!entry) return prev;
            return replaceAt(prev, path, {
              ...node,
              entries: [{ ...entry, panels: [keep], active: 0, open: true }],
            });
          }
          return prev;
        }),
      movePanelTo: (id, anchor, index) => setTree((prev) => movePanel(prev, id, anchor, index)),
      openPanel: (id) => setTree((prev) => ensurePanel(prev, id)),
      applyWorkspace: (name) => setTree(workspace(name)),
      reset: () => setTree(defaultDock()),
    };
  }

  // 窗口菜单请求：打开 / 聚焦面板
  useEffect(() => {
    if (!panelRequest) return;
    const id = panelRequest.id as FxPanelId;
    if (dockPanels(tree).includes(id) || panelMeta(id).id === id) {
      setTree((prev) => ensurePanel(prev, id));
    }
  }, [panelRequest, setTree, tree]);

  // 窗口菜单请求：套用工作区
  useEffect(() => {
    if (!workspaceRequest) return;
    setTree(workspace(workspaceRequest.name as WorkspaceName));
  }, [workspaceRequest, setTree]);

  return (
    <div className="fxw-root">
      <DockView node={tree} path={[]} api={apiRef.current} />
    </div>
  );
}

function findNodeAt(node: DockNode, path: number[]): DockNode | null {
  let current: DockNode = node;
  for (const step of path) {
    if (current.kind !== "split") return null;
    current = step === 0 ? current.a : current.b;
  }
  return current;
}

// ---------------------------------------------------------------------------
// 递归渲染
// ---------------------------------------------------------------------------

function DockView({ node, path, api }: { node: DockNode; path: number[]; api: DockApi }) {
  if (node.kind === "split") return <SplitView node={node} path={path} api={api} />;
  if (node.kind === "tabs") return <TabsView node={node} path={path} api={api} />;
  return <StackView node={node} path={path} api={api} />;
}

function SplitView({ node, path, api }: { node: DockSplit; path: number[]; api: DockApi }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const total = node.vertical ? rect.height : rect.width;
    if (total <= 0) return;
    setDragging(true);

    const move = (ev: PointerEvent) => {
      const raw = node.vertical ? ev.clientY - rect.top : ev.clientX - rect.left;
      const min = 120;
      const px = Math.min(Math.max(min, raw), total - min);
      if (node.size.type === "ratio") {
        api.setNode(path, { ...node, size: { type: "ratio", value: px / total } });
      } else {
        api.setNode(path, { ...node, size: { type: node.size.type, px } });
      }
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const aStyle: React.CSSProperties =
    node.size.type === "fixedA"
      ? { flex: `0 0 ${node.size.px}px` }
      : node.size.type === "ratio"
        ? { flex: `0 0 ${node.size.value * 100}%` }
        : { flex: "1 1 0" };
  const bStyle: React.CSSProperties =
    node.size.type === "fixedB" ? { flex: `0 0 ${node.size.px}px` } : { flex: "1 1 0" };

  return (
    <div className={`fxw-split${node.vertical ? " vertical" : ""}`} ref={hostRef}>
      <div className="fxw-split-a" style={aStyle}>
        <DockView node={node.a} path={[...path, 0]} api={api} />
      </div>
      <div
        className={`fxw-gutter${node.vertical ? " vertical" : ""}${dragging ? " dragging" : ""}`}
        onPointerDown={startDrag}
        role="separator"
        aria-orientation={node.vertical ? "horizontal" : "vertical"}
      />
      <div className="fxw-split-b" style={bStyle}>
        <DockView node={node.b} path={[...path, 1]} api={api} />
      </div>
    </div>
  );
}

function TabsView({ node, path, api }: { node: DockTabs; path: number[]; api: DockApi }) {
  const active = node.panels[Math.min(node.active, node.panels.length - 1)];

  const onDragStart = (event: ReactDragEvent<HTMLDivElement>, panel: FxPanelId) => {
    event.dataTransfer.setData("application/reelix-fx-panel", panel);
    event.dataTransfer.effectAllowed = "move";
  };

  const onDropAt = (event: ReactDragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer.getData("application/reelix-fx-panel") as FxPanelId;
    if (!id) return;
    const anchor = node.panels.find((panel) => panel !== id) ?? null;
    api.movePanelTo(id, anchor, index);
  };

  return (
    <div className="fxw-group">
      <div
        className="fxw-tabbar"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => onDropAt(event, node.panels.length)}
      >
        {node.panels.map((panel, index) => (
          <div
            key={panel}
            className={`fxw-tab${panel === active ? " active" : ""}`}
            draggable
            onDragStart={(event) => onDragStart(event, panel)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onDropAt(event, index)}
            onClick={() => api.activate(path, panel)}
            onAuxClick={(event) => {
              if (event.button === 1) api.closePanel(panel);
            }}
            title={`${panelMeta(panel).title}（拖动可重排，中键关闭）`}
          >
            <span className="fxw-tab-label">{panelMeta(panel).title}</span>
            <button
              type="button"
              className="fxw-tab-x"
              title="关闭面板"
              onClick={(event) => {
                event.stopPropagation();
                api.closePanel(panel);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <span className="fxw-grow" />
        {active && (
          <GroupMenu
            current={active}
            panelCount={node.panels.length}
            path={path}
            api={api}
          />
        )}
      </div>
      <div className="fxw-body">{active ? <FxPanelBody id={active} /> : null}</div>
    </div>
  );
}

function StackView({ node, path, api }: { node: DockStack; path: number[]; api: DockApi }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const entryRefs = useRef<Array<HTMLDivElement | null>>([]);

  const startGapDrag = (index: number, event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const host = hostRef.current;
    const elA = entryRefs.current[index];
    const elB = entryRefs.current[index + 1];
    if (!host || !elA || !elB) return;
    const total = host.clientHeight;
    if (total <= 0) return;
    const startY = event.clientY;
    const hA = elA.getBoundingClientRect().height;
    const hB = elB.getBoundingClientRect().height;

    const move = (ev: PointerEvent) => {
      const delta = ev.clientY - startY;
      const min = 40;
      const a = Math.max(min, Math.min(hA + delta, hA + hB - min));
      const b = hA + hB - a;
      api.setStackHeights(path, index, (a / total) * 100, (b / total) * 100);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="fxw-stack" ref={hostRef}>
      {node.entries.map((entry, index) => {
        const active = entry.panels[Math.min(entry.active, entry.panels.length - 1)];
        const next = node.entries[index + 1];
        const style: React.CSSProperties = entry.open
          ? entry.height !== null
            ? { flex: `0 0 ${entry.height}%` }
            : { flex: "1 1 0" }
          : { flex: "0 0 auto" };
        return (
          <Fragment key={active}>
            <div
              className={`fxw-stack-item${entry.open ? " open" : " closed"}`}
              style={style}
              ref={(el) => {
                entryRefs.current[index] = el;
              }}
            >
              <div
                className={`fxw-stack-head${entry.open ? "" : " collapsed"}`}
                onClick={() => api.toggleEntry(path, index)}
                title={entry.open ? "点击折叠" : "点击展开"}
              >
                <span className="fxw-caret">{entry.open ? "▾" : "▸"}</span>
                <span className="fxw-stack-title">{active ? panelMeta(active).title : ""}</span>
                <span className="fxw-grow" />
                <button
                  type="button"
                  className="fxw-tab-x"
                  title="关闭面板"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (active) api.closePanel(active);
                  }}
                >
                  ×
                </button>
                {active && (
                  <GroupMenu
                    current={active}
                    panelCount={entry.panels.length}
                    path={path}
                    api={api}
                  />
                )}
              </div>
              {entry.open && active && (
                <div className="fxw-stack-body">
                  <FxPanelBody id={active} />
                </div>
              )}
            </div>
            {next && (
              <div
                className={`fxw-stack-gap${entry.open && next.open ? " live" : ""}`}
                onPointerDown={
                  entry.open && next.open
                    ? (event) => startGapDrag(index, event)
                    : undefined
                }
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 面板菜单（≡）
// ---------------------------------------------------------------------------

function GroupMenu({
  current,
  panelCount,
  path,
  api,
}: {
  current: FxPanelId;
  panelCount: number;
  path: number[];
  api: DockApi;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="fxw-menu-wrap" ref={boxRef}>
      <button
        type="button"
        className="fxw-menu-btn"
        title="面板菜单"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        ≡
      </button>
      {open && (
        <div className="fxw-menu" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="fxw-menu-item"
            onClick={() => {
              api.closePanel(current);
              setOpen(false);
            }}
          >
            关闭面板
          </button>
          <button
            type="button"
            className="fxw-menu-item"
            disabled={panelCount <= 1}
            onClick={() => {
              api.closeOthers(path, current);
              setOpen(false);
            }}
          >
            关闭组内其他面板
          </button>
          <div className="fxw-menu-sep" />
          <div className="fxw-menu-title">工作区</div>
          <div className="fxw-menu-scroll">
            {WORKSPACE_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                className="fxw-menu-item"
                onClick={() => {
                  api.applyWorkspace(name);
                  setOpen(false);
                }}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="fxw-menu-sep" />
          <button
            type="button"
            className="fxw-menu-item"
            onClick={() => {
              api.reset();
              setOpen(false);
            }}
          >
            重置为 Default
          </button>
        </div>
      )}
    </div>
  );
}
