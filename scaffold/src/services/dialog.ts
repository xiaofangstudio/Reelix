/**
 * 系统文件对话框服务。
 *
 * 选素材、选项目文件、选保存位置这三个框都在 Rust 侧弹出，
 * 前端不引对话框 npm 包、也不经手路径。这里只把结果转交给调用方。
 * 对话框只由用户主动动作触发，没有任何网络行为。
 */

import { invoke } from "@tauri-apps/api/core";

/** 弹出素材选择框，可多选。用户取消时返回空数组 */
export function pickMediaFiles(): Promise<string[]> {
  return invoke<string[]>("pick_media_files");
}

/** 弹出项目打开框。用户取消时返回 null */
export function pickProjectFile(): Promise<string | null> {
  return invoke<string | null>("pick_project_file");
}

/** 弹出保存框。用户取消时返回 null */
export function pickSavePath(defaultName: string): Promise<string | null> {
  return invoke<string | null>("pick_save_path", { defaultName });
}
