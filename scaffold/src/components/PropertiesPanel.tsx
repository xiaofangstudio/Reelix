/**
 * 属性面板。跟着选中态走：选中片段（图层）→ 显示片段信息、3D 图层与效果栈。
 *
 * 面板顶部固定嵌入「效果栈」——图层式界面里，效果不是画在内部图上的节点，
 * 而是挂在当前图层身上、从上到下依次叠加的一串效果。所以这里不需要
 * 「选节点才出参数」那一套，选中的片段本身就是效果参数的归属。
 *
 * 图层 3D 变换见 docs/09-3D摄像机与素材库.md 第 2.3 节：
 * 片段勾选「启用 3D」后多出六组属性（位置/旋转/缩放/方向/锚点/接受光照）。
 */

import { useEffect, useState } from "react";
import { useAppStore, useAssets, useCurrentSequence, useSelectedClip } from "../store/appStore";
import { msToTimecode } from "../core/timecode";
import type { Layer3DOrientation } from "../types/project";
import {
  addSubtitleAtPlayhead,
  generateSubtitlesForClip,
  updateClipText,
} from "../store/projectActions";
import { EffectStack } from "./EffectStack";

/** 图层方向（docs/09 第 2.3 节）：朝向相机自动转向 / 自由朝向。 */
const ORIENTATION_OPTIONS: Array<{ value: Layer3DOrientation; label: string }> = [
  { value: "camera", label: "朝向相机" },
  { value: "free", label: "自由朝向" },
];

