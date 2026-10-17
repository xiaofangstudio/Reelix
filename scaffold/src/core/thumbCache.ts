/**
 * 共享缩略图缓存。
 *
 * 时间线胶片条、素材箱、监视器预览都要缩略图。各管一份会重复起 ffmpeg、
 * 重复建 objectURL，所以收拢到这一处：
 * - 键为「素材 id @ 毫秒」，与后端 `generate_thumbnail` 的落盘口径对齐
 *   （后端按整毫秒取整落盘，同一时刻第二次请求直接读缓存文件）；
 * - 并发上限 4 条抽帧请求，多出来的排队——拖拽缩放时不会把后端打爆；
 * - 容量上限 220 张，超出按龄淘汰并回收 objectURL；界面上还在看的
 *   （有订阅者的）不淘汰，避免出现破图；
 * - 取图走订阅制：缓存落地后通知等这张图的组件重渲染。
 *
 * 这里是纯缓存，不依赖 React；React 绑定在 `src/hooks/useThumbUrl.ts`。
 */

import { generateThumbnail } from "../services/media";
import { bytesToObjectUrl } from "./ipcBytes";

/** 最多同时几条抽帧请求 */
const MAX_INFLIGHT = 4;
/** 缓存容量上限（张） */
const MAX_ENTRIES = 220;

/** 键 -> objectURL。Map 的迭代序即为龄，先进先出淘汰 */
const urlByKey = new Map<string, string>();
/** 键 -> 进行中的请求，避免同一张图并发抽帧 */
const pendingByKey = new Map<string, Promise<string | null>>();
/** 键 -> 已失败的记录，本次会话不再重试，避免反复打扰后端 */
const failedKeys = new Set<string>();
/** 键 -> 就绪订阅，图到了就喊一声 */
const readyListeners = new Map<string, Set<() => void>>();

let inflight = 0;
const waiters: Array<() => void> = [];

/** 缓存键。毫秒取整，与后端的落盘口径一致。 */
export function thumbKey(assetId: string, timeMs: number): string {
  return `${assetId}@${Math.max(0, Math.round(timeMs))}`;
}

/** 已缓存就直接给 URL，没有给 null（不发起请求）。 */
export function peekThumb(assetId: string, timeMs: number): string | null {
  return urlByKey.get(thumbKey(assetId, timeMs)) ?? null;
}

/** 订阅某张图就绪；返回取消订阅函数。 */
export function onThumbReady(assetId: string, timeMs: number, fn: () => void): () => void {
  const key = thumbKey(assetId, timeMs);
  let set = readyListeners.get(key);
  if (!set) {
    set = new Set();
    readyListeners.set(key, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
    if (set && set.size === 0) readyListeners.delete(key);
  };
}

function notify(key: string): void {
  readyListeners.get(key)?.forEach((fn) => fn());
}

/** 按龄淘汰。界面上还在看的键（有订阅者）跳过，避免破图。 */
function evictIfNeeded(): void {
  while (urlByKey.size > MAX_ENTRIES) {
    let evicted = false;
    for (const key of urlByKey.keys()) {
      if (readyListeners.has(key)) continue;
      const url = urlByKey.get(key);
      urlByKey.delete(key);
      if (url) URL.revokeObjectURL(url);
      evicted = true;
      break;
    }
    // 全都有订阅者：这轮不淘汰，等界面撤了订阅再收
    if (!evicted) break;
  }
}

function pump(): void {
  while (inflight < MAX_INFLIGHT && waiters.length > 0) {
    inflight += 1;
    const next = waiters.shift();
    next?.();
  }
}

/**
 * 取一张缩略图。命中缓存立即返回；失败返回 null 并记住不再试。
 * 调用方应配 `onThumbReady` 订阅就绪事件，否则拿不到异步到达的图。
 */
export function loadThumb(assetId: string, timeMs: number): Promise<string | null> {
  const key = thumbKey(assetId, timeMs);
  const hit = urlByKey.get(key);
  if (hit) return Promise.resolve(hit);
  if (failedKeys.has(key)) return Promise.resolve(null);

  const existing = pendingByKey.get(key);
  if (existing) return existing;

  const request = new Promise<string | null>((resolve) => {
    waiters.push(() => {
      generateThumbnail(assetId, Math.max(0, Math.round(timeMs)))
        .then((bytes) => {
          const url = bytesToObjectUrl(bytes);
          urlByKey.set(key, url);
          evictIfNeeded();
          resolve(url);
          notify(key);
        })
        .catch(() => {
          // 抽帧失败（音频素材、文件丢失、ffmpeg 缺失）：静默记一笔，不重试
          failedKeys.add(key);
          resolve(null);
          notify(key);
        })
        .finally(() => {
          inflight -= 1;
          pendingByKey.delete(key);
          pump();
        });
    });
  });
  pendingByKey.set(key, request);
  pump();
  return request;
}

/** 应用退出时回收全部 objectURL。平时不必调用。 */
export function disposeThumbCache(): void {
  for (const url of urlByKey.values()) URL.revokeObjectURL(url);
  urlByKey.clear();
  failedKeys.clear();
  readyListeners.clear();
}
