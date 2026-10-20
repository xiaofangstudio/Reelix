/**
 * 效果控件（AE「效果控件」+ PR「效果控件」的蒸馏合成）。
 *
 * 结构照两端蒸馏出来的要点：
 * - 顶部是图层头：这一栏属于哪个图层、挂了几个效果（AE 效果控件顶部就是图层名）；
 * - 中部是效果卡片栈，从上到下依次叠加，参数行右侧带 ◀ ◆ ▶ 关键帧导航器
 *   （FC 参考 `key_navigator`：菱形在播放头处增删关键帧，播放头正落在关键帧上时实心；
 *    两侧箭头跳上一个 / 下一个关键帧）；
 * - 底部是选中效果的关键帧泳道，带时间标尺（FC 参考 `paint_ruler` 的做法），
 *   点菱形跳到该关键帧，点空白把播放头挪过去。
 *
 * 与曲线编辑器的关系：曲线编辑器仍是剪辑页时间线的二级页签，这里只管
 * 「打关键帧 / 跳关键帧」这件参数行上的事。
 */

import { useEffect, useMemo, useState } from "react";
import { useAppStore, useCurrentSequence, useSelectedClip } from "../store/appStore";
import { EffectStack, DragNumber } from "./EffectStack";
import { msToTimecode, msToShort } from "../core/timecode";

/** 时间基准：序列时间（与播放头一致）/ 源素材时间（片段内部从 0 起）。
 *  蒸馏自 EC 参考 效果面板的 Source / Sequence 双基准；PR 的效果控件
 *  在嵌套序列片段上也有同样的切换。 */
type TimeBase = "sequence" | "source";

