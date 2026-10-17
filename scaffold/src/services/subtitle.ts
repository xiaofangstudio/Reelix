/**
 * 字幕服务。对应 `commands/subtitle.rs`。
 *
 * 识别全程在本机跑（sherpa-onnx + SenseVoice），不联网、不上传素材。
 * 命令改的是后端工程数据，改完必须重新拉快照回填。
 */

import { invoke } from "@tauri-apps/api/core";
import type { Clip, Id } from "../types/project";

/** 一条识别结果，时间单位毫秒，相对序列时间线 */
export interface SubtitleSegment {
  startMs: number;
  endMs: number;
  text: string;
}

/** 本地语音识别组件的安装状态 */
export interface AsrStatus {
  available: boolean;
  binary: string;
  modelDir: string;
  detail: string;
}

/** 查询本地识别组件是否就位 */
export function asrStatus(): Promise<AsrStatus> {
  return invoke<AsrStatus>("asr_status");
}

/** 对某个视频片段抽音识别，返回时间线对齐的字幕段（尚未写入轨道） */
export function generateSubtitles(clipId: Id): Promise<SubtitleSegment[]> {
  return invoke<SubtitleSegment[]>("generate_subtitles", { clipId });
}

/** 把识别结果写进字幕轨（没有就新建），返回写入条数 */
export function applySubtitles(
  sequenceId: Id,
  segments: SubtitleSegment[]
): Promise<number> {
  return invoke<number>("apply_subtitles", { sequenceId, segments });
}

/** 手工加一条字幕片段 */
export function addSubtitleClip(
  sequenceId: Id,
  startMs: number,
  durationMs: number,
  text: string
): Promise<Clip> {
  return invoke<Clip>("add_subtitle_clip", { sequenceId, startMs, durationMs, text });
}

/** 改字幕文字；空串等于删掉文字 */
export function setClipText(clipId: Id, text: string): Promise<boolean> {
  return invoke<boolean>("set_clip_text", { clipId, text });
}
