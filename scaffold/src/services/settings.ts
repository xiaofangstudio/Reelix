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
}

/** 读取设置 */
export function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

/** 写入设置，返回写入后的完整设置 */
export function setSettings(next: Settings): Promise<Settings> {
  return invoke<Settings>("set_settings", { settings: next });
}
