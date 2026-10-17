/**
 * 素材服务。
 *
 * 解码与探测全在 Rust 侧完成，这里只负责发命令、收元数据。
 * 前端绝不自己读取媒体文件，那是重活。
 */

import { invoke } from "@tauri-apps/api/core";
import type { Asset } from "../types/project";

/** 只探测不导入时返回的素材信息 */
export interface MediaInfo {
  path: string;
  kind: Asset["kind"];
  durationMs: number;
  width: number;
  height: number;
  frameRate: number;
  codec: string;
  hasAudio: boolean;
}

/** 导入素材，返回元数据数组 */
export function importMedia(paths: string[]): Promise<Asset[]> {
  return invoke<Asset[]>("import_media", { paths });
}

/** 只探测媒体信息，不写入项目 */
export function probeMedia(path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>("probe_media", { path });
}

/** 重新链接丢失的素材 */
export function relinkMedia(assetId: string, newPath: string): Promise<boolean> {
  return invoke<boolean>("relink_media", { assetId, newPath });
}

/** 移除素材引用；deleteFile 为真时同时删除磁盘文件 */
export function removeMedia(assetId: string, deleteFile = false): Promise<boolean> {
  return invoke<boolean>("remove_media", { assetId, deleteFile });
}

/**
 * 生成指定时刻的缩略图，返回 PNG 原始字节。
 *
 * 后端真抽帧（ffmpeg 解一帧编 PNG），前端 `URL.createObjectURL` 直接显示。
 * 音频素材没有画面，后端会回中文错误，调用方应先按类型过滤。
 */
export function generateThumbnail(assetId: string, timeMs: number): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("generate_thumbnail", { assetId, timeMs });
}
