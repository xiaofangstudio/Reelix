/**
 * 监视器。显示当前时间码、真画面与播放控制。
 *
 * 两种模式：
 * 1. 序列预览（默认）：画面由 Rust 侧按序列与播放头算好，每次播放头变化
 *    就向 `requestMonitorFrame` 要一帧 PNG 原始字节，转成 objectURL 交给
 *    `<img>`。同一条时刻二次请求会命中后端两级缓存。请求只允许一笔在途，
 *    新的时刻直接覆盖旧的——播放时不会把请求排成长队。
 * 2. 素材预览（双击素材箱条目 / 时间线片段进入）：直接看这段素材本身的画面，
 *    自带播放头与逐帧步进，不走序列播放（PR 源监视器的路子）。
 *
 * 播放开关放在 store 里（`playing`），因为监视器按钮与全局空格键要共用同一个开关。
 * 播放用 requestAnimationFrame 推进全局播放头，播放头是时间轴唯一权威，
 * 所以时间线视图会跟着一起动。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore, useAssets, useCurrentSequence } from "../store/appStore";
import { requestMonitorFrame } from "../store/projectActions";
import { bytesToObjectUrl, describeBytes } from "../core/ipcBytes";
import { useThumbUrl } from "../hooks/useThumbUrl";
import { msToTimecode, snapToFrame } from "../core/timecode";
import type { Asset } from "../types/project";

/** 后端错误本来就是中文人话，意外类型给一句兜底，别把英文堆栈丢到画面上。 */
function toMessage(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim() !== "") return err;
  if (err instanceof Error && err.message.trim() !== "") return err.message;
  return fallback;
}

