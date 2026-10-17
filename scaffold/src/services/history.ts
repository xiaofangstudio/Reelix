/**
 * 历史服务。
 *
 * 剪辑操作与特效操作在同一个撤销栈里：用户按一次 Ctrl+Z，
 * 撤销的是他上一次做的任何事，不区分属于哪一层。
 */

import { invoke } from "@tauri-apps/api/core";

/** 一条历史记录 */
export interface HistoryEntry {
  index: number;
  /** 中文描述，用于历史面板 */
  description: string;
}

/** 撤销上一步 */
export function undo(): Promise<{ ok: boolean; description: string }> {
  return invoke<{ ok: boolean; description: string }>("undo");
}

/** 重做下一步 */
export function redo(): Promise<{ ok: boolean; description: string }> {
  return invoke<{ ok: boolean; description: string }>("redo");
}

/** 取历史列表 */
export function getHistory(): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>("get_history");
}

/** 跳到某个历史点 */
export function jumpHistory(index: number): Promise<boolean> {
  return invoke<boolean>("jump_history", { index });
}
