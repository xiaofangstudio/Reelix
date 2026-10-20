/**
 * 导出服务。
 *
 * 导出是 M4 的事，这里先把命令契约固定下来，界面层可以按契约先行对接。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

/** 导出预设 */
export interface ExportPreset {
  id: string;
  /** 中文名，界面直接显示 */
  name: string;
  container: string;
  videoCodec: string;
  audioCodec: string;
  width: number;
  height: number;
  frameRate: number;
  bitrateKbps: number;
  /** 本机 ffmpeg 是否真能编这个编码 */
  available?: boolean;
}

/** 导出范围 */
export interface ExportRange {
  startMs: number;
  endMs: number;
}

/**
 * 导出 EDL（CMX3600 交换格式）：把当前序列的视频轨剪进关系写成 .edl，
 * 给达芬奇 / PR / EE 对剪用。返回事件条数。
 */
export function exportEdl(sequenceId: string, path: string): Promise<number> {
  return invoke<number>("export_edl", { sequenceId, path });
}

/** 导出进度事件的载荷 */
export interface ExportProgressPayload {
  jobId: string;
  frame: number;
  totalFrames: number;
  etaMs: number;
  stage: string;
}

/** 开始导出，返回任务 id */
export function startExport(
  sequenceId: string,
  preset: string,
  outputPath: string,
  range: ExportRange
): Promise<{ jobId: string }> {
  return invoke<{ jobId: string }>("start_export", {
    sequenceId,
    preset,
    outputPath,
    range,
  });
}

/** 取消导出 */
export function cancelExport(jobId: string): Promise<boolean> {
  return invoke<boolean>("cancel_export", { jobId });
}

/** 暂停导出 */
export function pauseExport(jobId: string): Promise<boolean> {
  return invoke<boolean>("pause_export", { jobId });
}

/** 继续导出 */
export function resumeExport(jobId: string): Promise<boolean> {
  return invoke<boolean>("resume_export", { jobId });
}

/** 取导出预设列表 */
export function listExportPresets(): Promise<ExportPreset[]> {
  return invoke<ExportPreset[]>("list_export_presets");
}

/** 订阅导出进度事件 */
export function onExportProgress(
  handler: (payload: ExportProgressPayload) => void
): Promise<UnlistenFn> {
  return listen<ExportProgressPayload>("export://progress", (event) =>
    handler(event.payload)
  );
}
