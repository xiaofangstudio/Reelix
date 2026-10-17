/**
 * 时间码处理。数字一律用等宽字体显示。
 */

/** 毫秒转 HH:MM:SS:FF */
export function msToTimecode(ms: number, frameRate: number): string {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.floor(safe / 1000);
  const frames = Math.floor(((safe % 1000) / 1000) * frameRate);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(frames)}`;
}

/** 毫秒转 MM:SS */
export function msToShort(ms: number): string {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.floor(safe / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${pad(m)}:${pad(s)}`;
}

/** 毫秒转「1 分 20 秒」这种中文表述，用于提示文案 */
export function msToChinese(ms: number): string {
  const safe = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  if (m === 0) return `${s} 秒`;
  if (s === 0) return `${m} 分`;
  return `${m} 分 ${s} 秒`;
}

/** 毫秒对齐到帧 */
export function snapToFrame(ms: number, frameRate: number): number {
  const frameMs = 1000 / frameRate;
  return Math.round(ms / frameMs) * frameMs;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}