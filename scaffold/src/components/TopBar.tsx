/**
 * 顶栏。高 48px，菜单项 + 导出按钮，右侧一个主题切换。
 *
 * 「文件」与「编辑」是真菜单：新建 / 打开 / 保存 / 另存 / 关闭、撤销 / 重做
 * 都直接落到 `store/projectActions`，不是把按钮做成装饰。
 * 其余菜单（序列 / 素材 / 特效 / 视图 / 帮助）涉及的能力在后续里程碑接上，
 * 这里以禁用态呈现并说明原因，不装作能用。
 * 导出任务在后台跑时，右侧常驻「导出中 xx%」胶囊，点一下回导出页。
 */

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import {
  closeProject,
  openProject,
  openStartScreen,
  redo,
  saveProject,
  saveProjectAs,
  undo,
} from "../store/projectActions";

/** 一条菜单项。没有 run 的条目是「尚未开放」的说明项。 */
interface MenuEntry {
  label: string;
  /** 快捷键提示，没有就不显示 */
  hint?: string;
  run?: () => void;
  /** 需要已打开工程才能点 */
  needsProject?: boolean;
  /** 只是占位说明，不可点 */
  disabledNote?: string;
}

/** 二级菜单定义。有内容的菜单才展开下拉，其余点一下给出「还没开放」的提示。 */
function useMenus(hasProject: boolean, notice: (text: string) => void) {
  const fileMenu: MenuEntry[] = [
    { label: "新建工程", hint: "Ctrl+N", run: () => openStartScreen() },
    { label: "打开工程…", hint: "Ctrl+O", run: () => void openProject() },
    {
      label: "保存",
      hint: "Ctrl+S",
      needsProject: true,
      run: () => void saveProject(),
    },
    {
      label: "另存为…",
      hint: "Ctrl+Shift+S",
      needsProject: true,
      run: () => void saveProjectAs(),
    },
    {
      label: "关闭工程",
      needsProject: true,
      run: () => void closeProject(),
    },
  ];

  const editMenu: MenuEntry[] = [
    {
      label: "撤销",
      hint: "Ctrl+Z",
      needsProject: true,
      run: () => void undo(),
    },
    {
      label: "重做",
      hint: "Ctrl+Shift+Z",
      needsProject: true,
      run: () => void redo(),
    },
  ];

  // 还没开放的能力：明确说明挂在哪个里程碑，不做成死按钮也不假装能用
  const laterMenus: Record<string, MenuEntry[]> = {
    序列: [
      { label: "序列设置…", disabledNote: "序列设置将在 M1 接上" },
      { label: "新建序列", disabledNote: "序列设置将在 M1 接上" },
    ],
    素材: [
      { label: "导入素材…", disabledNote: "请用素材箱左上角的「导入素材」" },
      { label: "重新链接…", disabledNote: "重新链接将在 M1 接上" },
    ],
    特效: [
      { label: "添加效果", disabledNote: "请用属性面板顶部效果栈的「+ 添加效果」" },
      { label: "保存为预设", disabledNote: "预设库将在 M3 接上" },
    ],
    视图: [
      { label: "曲线编辑器", disabledNote: "请用下半区的「曲线编辑器」标签页" },
      { label: "面板布局", disabledNote: "布局自定义将在 M3 接上" },
    ],
    帮助: [
      { label: "快捷键说明", disabledNote: "帮助文档将在 M4 接上" },
      { label: "关于 Reelix", disabledNote: "关于页将在 M4 接上" },
    ],
  };

  return { fileMenu, editMenu, laterMenus, hasProject, notice };
}

export function TopBar() {
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const hasProject = useAppStore((s) => s.project !== null);
  const pushNotice = useAppStore((s) => s.pushNotice);
  const setPage = useAppStore((s) => s.setPage);
  // 导出是后台任务：顶栏常驻一个「导出中 xx%」胶囊，点一下回导出页看进度
  const exportJob = useAppStore((s) => s.exportJob);
  const exportPercent =
    exportJob.status === "running" && exportJob.progress.totalFrames > 0
      ? Math.min(
          100,
          Math.round((exportJob.progress.frame / exportJob.progress.totalFrames) * 100)
        )
      : 0;

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const barRef = useRef<HTMLElement>(null);

  const { fileMenu, editMenu, laterMenus } = useMenus(hasProject, (text) =>
    pushNotice("info", text)
  );

  // 点空白处或按 Esc 收起下拉
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  /** 点菜单标题：有下拉就展开，没有就给一句「还没开放」的说明。 */
  const openOrExplain = (label: string) => {
    if (label === "文件" || label === "编辑") {
      setOpenMenu((cur) => (cur === label ? null : label));
      return;
    }
    const note = laterMenus[label]?.[0]?.disabledNote;
    if (note) pushNotice("info", note);
  };

  const renderMenu = (label: string, entries: MenuEntry[]) => (
    <div className="menu-wrap" key={label}>
      <button
        type="button"
        className={`menu-item${openMenu === label ? " open" : ""}`}
        onClick={() => openOrExplain(label)}
      >
        {label}
      </button>

      {openMenu === label && (
        <div className="menu-dropdown">
          {entries.map((entry) => {
            const disabled = !entry.run || (entry.needsProject === true && !hasProject);
            return (
              <button
                key={entry.label}
                type="button"
                className="menu-dropdown-item"
                disabled={disabled}
                title={
                  entry.needsProject === true && !hasProject
                    ? "先新建或打开一个工程"
                    : entry.disabledNote
                }
                onClick={() => {
                  if (disabled) return;
                  setOpenMenu(null);
                  entry.run?.();
                }}
              >
                <span className="menu-dropdown-label">{entry.label}</span>
                {entry.hint && <span className="menu-dropdown-hint">{entry.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <header className="topbar" ref={barRef}>
      <div className="brand">
        Reelix<span className="dot">.</span>
      </div>

      {renderMenu("文件", fileMenu)}
      {renderMenu("编辑", editMenu)}
      {["序列", "素材", "特效", "视图", "帮助"].map((label) => (
        <div className="menu-wrap" key={label}>
          <button
            type="button"
            className="menu-item"
            onClick={() => openOrExplain(label)}
          >
            {label}
          </button>
        </div>
      ))}

      <div className="spacer" />

      {exportJob.status === "running" && (
        <button
          type="button"
          className="btn-export-chip"
          onClick={() => setPage("deliver")}
          title="导出正在进行，点击查看进度"
        >
          导出中 {exportPercent}%
        </button>
      )}
      <button type="button" className="menu-item" onClick={toggleTheme}>
        {theme === "dark" ? "浅色主题" : "深色主题"}
      </button>
      <button
        type="button"
        className="btn-export"
        onClick={() => setPage("deliver")}
        title="跳到导出页"
      >
        导出
      </button>
    </header>
  );
}
