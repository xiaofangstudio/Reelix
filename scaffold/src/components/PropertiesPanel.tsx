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
import { ColorGradeControls } from "./ColorGradePanel";
import { SpeedCurveEditor } from "./SpeedCurveEditor";
import { useAppStore, useAssets, useCurrentSequence, useSelectedClip } from "../store/appStore";
import { msToTimecode } from "../core/timecode";
import type { Layer3DOrientation } from "../types/project";
import {
  addSubtitleAtPlayhead,
  generateSubtitlesForClip,
  refreshProject,
  setClipTransition,
  setClipTransitionOut,
  updateClipText,
} from "../store/projectActions";
import { EffectStack } from "./EffectStack";

/** 图层方向（docs/09 第 2.3 节）：朝向相机自动转向 / 自由朝向。 */
const ORIENTATION_OPTIONS: Array<{ value: Layer3DOrientation; label: string }> = [
  { value: "camera", label: "朝向相机" },
  { value: "free", label: "自由朝向" },
];

/** 调色页门槛：选中片段必须「画面上可见」（视频/字幕轨），音频与摄像机不行。 */
function ColorGate({ children }: { children: React.ReactNode }) {
  const clip = useSelectedClip();
  const sequence = useCurrentSequence();
  const track = clip && sequence ? sequence.tracks.find((t) => t.id === clip.trackId) : undefined;
  const visible = !!clip && (track?.kind === "video" || track?.kind === "subtitle");
  if (!visible) {
    return (
      <div className="empty-state">
        <div className="icon">◐</div>
        <div className="main-text">当前片段不能调色</div>
        <div className="sub-text">
          {clip ? "音频与摄像机不出现在画面上。选中视频、图片或文字片段再来。" : "先选中一个会出现在画面里的片段。"}
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

export function PropertiesPanel() {
  const clip = useSelectedClip();
  const effects = useAppStore((s) => s.effects);
  const assets = useAssets();
  const sequence = useCurrentSequence();
  const setClip3DEnabled = useAppStore((s) => s.setClip3DEnabled);
  const setClipTransform3D = useAppStore((s) => s.setClipTransform3D);

  /**
   * 属性面板顶部小页签（剪映式：属性右上就是调色，不占底部 Tab）。
   * 视频类片段：基础 / 调节 / 变速 / 音频 / 3D；音频片段：变速 / 音频。
   * 切换片段时页签回落到「基础」。
   */
  const [propTab, setPropTab] = useState<string>("basic");
  useEffect(() => {
    setPropTab("basic");
  }, [clip?.id]);

  // 没有工程 / 序列时也能显示面板骨架，时间码用默认帧率兜底
  const frameRate = sequence?.frameRate ?? 25;

  const assetName = clip
    ? assets.find((a) => a.id === clip.assetId)?.name ?? "未知素材"
    : "";

  // 摄像机轨道上的片段代表摄像机本身，不是可做 3D 变换的图层。
  const track =
    clip && sequence ? sequence.tracks.find((t) => t.id === clip.trackId) : undefined;
  const isLayerClip = !!clip && track?.kind !== "camera";
  const isCameraClip = !!clip && track?.kind === "camera";
  const isSubtitleClip = !!clip && track?.kind === "subtitle";
  const transform = clip?.transform3D;

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="title">属性</span>
      </div>

      <div className="panel-body">
        {/* 属性面板顶部小页签（剪映式）：调色就住在「调节」页里 */}
        {clip && (
          <div className="prop-tabs">
            {[
              ["basic", "基础", true],
              ["grade", "调节", !isCameraClip],
              ["speed", "变速", !isCameraClip],
              ["audio", "音频", !isCameraClip],
              ["3d", "3D", !isCameraClip],
            ]
              .filter(([, , show]) => show)
              .map(([key, label]) => (
                <button
                  key={key as string}
                  type="button"
                  className={propTab === key ? "on" : ""}
                  onClick={() => setPropTab(key as string)}
                >
                  {label as string}
                </button>
              ))}
          </div>
        )}

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

            {/* 转场：改类型、调时长、应用到全部（用户要的剪映式转场属性） */}
            {clip && (
              <div className="prop-group">
                <div className="group-title">转场</div>
                <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
                  <span className="label">类型</span>
                  <select
                    className="value num"
                    value={clip.transitionIn?.kind ?? "none"}
                    onChange={(e) => {
                      const v = e.target.value;
                      void setClipTransition(
                        clip.id,
                        v === "none"
                          ? null
                          : (v as "crossDissolve" | "dipToBlack" | "dipToWhite"),
                        clip.transitionIn?.durationMs ?? 500
                      );
                    }}
                  >
                    <option value="none">无</option>
                    <option value="crossDissolve">交叉溶解</option>
                    <option value="dipToBlack">闪黑</option>
                    <option value="dipToWhite">闪白</option>
                  </select>
                </div>
                {clip.transitionIn && (
                  <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
                    <span className="label">时长（ms）</span>
                    <input
                      className="value num"
                      type="number"
                      min={1}
                      max={Math.max(1, Math.round(clip.durationMs))}
                      step={50}
                      value={clip.transitionIn.durationMs}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isNaN(v)) {
                          void setClipTransition(
                            clip.id,
                            clip.transitionIn!.kind,
                            Math.max(1, Math.min(clip.durationMs, v))
                          );
                        }
                      }}
                    />
                  </div>
                )}
                <button
                  type="button"
                  className="curve-btn subtitle-add"
                  disabled={!clip.transitionIn}
                  title="把当前转场（类型+时长）套到时间线上全部片段"
                  onClick={() => {
                    const st = useAppStore.getState();
                    const seq = st.project?.sequences[0];
                    if (!seq || !clip.transitionIn) return;
                    let n = 0;
                    for (const track of seq.tracks) {
                      for (const c of track.clips) {
                        if (c.id === clip.id) continue;
                        void setClipTransition(c.id, clip.transitionIn.kind, clip.transitionIn.durationMs);
                        n += 1;
                      }
                    }
                    st.pushNotice("info", `转场已应用到 ${n} 个片段`);
                  }}
                >
                  应用到全部片段
                </button>
              </div>
            )}

            {/* 淡出：片段末尾向黑/白渐隐。挂在片段属性上，不进效果栈 */}
            {clip && (
              <div className="prop-group">
                <div className="group-title">淡出</div>
                <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
                  <span className="label">类型</span>
                  <select
                    className="value num"
                    value={clip.transitionOut?.kind ?? "none"}
                    onChange={(e) => {
                      const v = e.target.value;
                      void setClipTransitionOut(
                        clip.id,
                        v === "none" ? null : (v as "dipToBlack" | "dipToWhite"),
                        clip.transitionOut?.durationMs ?? 500
                      );
                    }}
                  >
                    <option value="none">无</option>
                    <option value="dipToBlack">淡入黑场</option>
                    <option value="dipToWhite">淡入白场</option>
                  </select>
                </div>
                {clip.transitionOut && (
                  <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
                    <span className="label">时长（ms）</span>
                    <input
                      className="value num"
                      type="number"
                      min={1}
                      max={Math.max(1, Math.round(clip.durationMs))}
                      step={50}
                      value={clip.transitionOut.durationMs}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isNaN(v)) {
                          void setClipTransitionOut(
                            clip.id,
                            clip.transitionOut!.kind,
                            Math.max(1, Math.min(clip.durationMs, v))
                          );
                        }
                      }}
                    />
                  </div>
                )}
              </div>
            )}


            {propTab === "basic" && <>
            {/* 基础变换（剪映式：位置/缩放/旋转/不透明度/混合模式/翻转）——
                改的是效果栈里 transform / opacity 节点的参数，lazy 创建 */}
            {clip && !isCameraClip && (
              <div className="group-title-wrap">
                <div className="group-title">基础</div>
                {(
                  [
                    ["transform", "posX", "位置 X", -2000, 2000],
                    ["transform", "posY", "位置 Y", -2000, 2000],
                    ["transform", "scale", "缩放 %", 1, 400],
                    ["transform", "rotation", "旋转 °", -360, 360],
                    ["opacity", "opacity", "不透明度 %", 0, 100],
                  ] as const
                ).map(([type, key, label, min, max]) => {
                  const fx = (effects[clip.id] ?? []).find((e) => e.type === type);
                  const val = fx ? Number(fx.params.find((p) => p.key === key)?.value ?? 0) : type === "opacity" ? 100 : key === "scale" ? 100 : 0;
                  return (
                    <div key={type + key} className="prop-row" style={{ gridTemplateColumns: "90px 1fr 44px" }}>
                      <span className="label">{label}</span>
                      <input
                        type="range"
                        min={min}
                        max={max}
                        step={key === "rotation" ? 0.5 : 1}
                        value={val}
                        onChange={(e) => {
                          let eff = (useAppStore.getState().effects[clip.id] ?? []).find((x) => x.type === type);
                          if (!eff) {
                            useAppStore.getState().addEffect(clip.id, type);
                            eff = (useAppStore.getState().effects[clip.id] ?? []).find((x) => x.type === type);
                          }
                          if (eff) useAppStore.getState().setEffectParam(eff.id, key, Number(e.target.value));
                        }}
                      />
                      <em className="prop-num">{val}</em>
                    </div>
                  );
                })}
                <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
                  <span className="label">混合模式</span>
                  <select
                    className="value"
                    value={(() => {
                      const fx = (effects[clip.id] ?? []).find((e) => e.type === "blendSingle");
                      return String(fx?.params.find((p) => p.key === "mode")?.value ?? "normal");
                    })()}
                    onChange={(e) => {
                      let eff = (useAppStore.getState().effects[clip.id] ?? []).find((x) => x.type === "blendSingle");
                      if (!eff) {
                        useAppStore.getState().addEffect(clip.id, "blendSingle");
                        eff = (useAppStore.getState().effects[clip.id] ?? []).find((x) => x.type === "blendSingle");
                      }
                      if (eff) useAppStore.getState().setEffectParam(eff.id, "mode", e.target.value);
                    }}
                  >
                    {["normal", "multiply", "screen", "overlay", "darken", "lighten"].map((m) => (
                      <option key={m} value={m}>
                        {{ normal: "正常", multiply: "正片叠底", screen: "滤色", overlay: "叠加", darken: "变暗", lighten: "变亮" }[m]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr 1fr" }}>
                  <span className="label">镜像</span>
                  <button
                    type="button"
                    className={`ctl-btn${(effects[clip.id] ?? []).find((e) => e.type === "mirror" && e.params.find((p) => p.key === "axis")?.value === "h") ? " on" : ""}`}
                    onClick={() => {
                      const st = useAppStore.getState();
                      const ex = (st.effects[clip.id] ?? []).find((e) => e.type === "mirror" && e.params.find((p) => p.key === "axis")?.value === "h");
                      if (ex) st.removeEffect(ex.id);
                      else st.addEffect(clip.id, "mirror");
                    }}
                  >
                    左右翻转
                  </button>
                  <button
                    type="button"
                    className={`ctl-btn${(effects[clip.id] ?? []).find((e) => e.type === "mirror" && e.params.find((p) => p.key === "axis")?.value === "v") ? " on" : ""}`}
                    onClick={() => {
                      const st = useAppStore.getState();
                      const ex = (st.effects[clip.id] ?? []).find((e) => e.type === "mirror" && e.params.find((p) => p.key === "axis")?.value === "v");
                      if (ex) st.removeEffect(ex.id);
                      else {
                        st.addEffect(clip.id, "mirror");
                        const created = (useAppStore.getState().effects[clip.id] ?? []).slice(-1)[0];
                        if (created) st.setEffectParam(created.id, "axis", "v");
                      }
                    }}
                  >
                    上下翻转
                  </button>
                </div>
              </div>
            )}
            </>}

            {/* 调节页 = 调色（色轮/色阶/快捷 + 示波器 + 颜色占比）。
                门槛（用户规则）：只对画面可见片段开放，音频与摄像机显示引导文案 */}
            {propTab === "grade" && (
              <ColorGate>
                <ColorGradeControls />
              </ColorGate>
            )}
            {propTab === "speed" && <>
            {/* 变速（剪映式：速度滑条 + 倒放开关 + 声音变调 + 曲线变速） */}
            {clip && !isCameraClip && (
              <div className="group-title-wrap">
                <div className="group-title">变速</div>
                <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr 44px" }}>
                  <span className="label">速度 ×</span>
                  <input
                    type="range"
                    min={0.1}
                    max={4}
                    step={0.05}
                    value={clip.speed}
                    onChange={(e) => {
                      void (async () => {
                        try {
                          const { timeline } = await import("../services");
                          await timeline.setClipSpeed(clip.id, Number(e.target.value));
                          await refreshProject();
                        } catch (err) {
                          useAppStore.getState().pushNotice("error", err instanceof Error ? err.message : String(err));
                        }
                      })();
                    }}
                  />
                  <em className="prop-num">{clip.speed.toFixed(2)}</em>
                </div>
                <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
                  <span className="label">倒放</span>
                  <button
                    type="button"
                    className={`ctl-btn${clip.reversed ? " on" : ""}`}
                    onClick={() => {
                      void (async () => {
                        try {
                          const { timeline } = await import("../services");
                          await timeline.setClipReversed(clip.id, !clip.reversed);
                          await refreshProject();
                        } catch (err) {
                          useAppStore.getState().pushNotice("error", err instanceof Error ? err.message : String(err));
                        }
                      })();
                    }}
                  >
                    {clip.reversed ? "已倒放" : "正常播放"}
                  </button>
                </div>
                {/* 声音变调（剪映同款）：开 = 音高随速度变；关 = 保调 */}
                <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
                  <span className="label">声音变调</span>
                  <button
                    type="button"
                    className={`ctl-btn${clip.audioPitchShift ? " on" : ""}`}
                    title="开：变速时音高随速度一起变（剪映默认）；关：只改速度不改音高（专业保调）"
                    onClick={() => {
                      void (async () => {
                        try {
                          const { timeline } = await import("../services");
                          await timeline.setClipPitchShift(clip.id, !clip.audioPitchShift);
                          await refreshProject();
                        } catch (err) {
                          useAppStore.getState().pushNotice("error", err instanceof Error ? err.message : String(err));
                        }
                      })();
                    }}
                  >
                    {clip.audioPitchShift ? "已开启（音随速变）" : "关闭（保调）"}
                  </button>
                </div>
                {/* 曲线变速：折线改速度，片段时长按积分重算 */}
                <SpeedCurveEditor clip={clip} />
              </div>
            )}
            </>}

            {propTab === "audio" && <>
            {/* 音频处理：高通/低通/回声（混音时真滤波，用户要求的传统 DSP） */}
            {clip && !isCameraClip && (
              <div className="prop-group">
                <div className="group-title">音频处理</div>
                <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
                  <span className="label">高通 (Hz)</span>
                  <input
                    className="value num"
                    type="number"
                    min={0}
                    max={8000}
                    step={10}
                    placeholder="0 = 关"
                    value={clip.audioHighpassHz ?? ""}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      void setAudioDspSafe(clip.id, v > 20 ? v : null, clip.audioLowpassHz ?? null, clip.audioDelayMs ?? null);
                    }}
                  />
                </div>
                <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
                  <span className="label">低通 (Hz)</span>
                  <input
                    className="value num"
                    type="number"
                    min={0}
                    max={20000}
                    step={100}
                    placeholder="0 = 关"
                    value={clip.audioLowpassHz ?? ""}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      void setAudioDspSafe(clip.id, clip.audioHighpassHz ?? null, v > 20 ? v : null, clip.audioDelayMs ?? null);
                    }}
                  />
                </div>
                <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
                  <span className="label">回声 (ms)</span>
                  <input
                    className="value num"
                    type="number"
                    min={0}
                    max={2000}
                    step={10}
                    placeholder="0 = 关"
                    value={clip.audioDelayMs ?? ""}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      void setAudioDspSafe(clip.id, clip.audioHighpassHz ?? null, clip.audioLowpassHz ?? null, v > 1 ? v : null);
                    }}
                  />
                </div>
              </div>
            )}
            </>}

            {propTab === "3d" && <>
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
                      paramKey="position"
                      clipId={clip.id}
                    />
                    <Vec3Row
                      label="旋转"
                      value={transform.rotation}
                      onChange={(patch) =>
                        setClipTransform3D(clip.id, { rotation: patch })
                      }
                      paramKey="rotation"
                      clipId={clip.id}
                    />

                    {/* 圈数：rotationZ / 360 自动计数（1X = 转满一圈），也可手填圈数。
                        旁边显示当前角度；改圈数 = 角度整体加/减整圈。 */}
                    <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
                      <span className="label">圈数</span>
                      <div className="vec3">
                        <span className="vec3-cell">
                          <span className="axis">圈</span>
                          <input
                            className="value num"
                            type="number"
                            step={1}
                            title="转了几整圈：1X = 一圈，-1X = 反向一圈；角度会跟着自动换算（可填 expr: 表达式）"
                            value={Math.round((transform.rotation.z / 360) * 100) / 100}
                            onChange={(e) => {
                              const turns = Number(e.target.value);
                              if (!Number.isNaN(turns)) {
                                setClipTransform3D(clip.id, {
                                  rotation: { z: turns * 360 },
                                });
                              }
                            }}
                          />
                        </span>
                        <span className="vec3-cell">
                          <span className="axis">角</span>
                          <input
                            className="value num"
                            type="number"
                            step={5}
                            title="旋转角度（Z 轴，度）；可填 expr: 表达式"
                            value={Math.round(transform.rotation.z * 100) / 100}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              if (!Number.isNaN(v)) {
                                setClipTransform3D(clip.id, { rotation: { z: v } });
                              }
                            }}
                          />
                        </span>
                        <span className="vec3-cell turns-readout" title="自动计数的圈数显示">
                          {(() => {
                            const t = transform.rotation.z / 360;
                            const whole = Math.trunc(t);
                            if (Math.abs(t) >= 1) return `${Math.abs(whole)}X${whole < 0 ? " 反向" : ""}`;
                            return "0X";
                          })()}
                        </span>
                      </div>
                    </div>

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
            </>}
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
      {/* 应用到全部：把这条字幕的文字样式套到工程里所有字幕（用户要求） */}
      <button
        type="button"
        className="curve-btn subtitle-add"
        title="把当前字幕的文字与样式应用到全部字幕"
        onClick={() => {
          const s = useAppStore.getState();
          const seq = s.project?.sequences[0];
          if (!seq) return;
          let count = 0;
          for (const track of seq.tracks) {
            if (track.kind !== "subtitle") continue;
            for (const c of track.clips) {
              if (c.id === clipId) continue;
              void updateClipText(c.id, draft);
              count += 1;
            }
          }
          s.pushNotice("info", `已应用到 ${count} 条字幕`);
        }}
      >
        应用到全部字幕
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
/** 可拖拽的数值格：按住左右拖改值（AE 的 XYZ 拖拽习惯），双击可键盘输入 */
function DragNum({
  axis,
  value,
  onChange,
}: {
  axis: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    if (!editing) setDraft(String(Math.round(value * 100) / 100));
  }, [value, editing]);

  /** 滚轮调值：向上加、向下减（Shift 细调 / Ctrl 粗调），用户要求 */
  const onWheel = (e: React.WheelEvent) => {
    if (editing) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? 0.1 : e.ctrlKey ? 10 : 1;
    onChange(Math.round((value + (e.deltaY < 0 ? step : -step)) * 100) / 100);
  };

  const startDrag = (e: React.PointerEvent) => {
    if (editing) return;
    e.preventDefault();
    const startX = e.clientX;
    const base = value;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      // 每像素 1 单位，Shift 细调（0.1），Ctrl 粗调（10）
      const step = ev.shiftKey ? 0.1 : ev.ctrlKey ? 10 : 1;
      onChange(Math.round((base + dx * step) * 100) / 100);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (editing) {
    return (
      <input
        className="value num"
        type="number"
        step={0.1}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const v = Number(draft);
          if (!Number.isNaN(v)) onChange(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }

  return (
    <input
      className="value num draggable-num"
      type="text"
      value={Math.round(value * 100) / 100}
      title={`${axis}：按住左右拖改值（Shift 细调 / Ctrl 粗调），双击键盘输入`}
      onPointerDown={startDrag}
      onWheel={onWheel}
      onDoubleClick={() => setEditing(true)}
      readOnly
    />
  );
}

function Vec3Row({
  label,
  value,
  onChange,
  paramKey,
  clipId,
}: {
  label: string;
  value: { x: number; y: number; z: number };
  onChange: (patch: Partial<{ x: number; y: number; z: number }>) => void;
  paramKey?: string;
  clipId?: string;
}) {
  return (
    <div className="prop-row" style={{ gridTemplateColumns: "90px 1fr" }}>
      <span className="label">{label}</span>
      <div className="vec3">
        {(["x", "y", "z"] as const).map((axis) => (
          <label key={axis} className="vec3-cell">
            <span className="axis">{axis.toUpperCase()}</span>
            <span className="vec3-kf">
              <DragNum
                axis={axis.toUpperCase()}
                value={value[axis]}
                onChange={(v) => onChange({ [axis]: v })}
              />
              {paramKey && clipId && (
                <button
                  type="button"
                  className="fx-tl-kf"
                  title={"给「" + label + " " + axis.toUpperCase() + "」在播放头处打关键帧"}
                  onClick={() => kf(clipId, paramKey + axis.toUpperCase(), value[axis])}
                >
                  ◇
                </button>
              )}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** 在播放头处给某个参数打关键帧（属性面板的 ◇ 按钮共用） */
function kf(clipId: string, param: string, value: number) {
  const s = useAppStore.getState();
  s.upsertEffectKeyframe(clipId, param, s.playheadMs, value);
  s.pushNotice("info", "已打关键帧");
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

/** 音频 DSP 防抖落库：失败只弹提示不阻塞输入 */
async function setAudioDspSafe(
  clipId: string,
  hp: number | null,
  lp: number | null,
  delay: number | null
): Promise<void> {
  try {
    const { timeline } = await import("../services");
    await timeline.setAudioDsp(clipId, hp, lp, delay);
  } catch (err) {
    useAppStore.getState().pushNotice("error", err instanceof Error ? err.message : String(err));
  }
}