export function Monitor() {
  // 未打开工程时 sequence 为 undefined，界面显示引导而不是崩掉
  const sequence = useCurrentSequence();
  const playheadMs = useAppStore((s) => s.playheadMs);
  const setPlayhead = useAppStore((s) => s.setPlayhead);
  const playing = useAppStore((s) => s.playing);
  const playbackRate = useAppStore((s) => s.playbackRate);
  const togglePlaying = useAppStore((s) => s.togglePlaying);

  // 素材预览：非空时监视器看素材本身，不看序列
  const assets = useAssets();
  const previewAssetId = useAppStore((s) => s.previewAssetId);
  const setPreviewAsset = useAppStore((s) => s.setPreviewAsset);
  const previewAsset: Asset | null =
    previewAssetId !== null ? assets.find((a) => a.id === previewAssetId) ?? null : null;

  const rafRef = useRef<number | null>(null);
  const lastRef = useRef(0);

  // 画面区尺寸，作为渲染画幅上限提示传给后端
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  /** 诊断信息：最近一帧 IPC 载荷的形态/字节数/签名，画在画面角落供排查 */
  const [frameDiag, setFrameDiag] = useState<string | null>(null);
  // 同一时刻只允许一笔在途请求；最新时刻覆盖尚未发出的旧时刻
  const busyRef = useRef(false);
  const wantedRef = useRef<number | null>(null);
  // 当前 <img> 用的 objectURL，以及等新画面铺上后要回收的上一张
  const liveUrlRef = useRef<string | null>(null);
  const staleUrlRef = useRef<string | null>(null);

  // ---- 素材预览的本地播放头与播放态（与序列播放互不干扰）----
  const [assetTimeMs, setAssetTimeMs] = useState(0);
  const [assetPlaying, setAssetPlaying] = useState(false);
  // 播放推进用 ref 当权威，state 只负责渲染，避免每帧 setState 引用抖动
  const assetTimeRef = useRef(0);
  const setAssetTime = useCallback((ms: number) => {
    assetTimeRef.current = ms;
    setAssetTimeMs(ms);
  }, []);
  // 抽帧时刻按 100ms 量化：预览播放时不逐毫秒打后端，磁盘缓存也能兜住
  const [assetThumbMs, setAssetThumbMs] = useState(0);
  const assetThumbUrl = useThumbUrl(
    previewAsset?.id ?? "",
    assetThumbMs,
    previewAsset !== null && previewAsset.kind !== "audio" && !previewAsset.missing
  );

  // 进入素材预览：停掉序列播放，素材播放头落到中点
  useEffect(() => {
    if (previewAssetId === null) return;
    useAppStore.getState().pause();
    setAssetPlaying(false);
    const asset = useAppStore.getState().project?.assets.find((a) => a.id === previewAssetId);
    const mid = asset && asset.durationMs > 0 ? Math.round(asset.durationMs / 2) : 0;
    setAssetTime(mid);
  }, [previewAssetId, setAssetTime]);

  // 素材预览播放：rAF 按素材帧率推进，到末尾停下
  useEffect(() => {
    if (!assetPlaying || !previewAsset || previewAsset.durationMs <= 0) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      const next = assetTimeRef.current + dt;
      if (next >= previewAsset.durationMs) {
        setAssetTime(previewAsset.durationMs);
        setAssetPlaying(false);
        return;
      }
      setAssetTime(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [assetPlaying, previewAsset, setAssetTime]);

  // 抽帧时刻跟随播放头，但至少隔 100ms 才真的换一帧请求
  useEffect(() => {
    if (Math.abs(assetTimeMs - assetThumbMs) < 100) return;
    const timer = window.setTimeout(() => setAssetThumbMs(assetTimeMs), 80);
    return () => window.clearTimeout(timer);
  }, [assetTimeMs, assetThumbMs]);

  useEffect(() => {
    if (!playing) return;
    lastRef.current = performance.now();

    const step = (now: number) => {
      const elapsed = now - lastRef.current;
      lastRef.current = now;

      const state = useAppStore.getState();
      const duration = state.project?.sequences[0]?.durationMs ?? 0;
      // 倍速决定推进方向与快慢：正数正放、负数倒放
      const rate = state.playbackRate || 1;
      const next = state.playheadMs + Math.max(0, elapsed) * rate;

      if (next >= duration) {
        state.setPlayhead(duration);
        state.pause();
        return;
      }
      if (next <= 0) {
        state.setPlayhead(0);
        state.pause();
        return;
      }
      state.setPlayhead(next);
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, playbackRate]);

  /**
   * 取帧循环。串行执行：一笔出帧期间新的时刻只记在 `wantedRef`，
   * 等这笔回来再取最新时刻，避免播放时请求堆积把后端压垮。
   */
  const pump = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      while (wantedRef.current !== null) {
        const timeMs = wantedRef.current;
        wantedRef.current = null;

        const seq = useAppStore.getState().project?.sequences[0];
        if (!seq) return;

        const stage = stageRef.current;
        const maxWidth = stage ? Math.max(1, Math.round(stage.clientWidth)) : undefined;
        const maxHeight = stage ? Math.max(1, Math.round(stage.clientHeight)) : undefined;

        try {
          const bytes = await requestMonitorFrame(seq.id, timeMs, maxWidth, maxHeight);
          setFrameDiag(describeBytes(bytes));
          const url = bytesToObjectUrl(bytes);
          // 上一张等新画面 onLoad 之后再回收，否则会出现一瞬空白
          staleUrlRef.current = liveUrlRef.current;
          liveUrlRef.current = url;
          setFrameUrl(url);
          setFrameError(null);
        } catch (err) {
          setFrameError(toMessage(err, "这一帧渲染失败"));
        }
      }
    } finally {
      busyRef.current = false;
    }
  }, []);

  // 播放头变化、工程快照变化都重新要一帧（改效果后回填快照也走这里刷新画面）；
  // 素材预览模式下不看序列，直接跳过
  useEffect(() => {
    if (!sequence || previewAsset) return;
    wantedRef.current = Math.max(0, playheadMs);
    void pump();
  }, [sequence, playheadMs, pump, previewAsset]);

  // 新画面铺上之后回收上一张 objectURL
  const handleFrameLoad = useCallback(() => {
    const stale = staleUrlRef.current;
    staleUrlRef.current = null;
    if (stale) URL.revokeObjectURL(stale);
  }, []);

  // 卸载时把两张都收了，避免泄漏
  useEffect(
    () => () => {
      if (liveUrlRef.current) URL.revokeObjectURL(liveUrlRef.current);
      if (staleUrlRef.current) URL.revokeObjectURL(staleUrlRef.current);
      liveUrlRef.current = null;
      staleUrlRef.current = null;
    },
    []
  );

  // 素材预览模式：画面、时间码、逐帧与播放都围着这段素材转
  if (previewAsset) {
    const hasVideo = previewAsset.kind !== "audio" && !previewAsset.missing;
    const fps = previewAsset.frameRate > 0 ? previewAsset.frameRate : (sequence?.frameRate ?? 25);
    const aspect =
      previewAsset.width > 0 && previewAsset.height > 0
        ? `${previewAsset.width} / ${previewAsset.height}`
        : "16 / 9";
    const stepAsset = (frames: number) => {
      setAssetPlaying(false);
      const next = assetTimeRef.current + (frames * 1000) / fps;
      setAssetTime(Math.min(previewAsset.durationMs, Math.max(0, next)));
    };
    const kindLabel =
      previewAsset.kind === "audio"
        ? "音频"
        : previewAsset.kind === "image"
          ? "图片"
          : previewAsset.kind === "imageSequence"
            ? "序列"
            : "视频";

    return (
      <section className="panel">
        <div className="panel-head">
          <span className="title">监视器 · 素材预览</span>
          <span className="title" title={previewAsset.name}>
            {previewAsset.name}
          </span>
        </div>

        <div className="monitor-stage" ref={stageRef}>
          <div className="monitor-frame" style={{ width: "80%", aspectRatio: aspect }}>
            {hasVideo ? (
              assetThumbUrl ? (
                <img
                  className="monitor-image"
                  src={assetThumbUrl}
                  alt="素材预览画面"
                  draggable={false}
                />
              ) : (
                <span className="monitor-hint">正在渲染…</span>
              )
            ) : (
              <div className="monitor-asset-empty">
                <div className="icon">{previewAsset.missing ? "!" : "♪"}</div>
                <div className="main-text">
                  {previewAsset.missing ? "素材文件丢失，请重新链接" : "音频素材没有画面"}
                </div>
                <div className="sub-text">{previewAsset.name}</div>
              </div>
            )}
          </div>
        </div>

        <div className="monitor-bar">
          <span className="monitor-source">素材预览</span>
          <button
            type="button"
            className="ctl"
            title="上一帧"
            disabled={!hasVideo || previewAsset.durationMs <= 0}
            onClick={() => stepAsset(-1)}
          >
            ◀|
          </button>
          <button
            type="button"
            className="ctl"
            title="播放 / 暂停"
            disabled={!hasVideo || previewAsset.durationMs <= 0}
            onClick={() => setAssetPlaying((v) => !v)}
          >
            {assetPlaying ? "暂停" : "播放"}
          </button>
          <button
            type="button"
            className="ctl"
            title="下一帧"
            disabled={!hasVideo || previewAsset.durationMs <= 0}
            onClick={() => stepAsset(1)}
          >
            |▶
          </button>
          <span className="timecode">
            {msToTimecode(assetTimeMs, fps)} / {msToTimecode(previewAsset.durationMs, fps)}
          </span>
          <span style={{ flex: 1 }} />
          <span className="ctl">
            {kindLabel} · {fps} 帧/秒
          </span>
          <button
            type="button"
            className="ctl"
            title="关闭预览，回到序列画面"
            onClick={() => setPreviewAsset(null)}
          >
            ✕ 关闭
          </button>
        </div>
      </section>
    );
  }

  // 没有工程就没有序列，给一个引导态（所有 hook 都已调用完，可以安全早退）
  if (!sequence) {
    return (
      <section className="panel">
        <div className="panel-head">
          <span className="title">监视器</span>
        </div>
        <div className="monitor-stage">
          <div className="tl-empty">还没有打开工程</div>
        </div>
      </section>
    );
  }

  const frameMs = 1000 / sequence.frameRate;

  // 当前播放头下生效的字幕：只看未隐藏的字幕轨，行序按轨道顺序叠上去
  const activeSubtitles = sequence.tracks
    .filter((track) => track.kind === "subtitle" && !track.hidden)
    .flatMap((track) => track.clips)
    .filter((clip) => playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs)
    .map((clip) => clip.text?.trim() ?? "")
    .filter((text) => text !== "");

  const stepBy = (frames: number) => {
    useAppStore.getState().pause();
    setPlayhead(snapToFrame(playheadMs + frames * frameMs, sequence.frameRate));
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="title">监视器</span>
        <span className="title">
          {sequence.width}×{sequence.height}
        </span>
      </div>

      <div className="monitor-stage" ref={stageRef}>
        <div
          className="monitor-frame"
          style={{ width: "80%", aspectRatio: `${sequence.width} / ${sequence.height}` }}
        >
          {frameUrl ? (
            <img
              className="monitor-image"
              src={frameUrl}
              alt="预览画面"
              draggable={false}
              onLoad={handleFrameLoad}
            />
          ) : (
            <span className="monitor-hint">{frameError ?? "正在渲染…"}</span>
          )}
          {activeSubtitles.length > 0 && (
            <div className="monitor-subtitle">
              {activeSubtitles.map((text, i) => (
                <span key={i}>{text}</span>
              ))}
            </div>
          )}
        </div>
        {frameError && frameUrl && <span className="badge-degrade">{frameError}</span>}
        {/* 诊断角标：黑屏/破图时一眼看出 IPC 载荷形态（形态 · 字节数 · 前 8 字节） */}
        {frameDiag && <span className="badge-degrade monitor-diag">{frameDiag}</span>}
      </div>

      <div className="monitor-bar">
        <button type="button" className="ctl" title="上一帧" onClick={() => stepBy(-1)}>
          ◀|
        </button>
        <button
          type="button"
          className="ctl"
          title="播放 / 暂停（空格）"
          onClick={togglePlaying}
        >
          {playing ? "暂停" : "播放"}
        </button>
        <button type="button" className="ctl" title="下一帧" onClick={() => stepBy(1)}>
          |▶
        </button>
        <span className="timecode">{msToTimecode(playheadMs, sequence.frameRate)}</span>
        {playing && playbackRate !== 1 && (
          <span className="ctl rate">
            {Math.abs(playbackRate)}×{playbackRate < 0 ? " 倒放" : ""}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span className="ctl">
          {sequence.colorSpace} · {sequence.frameRate} 帧/秒
        </span>
      </div>
    </section>
  );
}