export function PropertiesPanel() {
  const clip = useSelectedClip();
  const assets = useAssets();
  const sequence = useCurrentSequence();
  const setClip3DEnabled = useAppStore((s) => s.setClip3DEnabled);
  const setClipTransform3D = useAppStore((s) => s.setClipTransform3D);

  // 没有工程 / 序列时也能显示面板骨架，时间码用默认帧率兜底
  const frameRate = sequence?.frameRate ?? 25;

  const assetName = clip
    ? assets.find((a) => a.id === clip.assetId)?.name ?? "未知素材"
    : "";

  // 摄像机轨道上的片段代表摄像机本身，不是可做 3D 变换的图层。
  const track =
    clip && sequence ? sequence.tracks.find((t) => t.id === clip.trackId) : undefined;
  const isLayerClip = !!clip && track?.kind !== "camera";
  const isSubtitleClip = !!clip && track?.kind === "subtitle";
  const transform = clip?.transform3D;

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="title">属性</span>
      </div>

      <div className="panel-body">
        {/* 效果栈永远在最顶部：图层式界面的第一屏就是「这层挂了哪些效果」 */}
        <EffectStack />

        {!clip ? (
          <div className="empty-state">
            <div className="icon">◇</div>
            <div className="main-text">未选中任何图层</div>
            <div className="sub-text">在时间线上点一个片段，效果栈与参数会出现在这里</div>
          </div>
        ) : (
          <>
            <div className="prop-group">
              <div className="group-title">片段</div>
              <TextRow
                label="名称"
                text={
                  isSubtitleClip
                    ? "字幕"
                    : track?.kind === "camera"
                      ? "摄像机"
                      : assetName
                }
              />
              <TextRow
                label="入点"
                text={msToTimecode(clip.inMs, frameRate)}
              />
              <TextRow
                label="出点"
                text={msToTimecode(clip.outMs, frameRate)}
              />
              <TextRow
                label="时长"
                text={msToTimecode(clip.durationMs, frameRate)}
              />
              <TextRow label="速度" text={`${clip.speed.toFixed(2)}×`} />
              <TextRow label="反向" text={clip.reversed ? "是" : "否"} />
              <TextRow label="所在轨道" text={clip.trackId} />
            </div>

            {/* 字幕：字幕片段就地改字；视频片段可本机识别语音，结果落到字幕轨 */}
            {isSubtitleClip ? (
              <div className="prop-group">
                <div className="group-title">字幕文字</div>
                <SubtitleTextEditor clipId={clip.id} text={clip.text ?? ""} />
                <button
                  type="button"
                  className="curve-btn subtitle-add"
                  onClick={() => void addSubtitleAtPlayhead()}
                >
                  在播放头处再加一条
                </button>
              </div>
            ) : track?.kind === "video" ? (
              <div className="prop-group">
                <div className="group-title">字幕</div>
                <button
                  type="button"
                  className="curve-btn subtitle-add"
                  onClick={() => void generateSubtitlesForClip(clip.id)}
                >
                  识别语音生成字幕
                </button>
                <div className="tl-empty">本机离线识别，结果自动落到字幕轨</div>
              </div>
            ) : null}

            {/* 图层 3D：仅视频/图片等图层片段可勾选，摄像机片段不显示（docs/09 第 2.3 节） */}
            {isLayerClip && (
              <div className="prop-group">
                <div className="group-title">3D 图层</div>

                <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
                  <span className="label">启用 3D</span>
                  <button
                    type="button"
                    className="curve-btn"
                    style={{ width: "auto", padding: "0 8px" }}
                    onClick={() => setClip3DEnabled(clip.id, !clip.enable3D)}
                  >
                    {clip.enable3D ? "已启用 · 点击关闭" : "未启用 · 点击启用"}
                  </button>
                </div>

                {clip.enable3D && transform ? (
                  <>
                    <Vec3Row
                      label="位置"
                      value={transform.position}
                      onChange={(patch) =>
                        setClipTransform3D(clip.id, { position: patch })
                      }
                    />
                    <Vec3Row
                      label="旋转"
                      value={transform.rotation}
                      onChange={(patch) =>
                        setClipTransform3D(clip.id, { rotation: patch })
                      }
                    />

                    <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
                      <span className="label">缩放</span>
                      <input
                        className="value num"
                        type="number"
                        step={0.01}
                        value={transform.scale}
                        onChange={(e) =>
                          setClipTransform3D(clip.id, {
                            scale: Number(e.target.value),
                          })
                        }
                      />
                    </div>

                    <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
                      <span className="label">方向</span>
                      <select
                        className="value"
                        value={transform.orientation}
                        onChange={(e) =>
                          setClipTransform3D(clip.id, {
                            orientation: e.target.value as Layer3DOrientation,
                          })
                        }
                      >
                        {ORIENTATION_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <Vec2Row
                      label="锚点"
                      value={transform.anchor}
                      onChange={(patch) =>
                        setClipTransform3D(clip.id, { anchor: patch })
                      }
                    />

                    <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
                      <span className="label">接受光照</span>
                      <button
                        type="button"
                        className="curve-btn"
                        style={{ width: "auto", padding: "0 8px" }}
                        onClick={() =>
                          setClipTransform3D(clip.id, {
                            receiveLight: !transform.receiveLight,
                          })
                        }
                      >
                        {transform.receiveLight ? "开" : "关"}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="tl-empty">未启用 3D，图层老实待在 Z=0 平面</div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** 字幕文字编辑：失焦或点「应用」时写回后端，返回的权威快照会刷新草稿。 */
function SubtitleTextEditor({ clipId, text }: { clipId: string; text: string }) {
  const [draft, setDraft] = useState(text);
  useEffect(() => {
    setDraft(text);
  }, [clipId, text]);

  return (
    <>
      <textarea
        className="subtitle-input"
        rows={3}
        value={draft}
        placeholder="输入字幕文字…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== text) void updateClipText(clipId, draft);
        }}
      />
      <button
        type="button"
        className="curve-btn subtitle-add"
        onClick={() => void updateClipText(clipId, draft)}
      >
        应用文字
      </button>
    </>
  );
}

function TextRow({ label, text }: { label: string; text: string }) {
  return (
    <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
      <span className="label">{label}</span>
      <span className="label num" title={text}>
        {text}
      </span>
    </div>
  );
}

/** 三分量（X/Y/Z）数值行，位置与旋转共用。 */
function Vec3Row({
  label,
  value,
  onChange,
}: {
  label: string;
  value: { x: number; y: number; z: number };
  onChange: (patch: Partial<{ x: number; y: number; z: number }>) => void;
}) {
  return (
    <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
      <span className="label">{label}</span>
      <div className="vec3">
        {(["x", "y", "z"] as const).map((axis) => (
          <label key={axis} className="vec3-cell">
            <span className="axis">{axis.toUpperCase()}</span>
            <input
              className="value num"
              type="number"
              step={1}
              value={value[axis]}
              onChange={(e) => onChange({ [axis]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

/** 两分量（X/Y）数值行，锚点用，归一化 0~1。 */
function Vec2Row({
  label,
  value,
  onChange,
}: {
  label: string;
  value: { x: number; y: number };
  onChange: (patch: Partial<{ x: number; y: number }>) => void;
}) {
  return (
    <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
      <span className="label">{label}</span>
      <div className="vec3">
        {(["x", "y"] as const).map((axis) => (
          <label key={axis} className="vec3-cell">
            <span className="axis">{axis.toUpperCase()}</span>
            <input
              className="value num"
              type="number"
              step={0.01}
              value={value[axis]}
              onChange={(e) => onChange({ [axis]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
