/**
 * 音频服务。
 *
 * 波形与录音的重活都在 Rust 侧：波形是后端解 PCM 压好的峰值桶，
 * 录音是前端采集原始字节、后端转 WAV 并按普通素材导入。
 */

import { invoke } from "@tauri-apps/api/core";
import type { Asset } from "../types/project";

/**
 * 取一段素材的波形峰值，长度恒等于 buckets，取值 0 ~ 1。
 *
 * inMs / outMs 是素材内时间窗（与片段入出点同一口径），变速片段传片段速度。
 */
export function extractWaveform(
  assetId: string,
  inMs: number,
  outMs: number,
  speed: number,
  buckets: number
): Promise<number[]> {
  return invoke<number[]>("extract_waveform", {
    assetId,
    inMs,
    outMs,
    speed,
    buckets,
  });
}

/** 把一段录音字节交给后端转成 WAV 并导入素材箱，返回新素材。 */
export function saveRecording(data: ArrayBuffer): Promise<Asset> {
  return invoke<Asset>("save_recording", { data: Array.from(new Uint8Array(data)) });
}

/** 在资源管理器里定位一个文件（导出完成后的「打开所在文件夹」）。 */
export function revealPath(path: string): Promise<boolean> {
  return invoke<boolean>("reveal_path", { path });
}
