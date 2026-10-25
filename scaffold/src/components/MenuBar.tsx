/**
 * 菜单栏（FC 参考 样式）：一行九个菜单按钮，点击展开下拉，
 * 子菜单悬停展开；项与快捷键全部来自 menuRegistry —— 菜单栏不是另写一套。
 * 置灰、点击、分隔线都按注册表的声明渲染；没有 run 的枝干项只是展开子菜单。
 */

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import type { MenuItem } from "../core/menuRegistry";
import { IconMoon, IconSun } from "./icons";

export function MenuBar({ menus }: { menus: MenuItem[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setPage = useAppStore((s) => s.setPage);
  const exportJob = useAppStore((s) => s.exportJob);
  const exportPercent =
    exportJob.status === "running" && exportJob.progress.totalFrames > 0
      ? Math.min(
          100,
          Math.round((exportJob.progress.frame / exportJob.progress.totalFrames) * 100)
        )
      : 0;

  // 点菜单栏以外的任何地方，收起
  useEffect(() => {
    if (!openId) return;
    const onDown = (e: PointerEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenId(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [openId]);

  return (
    <div className="menubar" ref={barRef}>
      <div className="menubar-brand">
        Reelix<span className="dot">.</span>
      </div>

      {menus.map((m) => (
        <div key={m.id} className="menubar-slot">
          <button
            type="button"
            className={`menubar-btn${openId === m.id ? " open" : ""}`}
            onClick={() => setOpenId(openId === m.id ? null : m.id)}
          >
            {m.label}
          </button>
          {openId === m.id && (
            <div className="menu-dropdown">
              {renderItems(m.children ?? [], () => setOpenId(null))}
            </div>
          )}
        </div>
      ))}

      <div className="menubar-spacer" />

      {exportJob.status === "running" && (
        <button
          type="button"
          className="menubar-export-chip"
          onClick={() => setPage("deliver")}
          title="导出正在进行，点击查看进度"
        >
          导出中 {exportPercent}%
        </button>
      )}
      <button
        type="button"
        className="menubar-btn menubar-theme"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        title={theme === "dark" ? "切换为浅色主题" : "切换为深色主题"}
      >
        {theme === "dark" ? <IconSun /> : <IconMoon />}
      </button>
      <button
        type="button"
        className="menubar-btn menubar-settings"
        onClick={() => setSettingsOpen(true)}
        title="偏好设置：主题 / 预览性能 / 自动保存 / 缓存（Ctrl+,）"
      >
        设置
      </button>
      <button
        type="button"
        className="menubar-export"
        onClick={() => setPage("deliver")}
        title="跳到导出页"
      >
        导出
      </button>
    </div>
  );
}

/** 带子菜单的项：hover 就展开（桌面菜单常规），同时点击也能切换（hover 失效时的保底） */
function SubMenuItem({
  item,
  close,
}: {
  item: MenuItem;
  close: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`menu-sub-wrap${open ? " sub-open" : ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="menu-item has-sub"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{item.label}</span>
        <span className="menu-arrow">›</span>
      </button>
      {open && <div className="menu-dropdown sub">{renderItems(item.children ?? [], close)}</div>}
    </div>
  );
}

/** 渲染一层菜单项；children 项悬停时把子菜单排在右侧；separator 画分隔线 */
function renderItems(items: MenuItem[], close: () => void): JSX.Element[] {
  const out: JSX.Element[] = [];
  for (const it of items) {
    if (it.separator) {
      out.push(<div key={it.id} className="menu-sep" />);
      continue;
    }
    const disabled = it.enabled ? !it.enabled() : false;
    if (it.children && it.children.length > 0) {
      out.push(<SubMenuItem key={it.id} item={it} close={close} />);
      continue;
    }
    out.push(
      <button
        key={it.id}
        type="button"
        className="menu-item"
        disabled={disabled || !it.run}
        onClick={() => {
          it.run?.();
          close();
        }}
      >
        <span>{it.label}</span>
        {it.shortcut && <span className="menu-key">{it.shortcut}</span>}
      </button>
    );
  }
  return out;
}

/** 供外部按 id 执行菜单命令（快捷键系统用同一张表） */
export function runMenuCommand(menus: MenuItem[], id: string): boolean {
  const walk = (items: MenuItem[]): MenuItem | null => {
    for (const it of items) {
      if (it.id === id) return it;
      if (it.children) {
        const hit = walk(it.children);
        if (hit) return hit;
      }
    }
    return null;
  };
  const item = walk(menus);
  if (!item || !item.run) return false;
  if (item.enabled && !item.enabled()) return false;
  item.run();
  return true;
}
