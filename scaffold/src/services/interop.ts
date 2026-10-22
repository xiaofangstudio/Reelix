import { invoke } from "@tauri-apps/api/core";

/** Strata 联动：扫投递箱（%LOCALAPPDATA%\\Reelix\\dropbox），把 Strata 送来的 PNG 导入素材箱 */
export function importDropbox(): Promise<number> {
  return invoke<number>("import_dropbox");
}

/** 投递箱目录（界面提示用） */
export function dropboxPath(): Promise<string> {
  return invoke<string>("dropbox_path");
}
