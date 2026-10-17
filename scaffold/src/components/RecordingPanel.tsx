/**
 * 录音面板（剪辑页的「音频」子页）。
 *
 * 麦克风采集在前端：getUserMedia 拿流、MediaRecorder 攒字节；
 * 转成 WAV 并按普通素材导入素材箱是后端的活（saveRecording），
 * 导入完成后复用 projectActions 里的 appendAssetToTrackEnd 接到音频轨末尾，
 * 再 refreshProject 拉权威快照回填——编排逻辑不在这里另造一份。
 *
 * 采集资源（stream / AudioContext / 定时器）在卸载时必须全部释放，
 * 卸载时正在录的内容直接丢弃，不往工程里塞半截录音。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { appendAssetToTrackEnd, refreshProject } from "../store/projectActions";
import { saveRecording } from "../services/audio";
import { msToShort } from "../core/timecode";

/** 后端错误本来就是中文人话，意外类型给一句兜底，别把英文堆栈丢到界面上。 */
function toMessage(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim() !== "") return err;
  if (err instanceof Error && err.message.trim() !== "") return err.message;
  return fallback;
}

/** getUserMedia 的失败原因翻译成中文人话。 */
function micErrorText(err: unknown): string {
  if (typeof err === "object" && err !== null && "name" in err) {
    const name = String((err as { name: unknown }).name);
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "麦克风权限被拒绝，请在系统设置里允许后重试";
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return "找不到可用的麦克风设备";
    }
  }
  return toMessage(err, "无法开始录音，请检查麦克风");
}

export function RecordingPanel() {
  const pushNotice = useAppStore((s) => s.pushNotice);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef("");
  // 取消时不导入；卸载时也置真，防止半截录音溜进工程
  const discardRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);

  /** 刷新麦克风列表。没授权时 label 是空的，界面显示「设备 N」兜底。 */
  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === "audioinput"));
    } catch {
      // 拿不到设备列表就留空，下拉里至少还有「系统默认」
    }
  }, []);

  // 设备列表 + devicechange 监听
  useEffect(() => {
    void refreshDevices();
    const onChanged = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", onChanged);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", onChanged);
    };
  }, [refreshDevices]);

  /** 释放采集资源：停流、关音频上下文、清定时器。录音状态由调用方管。 */
  const releaseCapture = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    analyserRef.current = null;
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setLevel(0);
  }, []);

  /** 录音停止后的收尾：取消就丢弃，否则合成 Blob 交给后端转 WAV 并上轨。 */
  const finalize = useCallback(async () => {
    releaseCapture();
    setRecording(false);
    recorderRef.current = null;

    if (discardRef.current) {
      chunksRef.current = [];
      setElapsedMs(0);
      return;
    }

    const chunks = chunksRef.current;
    chunksRef.current = [];
    if (chunks.length === 0) {
      setElapsedMs(0);
      pushNotice("info", "没有录到内容");
      return;
    }

    setBusy(true);
    try {
      const blob = new Blob(chunks, { type: mimeRef.current || "audio/webm" });
      const asset = await saveRecording(await blob.arrayBuffer());
      // 复用导入素材的落轨动作：音频素材自动接到音频轨末尾
      await appendAssetToTrackEnd(asset);
      await refreshProject();
      pushNotice("info", `录音《${asset.name}》已导入并放到音频轨`);
    } catch (err) {
      pushNotice("error", toMessage(err, "导入录音失败"));
    } finally {
      setBusy(false);
      setElapsedMs(0);
    }
  }, [pushNotice, releaseCapture]);

  // 卸载时必须停掉所有 stream tracks，正在录的内容直接丢弃
  useEffect(
    () => () => {
      discardRef.current = true;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      releaseCapture();
    },
    [releaseCapture]
  );

  /** 打开实时电平表：AnalyserNode 取 RMS，画在一条 div 宽度上。 */
  const startMeter = (stream: MediaStream) => {
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;

      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        const node = analyserRef.current;
        if (!node) return;
        node.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
        // RMS 偏小，放大一档让电平条肉眼可见，封顶 1
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // 电平表拿不到就不显示，不影响录音本体
    }
  };

  /** 开始录音：拿流、起 MediaRecorder、开计时与电平表。 */
  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      pushNotice("error", "当前环境拿不到麦克风，请检查应用权限");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      streamRef.current = stream;

      // 尽量用 webm 容器，环境不支持就交给浏览器自己挑
      const mime =
        typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      mimeRef.current = mime;
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      discardRef.current = false;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => void finalize();
      recorder.start();
      recorderRef.current = recorder;

      setRecording(true);
      setElapsedMs(0);
      startedAtRef.current = Date.now();
      timerRef.current = window.setInterval(
        () => setElapsedMs(Date.now() - startedAtRef.current),
        200
      );
      startMeter(stream);
    } catch (err) {
      pushNotice("error", micErrorText(err));
    }
  };

  /** 停止采集。recorder.stop() 之后走 onstop → finalize 完成收尾。 */
  const stopCapture = (discard: boolean) => {
    discardRef.current = discard;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      void finalize();
    }
    // 流在 finalize 里统一释放，这里先把定时器停了避免计时空转
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="title">录音</span>
        {recording && (
          <span className="rec-rec-mark">
            <span className="rec-dot" />
            录音中
          </span>
        )}
      </div>

      <div className="panel-body rec-body">
        <label className="rec-field">
          <span className="rec-label">麦克风</span>
          <select
            className="rec-select"
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            disabled={recording || busy}
          >
            <option value="">系统默认</option>
            {devices.map((d, i) => (
              <option key={d.deviceId || `device-${i}`} value={d.deviceId}>
                {d.label || `设备 ${i + 1}`}
              </option>
            ))}
          </select>
        </label>

        <div className="rec-level">
          <div className="rec-level-fill" style={{ width: `${Math.round(level * 100)}%` }} />
        </div>

        <div className="rec-status">
          {recording ? (
            <>
              <span className="rec-dot" />
              <span className="rec-time num">{msToShort(elapsedMs)}</span>
            </>
          ) : (
            <span className="rec-idle">{busy ? "正在导入…" : "就绪"}</span>
          )}
        </div>

        <div className="rec-actions">
          {!recording ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => void start()}
              disabled={busy}
            >
              {busy ? "导入中…" : "开始录音"}
            </button>
          ) : (
            <>
              <button type="button" className="btn-primary" onClick={() => stopCapture(false)}>
                停止并导入
              </button>
              <button type="button" className="btn-ghost" onClick={() => stopCapture(true)}>
                取消
              </button>
            </>
          )}
        </div>

        <p className="rec-note">录完的音频会转成 WAV 进素材箱，并接到音频轨末尾。</p>
      </div>
    </section>
  );
}
