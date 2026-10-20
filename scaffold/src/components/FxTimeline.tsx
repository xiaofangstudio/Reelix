/**
 * 特效页的时间轴（EC 参考 风格：图层名 + 开关列 + Parent&Link + 帧标尺）。
 * 与剪辑页的 TimelineView 是两套东西：这里按「图层」组织（V1/V2/A1…），
 * 开关列全部接真实状态（隐藏/静音/独奏/锁定都走后端 set_track_flags）。
 * 帧标尺用与剪辑页共享的 zoomLevel，Ctrl+滚轮缩放。
 */

import { Fragment, useMemo, useState } from "react";
import { useAppStore, useCurrentSequence } from "../store/appStore";
import { timeline as timelineApi } from "../services";
import { refreshProject } from "../store/projectActions";
import { msToTimecode } from "../core/timecode";
import type { Track } from "../types/project";
import { IconEye, IconSpeaker, IconSolo, IconLock } from "./icons";

/** 帧标尺的刻度密度（每多少帧一个数字） */
const FRAME_STEP = 30;

export function FxTimeline() {
  const sequence = useCurrentSequence();
  const zoomLevel = useAppStore((s) => s.zoomLevel);
  const selectedClipId = useAppStore((s) => s.selectedClipId);
  const selectClip = useAppStore((s) => s.selectClip);

  const pxPerMs = zoomLevel;
  const frameRate = sequence?.frameRate ?? 25;

  /** 时间标尺的刻度（按帧） */
  const ticks = useMemo(() => {
    if (!sequence) return [];
    const totalFrames = Math.ceil(sequence.durationMs / (1000 / frameRate));
    const out: Array<{ frame: number; left: number }> = [];
    for (let f = 0; f <= totalFrames + FRAME_STEP; f += FRAME_STEP) {
      out.push({ frame: f, left: f * (1000 / frameRate) * pxPerMs });
    }
    return out;
  }, [sequence, frameRate, pxPerMs]);

  if (!sequence) {
    return (
      <div className="fx-timeline">
        <div className="tl-empty">还没有序列</div>
      </div>
    );
  }

  /** 切轨道开关：真调后端 */
  const toggleFlag = async (
    trackId: string,
    key: "muted" | "solo" | "locked" | "hidden",
    value: boolean
  ) => {
    try {
      await timelineApi.setTrackFlags(trackId, { [key]: value } as Record<string, boolean>);
      await refreshProject();
    } catch {
      useAppStore.getState().pushNotice("error", "切换轨道开关失败");
    }
  };

  /** 图层显示名：V1/V2…、A1/A2… */
  const layerName = (kind: string, index: number) => {
    const vCount = sequence.tracks.filter((t) => t.kind === "video").length;
    // AE 的时间轴是图层列表（图层 1、图层 2…），没有 V1/A1 配对；音频单独编号
    if (kind === "video") return `\u56fe\u5c42 ${vCount - index}`;
    const aCount = sequence.tracks.filter((t) => t.kind === "audio").length;
    if (kind === "audio") return `\u97f3\u9891 ${aCount - index}`;
    return kind === "subtitle" ? "字幕" : "摄像机";
  };

  const contentWidth = Math.max(sequence.durationMs * pxPerMs + 200, 600);
  /** 展开属性的图层（AE 式：点箭头就地展开属性列） */
  const [expandedTrackId, setExpandedTrackId] = useState<string | null>(null);

  return (
    <div className="fx-timeline">
      {/* Transport 条：逐帧 / 播放 / 时间码（用户要求挪到时间轴上方，别放属性面板里） */}
      <div className="fx-tl-transport">
        <button
          type="button"
          className="fx-tl-trans-btn"
          title="上一帧（←）"
          onClick={() => {
            const s = useAppStore.getState();
            s.pause();
            s.setPlayhead(Math.max(0, s.playheadMs - 1000 / (sequence.frameRate || 25)));
          }}
        >
          ◀|
        </button>
        <button
          type="button"
          className="fx-tl-trans-btn fx-tl-trans-play"
          title="播放 / 暂停（空格）"
          onClick={() => useAppStore.getState().togglePlaying()}
        >
          ▶
        </button>
        <button
          type="button"
          className="fx-tl-trans-btn"
          title="下一帧（→）"
          onClick={() => {
            const s = useAppStore.getState();
            s.pause();
            s.setPlayhead(Math.min(s.project?.sequences[0]?.durationMs ?? 0, s.playheadMs + 1000 / (sequence.frameRate || 25)));
          }}
        >
          |▶
        </button>
        <span className="fx-tl-trans-tc">
          {msToTimecode(useAppStore.getState().playheadMs, sequence.frameRate || 25)}
        </span>
      </div>

      {/* 帧标尺 */}
      <div className="fx-tl-ruler" style={{ width: contentWidth }}>
        {ticks.map((t) => (
          <span key={t.frame} className="fx-tl-tick" style={{ left: t.left }}>
            {String(Math.floor(t.frame / 30)).padStart(2, "0")}:{String(t.frame % 30).padStart(2, "0")}f
          </span>
        ))}
      </div>

      {/* 图层行 */}
      {sequence.tracks.map((track) => (
        <Fragment key={track.id}>
        <div className="fx-tl-row">
          {/* 左：展开箭头 + 图层名 + 开关列 + Parent&Link */}
          <div className="fx-tl-head">
            <button
              type="button"
              className={`fx-tl-expand${expandedTrackId === track.id ? " open" : ""}`}
              title={expandedTrackId === track.id ? "收起属性" : "展开属性（AE 式属性列）"}
              onClick={() => setExpandedTrackId(expandedTrackId === track.id ? null : track.id)}
            >
              ▸
            </button>
            <span className="fx-tl-name">{layerName(track.kind, track.index)}</span>
            <span className="fx-tl-switches">
              {(track.kind === "video" || track.kind === "subtitle") && (
                <button
                  type="button"
                  className={`fx-tl-sw${track.muted ? " off" : ""}`}
                  title="显示 / 隐藏图层"
                  onClick={() => void toggleFlag(track.id, "muted", !track.muted)}
                >
                  <IconEye />
                </button>
              )}
              {track.kind === "audio" && (
                <button
                  type="button"
                  className={`fx-tl-sw${track.muted ? " off" : ""}`}
                  title="静音 / 取消静音"
                  onClick={() => void toggleFlag(track.id, "muted", !track.muted)}
                >
                  <IconSpeaker />
                </button>
              )}
              <button
                type="button"
                className={`fx-tl-sw${track.solo ? " on" : ""}`}
                title="独奏此图层"
                onClick={() => void toggleFlag(track.id, "solo", !track.solo)}
              >
                <IconSolo />
              </button>
              <button
                type="button"
                className={`fx-tl-sw${track.locked ? " off" : ""}`}
                title="锁定 / 解锁图层"
                onClick={() => void toggleFlag(track.id, "locked", !track.locked)}
              >
                <IconLock />
              </button>
            </span>
            <span className="fx-tl-parent" title="父级与链接（暂无）">
              无
            </span>
          </div>

          {/* 右：片段条（可拖动改起点、可拖两侧边缘裁剪） */}
          <div className="fx-tl-lane" style={{ width: contentWidth }}>
            {track.clips.map((clip) => (
              <div
                key={clip.id}
                className={`fx-tl-clip${selectedClipId === clip.id ? " selected" : ""}`}
                style={{
                  left: clip.startMs * pxPerMs,
                  width: Math.max(8, clip.durationMs * pxPerMs),
                }}
                onClick={() => selectClip(clip.id)}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  selectClip(clip.id);
                  const rect = e.currentTarget.getBoundingClientRect();
                  const offsetX = e.clientX - rect.left;
                  const onLeft = offsetX < 6;
                  const onRight = offsetX > rect.width - 6;
                  const kind = onLeft ? "trim-in" : onRight ? "trim-out" : "move";
                  const startX = e.clientX;
                  const baseStart = clip.startMs;
                  const baseIn = clip.inMs;
                  const baseOut = clip.outMs;
                  const move = (ev: PointerEvent) => {
                    const delta = (ev.clientX - startX) / pxPerMs;
                    if (Math.abs(delta) < 1) return;
                    if (kind === "move") {
                      void timelineApi
                        .moveClip(clip.id, Math.max(0, baseStart + delta), track.id)
                        .then(() => refreshProject());
                    } else if (kind === "trim-in") {
                      void timelineApi
                        .trimClip(
                          clip.id,
                          Math.max(0, baseIn + delta),
                          baseOut
                        )
                        .then(() => refreshProject());
                    } else {
                      void timelineApi
                        .trimClip(
                          clip.id,
                          baseIn,
                          Math.max(baseIn + 40, baseOut + delta)
                        )
                        .then(() => refreshProject());
                    }
                  };
                  const up = () => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                  };
                  window.addEventListener("pointermove", move);
                  window.addEventListener("pointerup", up);
                }}
                title="拖动改位置，拖两侧边缘裁剪"
              >
                <span
                  className="fx-tl-clip-edge left"
                  onPointerDown={(e) => e.stopPropagation()}
                  aria-hidden="true"
                />
                <span className="fx-tl-clip-name">{"片段"}</span>
                <span
                  className="fx-tl-clip-edge right"
                  onPointerDown={(e) => e.stopPropagation()}
                  aria-hidden="true"
                />
              </div>
            ))}
          </div>
        </div>
        {/* AE 式属性行：展开图层后在左侧列就地列出属性（不是全塞右列） */}
        {expandedTrackId === track.id && (
          <FxPropRows track={track} contentWidth={contentWidth} />
        )}
        </Fragment>
      ))}
    </div>
  );
}

