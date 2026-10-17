/**
 * 时间线服务。
 *
 * 加/移/裁/切/删片段、加/删轨道这些编辑动作全在 Rust 侧完成，
 * 前端只发命令、收回权威结果。这里的函数名与 `commands/timeline.rs` 一一对应，
 * 参数名由 Tauri 按 camelCase 转成 Rust 的 snake_case。
 *
 * 注意：这些命令改的是后端工程数据，改完界面必须重新拉一份快照回填，
 * 不要在前端自己算一遍（裁剪与切割要按速度换算进出点，前端算容易和后端跑偏）。
 */

import { invoke } from "@tauri-apps/api/core";
import type { Clip, Id, Track } from "../types/project";

/** 往指定轨道加一个片段，返回新片段。compoundId 为视/音频链接组 id（可选） */
export function addClip(
  trackId: Id,
  assetId: Id,
  startMs: number,
  durationMs: number,
  compoundId?: Id
): Promise<Clip> {
  return invoke<Clip>("add_clip", {
    trackId,
    assetId,
    startMs,
    durationMs,
    compoundId: compoundId ?? null,
  });
}

/** 移动片段起点；传 trackId 表示跨轨移动 */
export function moveClip(clipId: Id, startMs: number, trackId?: Id): Promise<boolean> {
  return invoke<boolean>("move_clip", { clipId, startMs, trackId: trackId ?? null });
}

/** 裁剪片段：给出素材内的新入点 / 出点 */
export function trimClip(clipId: Id, inMs: number, outMs: number): Promise<boolean> {
  return invoke<boolean>("trim_clip", { clipId, inMs, outMs });
}

/** 在指定时刻切割片段，返回切出来的右半段 */
export function splitClip(clipId: Id, atMs: number): Promise<Clip> {
  return invoke<Clip>("split_clip", { clipId, atMs });
}

/** 批量删除片段 */
export function deleteClips(clipIds: Id[]): Promise<boolean> {
  return invoke<boolean>("delete_clips", { clipIds });
}

/** 设置片段速度，素材范围不变、时间线时长按速度重算 */
export function setClipSpeed(clipId: Id, speed: number): Promise<boolean> {
  return invoke<boolean>("set_clip_speed", { clipId, speed });
}

/** 加一条轨道（视频 / 音频 / 摄像机 / 字幕），默认加到当前序列 */
export function addTrack(kind: Track["kind"], sequenceId?: Id): Promise<Track> {
  return invoke<Track>("add_track", { kind, sequenceId: sequenceId ?? null });
}

/** 删除轨道（连同其上的片段） */
export function removeTrack(trackId: Id): Promise<boolean> {
  return invoke<boolean>("remove_track", { trackId });
}

/** 轨道开关：只传需要改的项，其余保持原值 */
export function setTrackFlags(
  trackId: Id,
  flags: { muted?: boolean; hidden?: boolean; locked?: boolean; solo?: boolean }
): Promise<boolean> {
  return invoke<boolean>("set_track_flags", {
    trackId,
    muted: flags.muted ?? null,
    hidden: flags.hidden ?? null,
    locked: flags.locked ?? null,
    solo: flags.solo ?? null,
  });
}
