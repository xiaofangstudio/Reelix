/**
 * 空间识别面板（剪辑页的「空间」子页）。
 *
 * COLMAP 以 sidecar 进程跑三步解算：抽帧 → 特征提取 → 特征匹配 → 光束法平差。
 * 面板只做三件事：挑一段视频、选定抽帧间隔、看着进度；解算结果回来之后，
 * 右边交给 `SpaceView` 画点云与相机轨迹，下边的滑杆可以逐帧检查注册情况。
 *
 * 任务状态全部来自后端事件（`reconstruct://progress|done|error`），
 * 前端不自己推算进度，也不缓存解算结果——workspace 里的 camera.json 才是权威。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore, useAssets } from "../store/appStore";
import {
  cancelReconstruct,
  colmapStatus,
  onReconstructDone,
  onReconstructFailed,
  onReconstructProgress,
  startReconstruct,
} from "../services/reconstruct";
import type { ColmapStatus, SceneCamera } from "../types/camera";
import { msToShort } from "../core/timecode";
import { SpaceView } from "./SpaceView";

/** 抽帧间隔选项。太密解算慢，太疏匹配容易断，2 秒是常用折中 */
const INTERVALS = [1, 2, 3, 5];

/** 阶段进度。空 stage 表示还没开始 */
interface Stage {
  stage: string;
  detail: string;
  progress: number;
}

const IDLE_STAGE: Stage = { stage: "", detail: "", progress: 0 };

/** 后端错误本来就是中文人话，意外类型给一句兜底 */
function toMessage(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim() !== "") return err;
  if (err instanceof Error && err.message.trim() !== "") return err.message;
  return fallback;
}

/** 整数加千分位，点数动辄几万，直接堆数字看不清 */
function groupNumber(value: number): string {
  return Math.round(value).toLocaleString("zh-CN");
}

