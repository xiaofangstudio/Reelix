/**
 * 项目服务。
 *
 * services 层是前端唯一能碰 Tauri IPC 的地方：界面组件不许直接 invoke，
 * 一律走这一层。这样以后换通信方式、加缓存、加埋点都只改一处。
 *
 * 命令名与参数严格遵循 docs/03-技术架构.md 第四节的命令契约。
 */

import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../types/project";

/** 开场界面选定的画幅与时间基准 */
export interface ProjectSettings {
  /** 画幅宽（像素） */
  width: number;
  /** 画幅高（像素） */
  height: number;
  /** 帧率 */
  frameRate: number;
  /** 色彩空间，如 Rec.709 / Rec.2020 / sRGB */
  colorSpace: string;
}

/** 新建项目，画幅 / 帧率 / 色彩空间由开场界面传入，返回全新的项目快照 */
export function newProject(name: string, settings: ProjectSettings): Promise<Project> {
  return invoke<Project>("new_project", { name, ...settings });
}

/** 打开 .reelix 项目文件 */
export function openProject(path: string): Promise<Project> {
  return invoke<Project>("open_project", { path });
}

/** 保存项目；不传路径时由后端弹出保存对话框 */
export function saveProject(path?: string): Promise<{ path: string }> {
  return invoke<{ path: string }>("save_project", { path: path ?? null });
}

/** 取当前项目快照 */
export function getProject(): Promise<Project> {
  return invoke<Project>("get_project");
}

/** 取当前项目落盘路径；从未保存过时返回 null */
export function getProjectPath(): Promise<string | null> {
  return invoke<string | null>("get_project_path");
}

/** 关闭项目并清理相关缓存 */
export function closeProject(): Promise<boolean> {
  return invoke<boolean>("close_project");
}