/** 图层展开后的属性行（AE 式）：左属性名 + 右时间条上打关键帧菱形 */
function FxPropRows({
  track,
  contentWidth,
}: {
  track: Track;
  contentWidth: number;
}) {
  const playheadMs = useAppStore((s) => s.playheadMs);
  const selectedClipId = useAppStore((s) => s.selectedClipId);
  const upsertEffectKeyframe = useAppStore((s) => s.upsertEffectKeyframe);

  const isCamera = track.kind === "camera";
  const clip = track.clips.find((c) => c.id === selectedClipId) ?? track.clips[0];
  const transform = clip?.transform3D ?? { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1, opacity: 1 };

  const props: Array<{ key: string; label: string; value: number }> = isCamera
    ? [
        { key: "focalLength", label: "焦距", value: 35 },
        { key: "positionX", label: "位置 X", value: transform.position.x },
        { key: "positionY", label: "位置 Y", value: transform.position.y },
        { key: "positionZ", label: "位置 Z", value: transform.position.z },
        { key: "rotationY", label: "旋转 Y", value: transform.rotation.y },
      ]
    : [
        { key: "positionX", label: "位置 X", value: transform.position.x },
        { key: "positionY", label: "位置 Y", value: transform.position.y },
        { key: "scale", label: "缩放", value: transform.scale * 100 },
        { key: "rotationZ", label: "旋转", value: transform.rotation.z },
        { key: "opacity", label: "不透明度", value: 100 },
      ];

  return (
    <>
      {props.map((p) => (
        <div key={p.key} className="fx-tl-row fx-tl-prop-row">
          <div className="fx-tl-head fx-tl-prop-head">
            <span className="fx-tl-prop-name">{p.label}</span>
            <button
              type="button"
              className="fx-tl-kf"
              title="在播放头处打关键帧"
              disabled={!clip}
              onClick={() => {
                if (!clip) return;
                upsertEffectKeyframe(clip.id, p.key, playheadMs, p.value);
              }}
            >
              ◇
            </button>
            <span className="fx-tl-prop-val">{Math.round(p.value * 100) / 100}</span>
          </div>
          <div className="fx-tl-lane fx-tl-prop-lane" style={{ width: contentWidth, background: "transparent" }} />
        </div>
      ))}
    </>
  );
}
