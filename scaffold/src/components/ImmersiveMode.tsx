/**
 * 沉浸模式（独家功能，别家没有）：
 *
 * 打开 3D 空间场景 → 选中素材 → 右键「进入沉浸模式」→ 全屏 3D 操作台：
 * - **W/A/S/D** 前后左右移动，**空格** 上升，**Ctrl** 下降，**Q/E** 左右转向；
 * - 摄像机素材时调整的是摄像机自己的位置；
 * - 移动**同步打关键帧**（位置 XYZ 三个参数在播放头处持续记录）；
 * - Esc 退出。
 *
 * 视图是示意图（俯视网格 + 实时坐标），真 3D 渲染要等 GPU 管线。
 */

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";

export function ImmersiveMode() {
  const immersiveClipId = useAppStore((s) => s.immersiveClipId);
  const setImmersiveClipId = useAppStore((s) => s.setImmersiveClipId);
  const clip = useAppStore((s) => {
    if (!s.immersiveClipId || !s.project) return null;
    for (const seq of s.project.sequences) {
      for (const track of seq.tracks) {
        const found = track.clips.find((c) => c.id === s.immersiveClipId);
        if (found) return found;
      }
    }
    return null;
  });
  const transform = clip?.transform3D ?? null;
  const isCamera = useAppStore((s) => {
    if (!s.immersiveClipId || !s.project) return false;
    for (const seq of s.project.sequences) {
      for (const track of seq.tracks) {
        if (track.clips.some((c) => c.id === s.immersiveClipId)) {
          return track.kind === "camera";
        }
      }
    }
    return false;
  });
  const setClipTransform3D = useAppStore((s) => s.setClipTransform3D);
  const upsertEffectKeyframe = useAppStore((s) => s.upsertEffectKeyframe);
  const playheadMs = useAppStore((s) => s.playheadMs);
  const [hint, setHint] = useState(true);

  // 键盘状态（按住才动）
  const keys = useRef<Set<string>>(new Set());
  // 位置权威值（避免每帧读 store 旧值）
  const pos = useRef({ x: 0, y: 0, z: 0 });
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (!immersiveClipId) return;
    if (transform) {
      pos.current = { ...transform.position };
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setImmersiveClipId(null);
        return;
      }
      keys.current.add(e.key.toLowerCase());
      // 防止空格滚动页面
      if (e.key === " ") e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keys.current.delete(e.key.toLowerCase());
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // 每帧按按住的键移动，并同步打关键帧
    const tick = () => {
      const k = keys.current;
      const speed = k.has("shift") ? 20 : 5; // Shift 加速
      let dx = 0;
      let dy = 0;
      let dz = 0;
      if (k.has("w")) dz -= speed;
      if (k.has("s")) dz += speed;
      if (k.has("a")) dx -= speed;
      if (k.has("d")) dx += speed;
      if (k.has(" ")) dy -= speed; // 空格上升
      if (k.has("control")) dy += speed; // Ctrl 下降
      if (dx !== 0 || dy !== 0 || dz !== 0) {
        pos.current = {
          x: pos.current.x + dx,
          y: pos.current.y + dy,
          z: pos.current.z + dz,
        };
        setClipTransform3D(immersiveClipId, { position: { ...pos.current } });
        // 同步打关键帧（位置 XYZ 三参数）
        upsertEffectKeyframe(immersiveClipId, "positionX", playheadMs, pos.current.x);
        upsertEffectKeyframe(immersiveClipId, "positionY", playheadMs, pos.current.y);
        upsertEffectKeyframe(immersiveClipId, "positionZ", playheadMs, pos.current.z);
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [immersiveClipId]);

  if (!immersiveClipId || !clip) return null;

  const p = pos.current;

  return (
    <div className="immersive" role="dialog" aria-label="沉浸模式">
      <div className="immersive-head">
        <span className="immersive-title">
          沉浸模式 · {isCamera ? "摄像机" : "素材"} {clip.id.slice(0, 6)}
        </span>
        <span className="immersive-coords">
          X {p.x.toFixed(1)} · Y {p.y.toFixed(1)} · Z {p.z.toFixed(1)}
        </span>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setImmersiveClipId(null)}
        >
          退出（Esc）
        </button>
      </div>

      {/* 俯视网格示意图 */}
      <div className="immersive-stage">
        <div
          className="immersive-grid"
          style={{
            backgroundPosition: `${50 + p.x * 2}% ${50 + p.z * 2}%`,
          }}
        />
        <div
          className="immersive-marker"
          style={{
            left: `${50 + p.x * 0.5}%`,
            top: `${50 + p.z * 0.5}%`,
          }}
        />
        <div className="immersive-readout">
          <div>X {p.x.toFixed(1)}</div>
          <div>Y {p.y.toFixed(1)}</div>
          <div>Z {p.z.toFixed(1)}</div>
        </div>
      </div>

      {hint && (
        <div className="immersive-hint" onClick={() => setHint(false)}>
          <b>操作</b>：W/A/S/D 前后左右 · 空格 上升 · Ctrl 下降 · Shift 加速 ·
          移动会同步打位置关键帧 · Esc 退出
        </div>
      )}
    </div>
  );
}
