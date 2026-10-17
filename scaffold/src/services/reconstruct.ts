/**
 * 空间识别服务。对应 `commands/reconstruct.rs`。
 *
 * COLMAP 以独立进程跑（sidecar），本服务只负责启动、取消与订阅进度。
 * 解算结果通过 `reconstruct://done` 一次性带回，前端不必再读 camera.json。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  ColmapStatus,
  ReconstructDonePayload,
  ReconstructFailedPayload,
  ReconstructProgressPayload,
} from "../types/camera";

/** 查询 COLMAP 是否就位（可选组件，缺失不影响主链路） */
export function colmapStatus(): Promise<ColmapStatus> {
  return invoke<ColmapStatus>("colmap_status");
}

/** 开始一次解算，返回任务 id */
export function startReconstruct(
  assetId: string,
  keyframeIntervalS?: number
): Promise<{ jobId: string }> {
  return invoke<{ jobId: string }>("start_reconstruct", {
    assetId,
    keyframeIntervalS: keyframeIntervalS ?? null,
  });
}

/** 取消解算：后台会杀掉当前 COLMAP 子进程 */
export function cancelReconstruct(jobId: string): Promise<boolean> {
  return invoke<boolean>("cancel_reconstruct", { jobId });
}

export function onReconstructProgress(
  handler: (payload: ReconstructProgressPayload) => void
): Promise<UnlistenFn> {
  return listen<ReconstructProgressPayload>("reconstruct://progress", (event) =>
    handler(event.payload)
  );
}

export function onReconstructDone(
  handler: (payload: ReconstructDonePayload) => void
): Promise<UnlistenFn> {
  return listen<ReconstructDonePayload>("reconstruct://done", (event) =>
    handler(event.payload)
  );
}

export function onReconstructFailed(
  handler: (payload: ReconstructFailedPayload) => void
): Promise<UnlistenFn> {
  return listen<ReconstructFailedPayload>("reconstruct://error", (event) =>
    handler(event.payload)
  );
}
