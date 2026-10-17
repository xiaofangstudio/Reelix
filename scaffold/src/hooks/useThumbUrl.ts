/**
 * React 绑定：订阅一张缩略图。
 *
 * 命中共享缓存立刻有 URL；没命中就发起请求（走 thumbCache 的并发队列），
 * 图落地后经订阅触发重渲染。`enabled` 为假时不请求也不显示——
 * 音频素材、丢失素材用它挡掉。
 */

import { useEffect, useState } from "react";
import { loadThumb, onThumbReady, peekThumb, thumbKey } from "../core/thumbCache";

export function useThumbUrl(assetId: string, timeMs: number, enabled: boolean): string | null {
  const key = thumbKey(assetId, timeMs);
  const [url, setUrl] = useState<string | null>(() =>
    enabled ? peekThumb(assetId, timeMs) : null
  );

  useEffect(() => {
    if (!enabled) {
      setUrl(null);
      return;
    }
    const hit = peekThumb(assetId, timeMs);
    if (hit) {
      setUrl(hit);
      return;
    }
    setUrl(null);
    const unsubscribe = onThumbReady(assetId, timeMs, () => {
      setUrl(peekThumb(assetId, timeMs));
    });
    void loadThumb(assetId, timeMs);
    return unsubscribe;
  }, [assetId, timeMs, enabled, key]);

  return url;
}
