/**
 * 导出页（交付页）。
 *
 * 布局学 PR / 达芬奇的交付页：左边预设列表，右边「序列摘要 → 输出设置 →
 * 进度」自上而下一路看下来，不用跳来跳去。
 *
 * 几个 distilled 自四款软件的决定：
 * - 预设直接标出「匹配画幅」与按当前范围预估的文件大小（剪映把结果说到前头，
 *   用户最关心的就是「多大、多久」）；
 * - 导出范围给「整条序列 / 从播放头到结尾」两档，播放头即选区，不用另设入出点；
 * - 进度区给足信息：百分比、帧数、已用时间、剩余时间、编码速度、阶段，
 *   外加暂停 / 继续（达芬奇 Deliver 的任务控制）；
 * - 导出任务状态放在 store（appStore.exportJob），由 App 的全局订阅写入——
 *   导出是几分钟的后台活，切去剪辑 / 特效页进度不丢，顶栏也有「导出中 xx%」。
 */

import { useEffect, useMemo, useState } from "react";
import { useAppStore, useCurrentSequence } from "../store/appStore";
import { dialog, exportApi } from "../services";
import { revealPath } from "../services/audio";
import type { ExportPreset } from "../services/export";
import { msToChinese, msToTimecode } from "../core/timecode";

/** 音频按固定 192kbps 编码（与后端一致），预估大小时算进去 */
const AUDIO_KBPS = 192;

/** 导出任务的界面状态文案 */
const STATUS_LABEL: Record<string, string> = {
  running: "导出中",
  done: "已完成",
  cancelled: "已取消",
  failed: "失败",
};

/** 后端错误本来就是中文人话，意外类型给一句兜底，别把英文堆栈丢到界面上。 */
function toMessage(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim() !== "") return err;
  if (err instanceof Error && err.message.trim() !== "") return err.message;
  return fallback;
}