export function SpatialPanel() {
  const assets = useAssets();
  const pushNotice = useAppStore((s) => s.pushNotice);

  const [status, setStatus] = useState<ColmapStatus | null>(null);
  const [assetId, setAssetId] = useState("");
  const [intervalS, setIntervalS] = useState(2);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<Stage>(IDLE_STAGE);
  const [scene, setScene] = useState<SceneCamera | null>(null);
  const [error, setError] = useState("");
  const [poseIndex, setPoseIndex] = useState(0);

  // 事件里只认自己的任务；首次收到事件时认领（切页回来时也能接上）
  const jobIdRef = useRef<string | null>(null);

  const videos = assets.filter((a) => a.kind === "video" && !a.missing);

  // 探测一次组件是否就位。缺失不影响主链路，只在面板里说清楚
  useEffect(() => {
    let disposed = false;
    void colmapStatus()
      .then((next) => {
        if (!disposed) setStatus(next);
      })
      .catch((err: unknown) => {
        if (!disposed) {
          setStatus({
            available: false,
            binary: "",
            version: "",
            cuda: false,
            detail: toMessage(err, "无法检测 COLMAP 组件"),
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  // 素材换了工程或刚导入时，下拉要跟上；默认选第一段视频
  useEffect(() => {
    if (videos.length === 0) {
      if (assetId !== "") setAssetId("");
      return;
    }
    if (!videos.some((a) => a.id === assetId)) setAssetId(videos[0].id);
  }, [videos, assetId]);

  // 订阅解算事件。切换大页面时后端任务不停，回来收到进度就自动接上
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    /** 认领首个任务 id；之后只处理同一任务的事件 */
    const accept = (id: string): boolean => {
      if (jobIdRef.current === null) jobIdRef.current = id;
      return jobIdRef.current === id;
    };

    void Promise.all([
      onReconstructProgress((payload) => {
        if (disposed || !accept(payload.jobId)) return;
        setRunning(true);
        setError("");
        setStage({
          stage: payload.stage,
          detail: payload.detail,
          progress: Math.max(0, Math.min(1, payload.progress)),
        });
      }),
      onReconstructDone((payload) => {
        if (disposed || !accept(payload.jobId)) return;
        jobIdRef.current = null;
        setRunning(false);
        setStage({ stage: "已完成", detail: "", progress: 1 });
        setScene(payload.scene);
        setPoseIndex(0);
        pushNotice(
          "info",
          `空间解算完成：注册 ${payload.scene.registeredCount} 帧，${groupNumber(
            payload.scene.pointCount
          )} 个稀疏点`
        );
      }),
      onReconstructFailed((payload) => {
        if (disposed || !accept(payload.jobId)) return;
        jobIdRef.current = null;
        setRunning(false);
        // 取消是用户主动动作，不算失败
        if (payload.text.includes("已取消")) {
          setStage(IDLE_STAGE);
          setError("");
          pushNotice("info", "已取消空间解算");
        } else {
          setStage((prev) => ({ ...prev, stage: "失败", detail: "" }));
          setError(payload.text);
          pushNotice("error", payload.text);
        }
      }),
    ]).then((fns) => {
      if (disposed) fns.forEach((fn) => fn());
      else unlisteners.push(...fns);
    });

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [pushNotice]);

  const start = useCallback(async () => {
    if (!assetId || running) return;
    setError("");
    setScene(null);
    setPoseIndex(0);
    setStage({ stage: "准备中", detail: "", progress: 0 });
    setRunning(true);
    try {
      const { jobId } = await startReconstruct(assetId, intervalS);
      jobIdRef.current = jobId;
    } catch (err) {
      setRunning(false);
      setStage(IDLE_STAGE);
      const text = toMessage(err, "无法开始空间解算");
      setError(text);
      pushNotice("error", text);
    }
  }, [assetId, intervalS, pushNotice, running]);

  const cancel = useCallback(async () => {
    const jobId = jobIdRef.current;
    if (!jobId) return;
    try {
      await cancelReconstruct(jobId);
      setStage((prev) => ({ ...prev, stage: "取消中", detail: "" }));
    } catch (err) {
      pushNotice("error", toMessage(err, "取消空间解算失败"));
    }
  }, [pushNotice]);

  const pose = scene ? scene.poses[poseIndex] ?? null : null;
  const percent = Math.round(stage.progress * 100);

  return (
    <>
      <section className="panel space-panel">
        <div className="panel-head">
          <span className="title">空间识别</span>
          <span
            className={`space-badge${
              status === null ? " pending" : status.available ? " ok" : " off"
            }`}
          >
            {status === null
              ? "检测中…"
              : status.available
                ? status.cuda
                  ? "CUDA 就绪"
                  : "COLMAP 就绪"
                : "未安装"}
          </span>
        </div>

        <div className="panel-body space-body">
          <p className="space-hint">
            {status === null
              ? "正在检查 COLMAP 组件…"
              : status.available
                ? status.cuda
                  ? "COLMAP 已就绪，匹配与平差会走显卡加速。"
                  : "COLMAP 已就绪（CPU 模式），长视频解算会慢一些。"
                : status.detail ||
                  "未找到 COLMAP 组件（reference/tracking/colmap-bin），空间解算暂不可用。"}
          </p>

          <label className="rec-field">
            <span className="rec-label">源素材</span>
            <select
              className="rec-select"
              value={assetId}
              onChange={(e) => setAssetId(e.target.value)}
              disabled={running || videos.length === 0}
            >
              {videos.length === 0 ? (
                <option value="">素材箱里还没有视频</option>
              ) : (
                videos.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name}
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="rec-field">
            <span className="rec-label">抽帧间隔</span>
            <select
              className="rec-select"
              value={intervalS}
              onChange={(e) => setIntervalS(Number(e.target.value))}
              disabled={running}
            >
              {INTERVALS.map((value) => (
                <option key={value} value={value}>
                  每 {value} 秒一帧
                </option>
              ))}
            </select>
          </label>

          <div className="space-actions">
            {!running ? (
              <button
                type="button"
                className="btn-primary"
                onClick={() => void start()}
                disabled={!status?.available || !assetId}
              >
                {scene ? "重新解算" : "开始解算"}
              </button>
            ) : (
              <>
                <button type="button" className="btn-ghost" onClick={() => void cancel()}>
                  取消
                </button>
                <span className="space-running">
                  <span className="space-dot" />
                  解算中
                </span>
              </>
            )}
          </div>

          {(running || stage.progress > 0) && (
            <div className="space-progress">
              <div className="space-progress-head">
                <span>{stage.stage || "准备中"}</span>
                <span className="num">{percent}%</span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${percent}%` }} />
              </div>
              {stage.detail && <div className="space-detail">{stage.detail}</div>}
            </div>
          )}

          {error && (
            <div className="space-error" role="alert">
              {error}
            </div>
          )}

          {scene && (
            <>
              <div className="space-stats">
                <div className="space-stat">
                  <span>注册帧</span>
                  <strong className="num">
                    {scene.registeredCount} / {scene.imageCount}
                  </strong>
                </div>
                <div className="space-stat">
                  <span>稀疏点</span>
                  <strong className="num">{groupNumber(scene.pointCount)}</strong>
                </div>
                <div className="space-stat">
                  <span>平均误差</span>
                  <strong className="num">{scene.meanError.toFixed(2)} px</strong>
                </div>
                <div className="space-stat">
                  <span>抽帧间隔</span>
                  <strong className="num">{scene.frameIntervalS} s</strong>
                </div>
              </div>

              {scene.poses.length > 0 && (
                <div className="space-range">
                  <div className="space-range-head">
                    <span>相机轨迹</span>
                    <span className="num">
                      {poseIndex + 1} / {scene.poses.length}
                      {pose ? ` · ${msToShort(pose.timeMs)}` : ""}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, scene.poses.length - 1)}
                    step={1}
                    value={poseIndex}
                    onChange={(e) => setPoseIndex(Number(e.target.value))}
                  />
                  <div className="space-range-foot">
                    {pose ? pose.name : "—"}
                  </div>
                </div>
              )}
            </>
          )}

          {!scene && !running && (
            <p className="space-note">
              解算分四步：按间隔抽帧、提取特征点、两两匹配、光束法平差。抽帧越密越稳，
              但耗时也越长；手持晃动大的素材建议 1 秒。
            </p>
          )}
        </div>
      </section>

      <div className="space-view">
        {scene ? (
          <>
            <SpaceView scene={scene} activePose={poseIndex} />
            <div className="space-hud">
              <span>拖拽旋转 · 滚轮缩放 · 右键平移</span>
              <span className="num">
                {groupNumber(scene.pointCount)} 点 · {scene.registeredCount} 相机
              </span>
            </div>
          </>
        ) : (
          <div className="space-empty">
            <div className="space-empty-title">三维空间预览</div>
            <p>
              选一段视频开始解算，完成后这里会显示稀疏点云、相机轨迹与每一帧的视锥。
              没有 COLMAP 组件也不影响剪辑与导出，只是这块先空着。
            </p>
          </div>
        )}
      </div>
    </>
  );
}
