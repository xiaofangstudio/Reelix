/**
 * 设置服务。
 *
 * 设置写在 %APPDATA%\Reelix\settings.json，由 Rust 侧负责读写。
 * 没有云端同步，没有账号，配置只存在本机。
 */

import { invoke } from "@tauri-apps/api/core";

/** 应用设置 */
export interface Settings {
  /** 缓存目录，可改 */
  cacheDir: string;
  /** 缓存上限，默认 20GB */
  cacheLimitBytes: number;
  /** 预览缩放，0.25 ~ 1.0 */
  previewScale: number;
  /** 自动保存间隔，毫秒；0 表示关闭 */
  autoSaveIntervalMs: number;
  /** 界面语言，全中文界面固定 zh-CN */
  language: string;
  /** 界面主题：light / dark */
  theme: "light" | "dark";
  /** 静止图片上轨的默认时长（毫秒） */
  imageDefaultMs: number;
  /** 默认转场 / 淡入淡出时长（毫秒） */
  transitionDefaultMs: number;
  /** 手动新建字幕、文字的默认时长（毫秒） */
  subtitleDefaultMs: number;
  /** 新建工程默认画幅宽 */
  defaultWidth: number;
  /** 新建工程默认画幅高 */
  defaultHeight: number;
  /** 新建工程默认帧率 */
  defaultFrameRate: number;
  /** 时间线自动吸附总开关 */
  snapEnabled: boolean;
}

/** 读取设置 */
export function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

/** 写入设置，返回写入后的完整设置 */
export function setSettings(next: Settings): Promise<Settings> {
  return invoke<Settings>("set_settings", { settings: next });
}