export function EffectControls() {
  const clip = useSelectedClip();
  const sequence = useCurrentSequence();
  const assets = useAppStore((s) => s.project?.assets ?? []);
  const effects = useAppStore((s) => s.effects);
  const selectedEffectId = useAppStore((s) => s.selectedEffectId);
  const effectKeyframes = useAppStore((s) => s.effectKeyframes);
  const selectedKeyframeIds = useAppStore((s) => s.selectedKeyframeIds);
  const playheadMs = useAppStore((s) => s.playheadMs);
  const setPlayhead = useAppStore((s) => s.setPlayhead);
  const setSelectedKeyframeIds = useAppStore((s) => s.setSelectedKeyframeIds);

  const [timeBase, setTimeBase] = useState<TimeBase>("sequence");

  const frameRate = sequence?.frameRate ?? 25;
  const list = clip ? effects[clip.id] ?? [] : [];
  const asset = clip ? assets.find((a) => a.id === clip.assetId) : undefined;
  const selectedEffect = list.find((fx) => fx.id === selectedEffectId);

  // 选中效果的关键帧泳道：只画这一个效果的，PR 也是选中哪个看哪个
  const lane = useMemo(() => {
    if (!clip || selectedEffectId === null) return [];
    return effectKeyframes
      .filter((k) => k.effectId === selectedEffectId)
      .filter((k) => k.timeMs >= clip.startMs - 1 && k.timeMs <= clip.startMs + clip.durationMs + 1)
      .sort((a, b) => a.timeMs - b.timeMs);
  }, [clip, selectedEffectId, effectKeyframes]);

  // ⌘A / Ctrl+A：选中该图层所有效果的关键帧（AE「效果控件」里的全选）。
  // 只在本面板挂载时生效（特效页），输入框内让路给文本全选。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "a") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        return;
      }
      if (!clip) return;
      const state = useAppStore.getState();
      const clipEffects = state.effects[clip.id] ?? [];
      const ids = state.effectKeyframes
        .filter(
          (k) =>
            clipEffects.some((fx) => fx.id === k.effectId) &&
            k.timeMs >= clip.startMs - 1 &&
            k.timeMs <= clip.startMs + clip.durationMs + 1
        )
        .map((k) => k.id);
      if (ids.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      state.setSelectedKeyframeIds(ids);
      state.pushNotice("info", `已选中该图层的 ${ids.length} 个关键帧`);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clip]);

  // 时间基准换算：序列时间直接用绝对毫秒；源素材时间从片段头开始算 0
  const clipStart = clip?.startMs ?? 0;
  const spanStart = timeBase === "sequence" ? clipStart : 0;
  const spanEnd = spanStart + (clip?.durationMs ?? 0);
  const span = Math.max(1, spanEnd - spanStart);
  const toBase = (timeMs: number) => (timeBase === "sequence" ? timeMs : timeMs - clipStart);
  const toSequence = (offsetMs: number) => (timeBase === "sequence" ? offsetMs : offsetMs + clipStart);
  const posOf = (timeMs: number) => ((toBase(timeMs) - spanStart) / span) * 100;
  const playheadInClip =
    clip !== null && playheadMs >= clipStart - 1 && playheadMs <= clipStart + clip.durationMs + 1;


  return (
    <section className="panel fx-controls">
      <div className="panel-head">
        <span className="title">效果控件</span>
        <span className="title">{list.length} 个效果</span>
      </div>

      <div className="fx-controls-layer">
        <span className="fx-layer-name" title={asset?.name ?? clip?.id}>
          {clip ? (asset?.name ?? "未链接素材") : "未选中图层"}
        </span>
        {clip && (
          <span className="fx-layer-sub num">
            {msToShort(clip.durationMs)} · {clip.speed.toFixed(2)}×
          </span>
        )}
      </div>

      <div className="panel-body">
        {/* 图层自身的 3D 变换组（AE 效果控件的经典结构：Transform 组在最上，
            之后才是效果栈；EC 参考 同构）。对照 docs/09 第 2.3 节的参数表 */}
        {clip && <Layer3DGroup />}
        <EffectStack />
        {!clip && (
          <div className="fx-browser-hint">在时间线上选中片段，这里挂出它的全部效果与参数</div>
        )}
      </div>

      {/* 关键帧泳道：选中效果的关键帧横排在片段的时间跨度上。
          泳道上方那条就是 PR 的片段条（clip bar），标着这段片段叫什么。 */}
      {clip && (
        <div className="fx-lane">
          <div className="fx-lane-ruler">
            <span className="fx-lane-title" title="当前效果的关键帧">
              关键帧 · {selectedEffect?.name ?? "未选效果"}
            </span>
            <span className="fx-lane-tabs" role="group" aria-label="时间基准">
              <button
                type="button"
                className={`fx-lane-tab${timeBase === "sequence" ? " on" : ""}`}
                onClick={() => setTimeBase("sequence")}
                title="按序列时间显示，与播放头一致"
              >
                序列
              </button>
              <button
                type="button"
                className={`fx-lane-tab${timeBase === "source" ? " on" : ""}`}
                onClick={() => setTimeBase("source")}
                title="按源素材时间显示，片段头为 0"
              >
                源素材
              </button>
            </span>
          </div>
          <div className="fx-lane-bar" title={asset?.name ?? clip.id}>
            <span className="fx-lane-bar-name">{asset?.name ?? "片段"}</span>
          </div>
          <div
            className="fx-lane-track"
            onPointerDown={(e) => {
              // 点或拖都算：泳道只管定位播放头，不管别的
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
              setPlayhead(toSequence(spanStart + ratio * span));
            }}
          >
            {lane.map((k) => {
              const selected = selectedKeyframeIds.includes(k.id);
              return (
                <button
                  key={k.id}
                  type="button"
                  className={`fx-lane-kf${Math.abs(k.timeMs - playheadMs) < 1000 / frameRate ? " at" : ""}${
                    selected ? " selected" : ""
                  }`}
                  style={{ left: `${posOf(k.timeMs)}%` }}
                  title={`${k.param} · ${msToTimecode(toBase(k.timeMs), frameRate)} · ${k.value.toFixed(2)}`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setPlayhead(k.timeMs);
                    setSelectedKeyframeIds(
                      e.shiftKey ? [...selectedKeyframeIds, k.id] : [k.id]
                    );
                  }}
                />
              );
            })}
            {playheadInClip && (
              <span className="fx-lane-playhead" style={{ left: `${posOf(playheadMs)}%` }} />
            )}
          </div>
          <div className="fx-lane-foot">
            <span className="num">{msToTimecode(spanStart, frameRate)}</span>
            <span className="fx-lane-count">{lane.length} 个关键帧</span>
            <span className="num">{msToTimecode(spanEnd, frameRate)}</span>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * 图层 3D 变换组（AE 效果控件 Transform 组的 Reelix 版，docs/09 第 2.3 节）。
 * 未启用时一行开关；启用后摆出位置 / 旋转 / 缩放 / 朝向 / 接受光照。
 * 数值控件与效果参数行共用同一只 DragNumber，拖动手感一致。
 */
function Layer3DGroup() {
  const clip = useSelectedClip();
  const setClip3DEnabled = useAppStore((s) => s.setClip3DEnabled);
  const setClipTransform3D = useAppStore((s) => s.setClipTransform3D);

  if (!clip) return null;
  const t = clip.transform3D;

  return (
    <div className="fx-card fx-3d">
      <div className="fx-head" onClick={(e) => e.stopPropagation()}>
        <span className="fx-name">图层 · 3D 变换</span>
        <button
          type="button"
          className={`fx-fxmark${clip.enable3D ? "" : " off"}`}
          title={clip.enable3D ? "已启用 3D，点一下关闭" : "未启用 3D，点一下开启"}
          onClick={() => setClip3DEnabled(clip.id, !clip.enable3D)}
        >
          3D
        </button>
      </div>
      {clip.enable3D && t && (
        <div className="fx-body">
          <div className="fx-row">
            <span className="fx-label" title="位置 XYZ（px，Z 支持负数）">位置</span>
            <span className="fx-3d-triple">
              <DragNumber value={t.position.x} step={1} animated={false}
                onChange={(v) => setClipTransform3D(clip.id, { position: { x: v } })} />
              <DragNumber value={t.position.y} step={1} animated={false}
                onChange={(v) => setClipTransform3D(clip.id, { position: { y: v } })} />
              <DragNumber value={t.position.z} step={1} animated={false}
                onChange={(v) => setClipTransform3D(clip.id, { position: { z: v } })} />
            </span>
          </div>
          <div className="fx-row">
            <span className="fx-label" title="旋转 XYZ（度）">旋转</span>
            <span className="fx-3d-triple">
              <DragNumber value={t.rotation.x} step={1} animated={false}
                onChange={(v) => setClipTransform3D(clip.id, { rotation: { x: v } })} />
              <DragNumber value={t.rotation.y} step={1} animated={false}
                onChange={(v) => setClipTransform3D(clip.id, { rotation: { y: v } })} />
              <DragNumber value={t.rotation.z} step={1} animated={false}
                onChange={(v) => setClipTransform3D(clip.id, { rotation: { z: v } })} />
            </span>
          </div>
          <div className="fx-row">
            <span className="fx-label" title="统一缩放">缩放</span>
            <DragNumber value={t.scale} step={0.05} min={0.01} animated={false}
              onChange={(v) => setClipTransform3D(clip.id, { scale: v })} />
          </div>
          <div className="fx-row">
            <span className="fx-label" title="图层朝向">朝向</span>
            <select
              className="fx-value"
              value={t.orientation}
              onChange={(e) =>
                setClipTransform3D(clip.id, {
                  orientation: e.target.value as "camera" | "free",
                })
              }
            >
              <option value="camera">朝向相机</option>
              <option value="free">自由朝向</option>
            </select>
          </div>
          <div className="fx-row">
            <span className="fx-label" title="是否接受光照">光照</span>
            <button
              type="button"
              className={`fx-fxmark${t.receiveLight ? "" : " off"}`}
              title={t.receiveLight ? "接受光照，点一下关闭" : "不接受光照，点一下开启"}
              onClick={() => setClipTransform3D(clip.id, { receiveLight: !t.receiveLight })}
            >
              光照
            </button>
          </div>
        </div>
      )}
    </div>
  );
}