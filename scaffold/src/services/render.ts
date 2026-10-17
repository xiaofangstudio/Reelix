/**
 * 渲染服务。
 *
 * 请求帧、预览播放、缓存管理。画面永远由 Rust 侧算好再给前端，
 * 前端这里只发命令、订事件，不做任何逐帧处理。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

/** 缓存统计 */
export interface CacheStats {
  memoryBytes: number;
  diskBytes: number;
  entries: number;
}

/** 预览帧就绪事件的载荷 */
export interface PreviewFramePayload {
  timeMs: number;
  path: string;
}

/** 预览性能事件的载荷 */
export interface PreviewStatsPayload {
  fps: number;
  droppedFrames: number;
  scale: number;
}

/** 手动指定节点标脏，触发重算 */
export type CacheScope = "memory" | "disk" | "all";

/**
 * 请求一帧，返回编码好的 PNG 原始字节。
 *
 * 后端把画面渲染成 PNG 后直接回二进制，前端拿到的是 `ArrayBuffer`，
 * `new Blob([bytes], { type: "image/png" })` 就能交给 `<img>` 显示。
 * `maxWidth` / `maxHeight` 是给后端的画幅上限提示，不是硬性裁剪。
 */
export function requestFrame(
  sequenceId: string,
  timeMs: number,
  maxWidth?: number,
  maxHeight?: number
): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("request_frame", {
    sequenceId,
    timeMs,
    maxWidth: maxWidth ?? null,
    maxHeight: maxHeight ?? null,
  });
}

/** 开始预览播放 */
export function startPreview(sequenceId: string): Promise<boolean> {
  return invoke<boolean>("start_preview", { sequenceId });
}

/** 停止预览播放 */
export function stopPreview(): Promise<boolean> {
  return invoke<boolean>("stop_preview");
}

/** 设置预览缩放，取值 0.25 ~ 1.0 */
export function setPreviewQuality(scale: number): Promise<boolean> {
  return invoke<boolean>("set_preview_quality", { scale });
}

/** 手动把某个节点标脏 */
export function invalidateNode(nodeId: string): Promise<boolean> {
  return invoke<boolean>("invalidate_node", { nodeId });
}

/** 读取缓存占用 */
export function getCacheStats(): Promise<CacheStats> {
  return invoke<CacheStats>("get_cache_stats");
}

/** 清理缓存 */
export function clearCache(scope: CacheScope): Promise<boolean> {
  return invoke<boolean>("clear_cache", { scope });
}

/** 订阅预览帧就绪事件 */
export function onPreviewFrame(
  handler: (payload: PreviewFramePayload) => void
): Promise<UnlistenFn> {
  return listen<PreviewFramePayload>("preview://frame", (event) => handler(event.payload));
}

/** 订阅预览性能事件，用于监视器角落的降级提示 */
export function onPreviewStats(
  handler: (payload: PreviewStatsPayload) => void
): Promise<UnlistenFn> {
  return listen<PreviewStatsPayload>("preview://stats", (event) => handler(event.payload));
}

/** 订阅图脏标记事件 */
export function onGraphDirty(
  handler: (payload: { nodeIds: string[] }) => void
): Promise<UnlistenFn> {
  return listen<{ nodeIds: string[] }>("graph://dirty", (event) => handler(event.payload));
}