/** 预估文件大小（字节）：（视频码率 + 音频码率）× 时长 */
function estimateBytes(preset: ExportPreset, seconds: number): number {
  return ((preset.bitrateKbps + AUDIO_KBPS) * 1000 * Math.max(0, seconds)) / 8;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** 已用时间格式：M:SS */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ExportPage() {
  const project = useAppStore((s) => s.project);
  const sequence = useCurrentSequence();
  const pushNotice = useAppStore((s) => s.pushNotice);
  const playheadMs = useAppStore((s) => s.playheadMs);
  const exportJob = useAppStore((s) => s.exportJob);
  const beginExportJob = useAppStore((s) => s.beginExportJob);
  const failExportJob = useAppStore((s) => s.failExportJob);
  const resetExportJob = useAppStore((s) => s.resetExportJob);

  const [presets, setPresets] = useState<ExportPreset[]>([]);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState("");
  const [rangeMode, setRangeMode] = useState<"all" | "fromPlayhead">("all");
  /** 暂停是界面态：后端只是停帧，阶段文案不变，这里自己记住 */
  const [paused, setPaused] = useState(false);
  /** 每秒推一次钟，供已用时间与编码速度刷新 */
  const [nowMs, setNowMs] = useState(() => Date.now());

  // 拉一次预设列表，默认选中第一项
  useEffect(() => {
    let alive = true;
    void exportApi
      .listExportPresets()
      .then((list) => {
        if (!alive) return;
        setPresets(list);
        setPresetId((cur) => cur ?? list.find((p) => p.available !== false)?.id ?? list[0]?.id ?? null);
      })
      .catch((err) => {
        if (alive) pushNotice("error", toMessage(err, "读取导出预设失败"));
      });
    return () => {
      alive = false;
    };
  }, [pushNotice]);

  // 新任务开始：清掉上一轮的暂停态
  useEffect(() => {
    if (exportJob.status === "running") setPaused(false);
  }, [exportJob.status, exportJob.jobId]);

  // 运行中每 500ms 推一次钟
  useEffect(() => {
    if (exportJob.status !== "running") return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [exportJob.status]);

  const preset = useMemo(
    () => presets.find((p) => p.id === presetId) ?? null,
    [presets, presetId]
  );

  // 序列统计：轨道与片段数，摘要卡用
  const stats = useMemo(() => {
    let clips = 0;
    let videoTracks = 0;
    let audioTracks = 0;
    for (const track of sequence?.tracks ?? []) {
      if (track.kind === "video") videoTracks += 1;
      else if (track.kind === "audio") audioTracks += 1;
      clips += track.clips.length;
    }
    return { clips, videoTracks, audioTracks };
  }, [sequence]);

  // 没打开工程：整页给中文空状态
  if (!project || !sequence) {
    return (
      <div className="export-page">
        <div className="empty-state">
          <div className="icon">◇</div>
          <div className="main-text">先新建或打开一个工程</div>
          <div className="sub-text">有工程之后才能导出成片</div>
        </div>
      </div>
    );
  }

  const durationMs = sequence.durationMs ?? 0;
  const frameRate = sequence.frameRate || 25;
  const running = exportJob.status === "running";

  const rangeStartMs = rangeMode === "all" ? 0 : Math.min(playheadMs, durationMs);
  const rangeSeconds = Math.max(0, durationMs - rangeStartMs) / 1000;

  const percent =
    exportJob.progress.totalFrames > 0
      ? Math.min(100, Math.round((exportJob.progress.frame / exportJob.progress.totalFrames) * 100))
      : 0;
  const elapsedMs =
    exportJob.startedAt !== null ? Math.max(0, nowMs - exportJob.startedAt) : 0;
  const encodeSpeed =
    exportJob.progress.frame > 0 && elapsedMs > 300
      ? exportJob.progress.frame / (elapsedMs / 1000)
      : 0;

  /** 弹保存框选输出路径。默认文件名跟工程名走。 */
  const browse = async () => {
    try {
      const path = await dialog.pickSavePath(`${project.name}.mp4`);
      if (path) setOutputPath(path);
    } catch (err) {
      pushNotice("error", toMessage(err, "选择保存位置失败"));
    }
  };

  /** 开始导出：当前预设、输出路径与选定的范围。 */
  const start = async () => {
    if (!preset) {
      pushNotice("info", "先选一个导出预设");
      return;
    }
    if (!outputPath.trim()) {
      pushNotice("info", "先点「浏览…」选一个保存位置");
      return;
    }
    if (durationMs - rangeStartMs < 1000 / frameRate) {
      pushNotice("info", "导出范围太短，不够一整帧");
      return;
    }
    try {
      const { jobId } = await exportApi.startExport(
        sequence.id,
        preset.id,
        outputPath.trim(),
        { startMs: rangeStartMs, endMs: durationMs }
      );
      beginExportJob(jobId, outputPath.trim());
    } catch (err) {
      failExportJob(toMessage(err, "启动导出失败"));
    }
  };

  /** 取消当前任务。真正停下以后后端会推「已取消」的阶段。 */
  const cancel = async () => {
    const job = exportJob.jobId;
    if (!job) return;
    try {
      await exportApi.cancelExport(job);
      setPaused(false);
    } catch (err) {
      pushNotice("error", toMessage(err, "取消导出失败"));
    }
  };

  /** 暂停 / 继续：只动任务表，进度事件会接着来。 */
  const togglePause = async () => {
    const job = exportJob.jobId;
    if (!job) return;
    try {
      if (paused) await exportApi.resumeExport(job);
      else await exportApi.pauseExport(job);
      setPaused((v) => !v);
    } catch (err) {
      pushNotice("error", toMessage(err, paused ? "继续导出失败" : "暂停导出失败"));
    }
  };

  /** 在资源管理器里定位导出的文件。 */
  const reveal = async () => {
    try {
      await revealPath(exportJob.outputPath);
    } catch (err) {
      pushNotice("error", toMessage(err, "打开文件夹失败"));
    }
  };

  return (
    <div className="export-page">
      {/* 左：预设列表 */}
      <section className="panel export-presets">
        <div className="panel-head">
          <span className="title">导出预设</span>
          <span className="title">{presets.length} 个</span>
        </div>
        <div className="panel-body">
          {presets.length === 0 ? (
            <div className="tl-empty">还没有可用的预设</div>
          ) : (
            presets.map((p) => {
              const matched = p.width === sequence.width && p.height === sequence.height;
              const unavailable = p.available === false;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`preset-item${presetId === p.id ? " selected" : ""}${unavailable ? " unavailable" : ""}`}
                  onClick={() => setPresetId(p.id)}
                  disabled={running || unavailable}
                  title={
                    unavailable
                      ? "本机 ffmpeg 不支持这个编码，请换 H.264 预设"
                      : `${p.name}：${p.width}×${p.height} · ${p.container} · ${p.videoCodec}`
                  }
                >
                  <span className="preset-name">
                    {p.name}
                    {matched && <span className="preset-match">匹配画幅</span>}
                    {unavailable && <span className="preset-match">本机不可用</span>}
                  </span>
                  <span className="preset-sub num">
                    {p.width}×{p.height} · {p.videoCodec} · {Math.round(p.bitrateKbps / 1000)} Mbps
                  </span>
                  <span className="preset-sub">约 {formatBytes(estimateBytes(p, rangeSeconds))}</span>
                </button>
              );
            })
          )}
        </div>
      </section>

      {/* 右：摘要 / 输出设置 / 进度 */}
      <section className="panel">
        <div className="panel-head">
          <span className="title">导出</span>
          <span className="title">{sequence.name}</span>
        </div>
        <div className="panel-body export-form">
          {/* 序列摘要：这一单到底要渲染什么 */}
          <div className="export-field">
            <span className="export-label">序列摘要</span>
            <div className="export-summary">
              <div className="summary-cell">
                <span className="k">画幅</span>
                <span className="v num">
                  {sequence.width}×{sequence.height}
                </span>
              </div>
              <div className="summary-cell">
                <span className="k">帧率</span>
                <span className="v num">{frameRate} 帧/秒</span>
              </div>
              <div className="summary-cell">
                <span className="k">时长</span>
                <span className="v num">{msToChinese(durationMs)}</span>
              </div>
              <div className="summary-cell">
                <span className="k">色彩</span>
                <span className="v">{sequence.colorSpace}</span>
              </div>
              <div className="summary-cell">
                <span className="k">轨道</span>
                <span className="v">
                  视频 {stats.videoTracks} · 音频 {stats.audioTracks}
                </span>
              </div>
              <div className="summary-cell">
                <span className="k">片段</span>
                <span className="v num">{stats.clips} 个</span>
              </div>
            </div>
          </div>

          {/* 输出路径 */}
          <div className="export-field">
            <span className="export-label">输出路径</span>
            <div className="export-path-row">
              <input
                className="export-path"
                value={outputPath}
                placeholder={`建议：${project.name}.mp4`}
                readOnly
              />
              <button
                type="button"
                className="btn-ghost"
                onClick={() => void browse()}
                disabled={running}
              >
                浏览…
              </button>
            </div>
          </div>

          {/* 导出范围：整条序列 / 从播放头到结尾 */}
          <div className="export-field">
            <span className="export-label">导出范围</span>
            <div className="export-range-opts">
              <label className={`range-opt${rangeMode === "all" ? " active" : ""}`}>
                <input
                  type="radio"
                  name="export-range"
                  checked={rangeMode === "all"}
                  onChange={() => setRangeMode("all")}
                  disabled={running}
                />
                <span className="range-opt-body">
                  <span className="range-opt-name">整条序列</span>
                  <span className="range-opt-time num">
                    {msToTimecode(0, frameRate)} → {msToTimecode(durationMs, frameRate)}
                  </span>
                </span>
              </label>
              <label className={`range-opt${rangeMode === "fromPlayhead" ? " active" : ""}`}>
                <input
                  type="radio"
                  name="export-range"
                  checked={rangeMode === "fromPlayhead"}
                  onChange={() => setRangeMode("fromPlayhead")}
                  disabled={running}
                />
                <span className="range-opt-body">
                  <span className="range-opt-name">从播放头到结尾</span>
                  <span className="range-opt-time num">
                    {msToTimecode(playheadMs, frameRate)} → {msToTimecode(durationMs, frameRate)}
                  </span>
                </span>
              </label>
            </div>
          </div>

          {/* 主操作 */}
          <div className="export-actions">
            {running ? (
              <>
                <button type="button" className="btn-export-start" onClick={() => void cancel()}>
                  取消导出
                </button>
                <button type="button" className="btn-ghost" onClick={() => void togglePause()}>
                  {paused ? "继续" : "暂停"}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-export-start"
                onClick={() => void start()}
                disabled={presets.length === 0 || !outputPath.trim() || durationMs <= 0}
              >
                开始导出
              </button>
            )}
            {preset && (
              <span className="export-estimate">
                预估大小约 {formatBytes(estimateBytes(preset, rangeSeconds))}
              </span>
            )}
          </div>

          {/* 进度区 */}
          <div className="export-progress">
            {exportJob.status === "idle" ? (
              <div className="export-idle">
                <div className="export-idle-steps">
                  <span className={`step${preset ? " done" : ""}`}>
                    <i>1</i>选择预设
                  </span>
                  <span className="step-arrow">→</span>
                  <span className={`step${outputPath.trim() ? " done" : ""}`}>
                    <i>2</i>选择保存位置
                  </span>
                  <span className="step-arrow">→</span>
                  <span className="step">
                    <i>3</i>开始导出
                  </span>
                </div>
                <div className="export-idle-hint">
                  导出由 ffmpeg 真编码，大工程需要几分钟；任务在后台跑，可以切去其他页面继续干活
                </div>
              </div>
            ) : (
              <>
                <div className="export-progress-head">
                  <span className={`export-status-pill ${exportJob.status}`}>
                    {running && paused ? "已暂停" : STATUS_LABEL[exportJob.status]}
                  </span>
                  <span className="export-percent num">{percent}%</span>
                </div>
                <div className="progress-track">
                  <div
                    className={`progress-fill${exportJob.status === "failed" ? " error" : ""}`}
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <div className="export-meta">
                  <span className="num">
                    {exportJob.progress.frame} / {exportJob.progress.totalFrames} 帧
                  </span>
                  <span className="num">已用 {formatElapsed(elapsedMs)}</span>
                  {running && !paused && exportJob.progress.etaMs > 0 && (
                    <span>剩余约 {msToChinese(exportJob.progress.etaMs)}</span>
                  )}
                  {running && !paused && encodeSpeed > 0 && (
                    <span className="num">{encodeSpeed.toFixed(1)} 帧/秒</span>
                  )}
                  <span>
                    {exportJob.status === "running"
                      ? paused
                        ? "已暂停，点「继续」接着编码"
                        : exportJob.progress.stage || "准备中"
                      : ""}
                  </span>
                </div>

                {exportJob.status === "done" && (
                  <div className="export-done-row">
                    <span className="export-done-text">
                      导出完成 · {msToChinese(durationMs - rangeStartMs)}的成片已保存
                    </span>
                    <span className="export-done-actions">
                      <button type="button" className="btn-ghost" onClick={() => void reveal()}>
                        打开所在文件夹
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => resetExportJob()}
                      >
                        再导出一次
                      </button>
                    </span>
                  </div>
                )}
                {exportJob.status === "cancelled" && (
                  <div className="export-cancelled-text">
                    已取消导出，半成品已清理
                    <button type="button" className="btn-ghost" onClick={() => resetExportJob()}>
                      重新设置
                    </button>
                  </div>
                )}
                {exportJob.status === "failed" && (
                  <div className="export-error">
                    <span>{exportJob.failText || "导出失败"}</span>
                    <button type="button" className="btn-ghost" onClick={() => resetExportJob()}>
                      重新设置
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
