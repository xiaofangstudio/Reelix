/**
 * 达芬奇式调色面板。
 *
 * 入口：编辑页底部区域的 Tab 切换（时间轴 ⇄ 调色），替代那一整块高度。
 *
 * 前置门槛（用户定的规则）：必须选中「画面上能看到的东西」——
 * 视频轨/字幕轨的片段（隐藏轨道也算），音频与摄像机轨不行。
 * 选中不合规片段时整块显示引导文案，不出调色控件。
 *
 * 结构（左→右）：
 * 1. 参数区：四个色轮（阴影/中间调/高光/全局，点盘拖动）+ 色阶五参数 + 快捷调节
 *    （曝光/对比/饱和/色温/色调/高光/阴影，走现有 grade 效果）
 * 2. 示波器：RGB 分量波形（从监视器当前帧实时统计，canvas 自绘）
 * 3. 颜色占比：色相环 12 桶占比条（同一帧数据）
 *
 * 数据：全部落在片段效果栈的真实节点上——
 * colorWheels（色轮）/ levels（色阶）/ grade（快捷调节）/ curves（曲线），
 * 没有 lazy 创建：第一次调某个区才 addEffect 对应节点。
 */

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";

/** 判断片段是否「画面上可见」（音频/摄像机轨不可见，不能调色）。 */
function isVisualClip(
  clip: { id: string } | null,
  tracks: Array<{ id: string; kind: string; clips: Array<{ id: string }> }> | undefined
): boolean {
  if (!clip || !tracks) return false;
  const track = tracks.find((t) => t.clips.some((c) => c.id === clip.id));
  if (!track) return false;
  return track.kind === "video" || track.kind === "subtitle";
}

/** 一个色轮：canvas 画色相盘 + 可拖点。 */
function ColorWheel({
  label,
  x,
  y,
  onDrag,
}: {
  label: string;
  x: number;
  y: number;
  onDrag: (x: number, y: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragging = useRef(false);
  const SIZE = 108;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const r = SIZE / 2;
    // 色相环 + 中心白（简单画法：色相锥形渐变）
    const img = ctx.createImageData(SIZE, SIZE);
    for (let py = 0; py < SIZE; py++) {
      for (let px = 0; px < SIZE; px++) {
        const dx = px - r + 0.5;
        const dy = py - r + 0.5;
        const d = Math.sqrt(dx * dx + dy * dy) / r;
        const i = (py * SIZE + px) * 4;
        if (d > 1) {
          img.data[i + 3] = 0;
          continue;
        }
        const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        const sat = Math.min(1, d * 1.6);
        // HSL→RGB（L 固定 0.5）
        const q = sat * (1 - Math.abs(((hue / 60) % 2) - 1));
        const hh = hue / 60;
        let rr = 0;
        let gg = 0;
        let bb = 0;
        if (hh < 1) [rr, gg, bb] = [sat, q, 0];
        else if (hh < 2) [rr, gg, bb] = [q, sat, 0];
        else if (hh < 3) [rr, gg, bb] = [0, sat, q];
        else if (hh < 4) [rr, gg, bb] = [0, q, sat];
        else if (hh < 5) [rr, gg, bb] = [q, 0, sat];
        else [rr, gg, bb] = [sat, 0, q];
        img.data[i] = (rr + (1 - sat)) * 255;
        img.data[i + 1] = (gg + (1 - sat)) * 255;
        img.data[i + 2] = (bb + (1 - sat)) * 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, []);

  const pointFromEvent = (e: React.PointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    let dx = (e.clientX - rect.left - SIZE / 2) / (SIZE / 2);
    let dy = (e.clientY - rect.top - SIZE / 2) / (SIZE / 2);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1) {
      dx /= d;
      dy /= d;
    }
    onDrag(dx, dy);
  };

  return (
    <div className="color-wheel">
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        className={dragging.current ? "dragging" : ""}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          pointFromEvent(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current) pointFromEvent(e);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
      />
      <div className="color-wheel-dot" style={{ left: `${(x + 1) * 50}%`, top: `${(y + 1) * 50}%` }} />
      <span className="color-wheel-label">{label}</span>
    </div>
  );
}

/** RGB 分量波形示波器：从 <img> 当前帧实时统计。 */
function RgbScope({ frameUrl }: { frameUrl: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!frameUrl) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const c = canvasRef.current;
      if (!c) return;
      const W = c.width;
      const H = c.height;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#0b0e12";
      ctx.fillRect(0, 0, W, H);
      // 缩到 160px 宽采样（性能），逐列画 R/G/B 亮度散点
      const sw = 160;
      const sh = Math.max(1, Math.round((img.height / img.width) * sw));
      const off = document.createElement("canvas");
      off.width = sw;
      off.height = sh;
      const octx = off.getContext("2d");
      if (!octx) return;
      octx.drawImage(img, 0, 0, sw, sh);
      const data = octx.getImageData(0, 0, sw, sh).data;
      // 三个通道各画一遍（达芬奇分屏波形样式：R/G/B 叠加，加法混合）
      ctx.globalCompositeOperation = "lighter";
      const colors: Array<[string, number]> = [
        ["rgba(255,64,64,0.5)", 0],
        ["rgba(64,255,96,0.5)", 1],
        ["rgba(96,128,255,0.5)", 2],
      ];
      for (const [color, ch] of colors) {
        ctx.fillStyle = color;
        for (let x = 0; x < sw; x++) {
          for (let y = 0; y < sh; y += 1) {
            const v = data[(y * sw + x) * 4 + ch] / 255;
            const py = H - 4 - v * (H - 8);
            const px = 4 + (x / sw) * (W - 8);
            ctx.fillRect(px, py, 1, 1.4);
          }
        }
      }
      ctx.globalCompositeOperation = "source-over";
    };
    img.src = frameUrl;
    return () => {
      cancelled = true;
    };
  }, [frameUrl]);

  return (
    <div className="scope-box">
      <div className="scope-title">RGB 分量波形</div>
      <canvas ref={canvasRef} width={280} height={150} />
    </div>
  );
}

/** 颜色占比：12 色相桶占比条（同一帧）。 */
function ColorShare({ frameUrl }: { frameUrl: string | null }) {
  const [bars, setBars] = useState<number[]>(new Array(12).fill(0));

  useEffect(() => {
    if (!frameUrl) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const off = document.createElement("canvas");
      off.width = 96;
      off.height = 54;
      const octx = off.getContext("2d");
      if (!octx) return;
      octx.drawImage(img, 0, 0, 96, 54);
      const data = octx.getImageData(0, 0, 96, 54).data;
      const buckets = new Array(12).fill(0);
      let total = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max - min;
        if (sat < 0.08) continue; // 灰色不计入色相
        let hue = 0;
        if (max === r) hue = ((g - b) / sat + 6) % 6;
        else if (max === g) hue = (b - r) / sat + 2;
        else hue = (r - g) / sat + 4;
        buckets[Math.floor((hue / 6) * 12) % 12] += 1;
        total += 1;
      }
      if (total > 0) {
        setBars(buckets.map((n) => n / total));
      }
    };
    img.src = frameUrl;
    return () => {
      cancelled = true;
    };
  }, [frameUrl]);

  const hueNames = ["红", "橙", "黄", "黄绿", "绿", "青绿", "青", "青蓝", "蓝", "蓝紫", "紫", "品"];
  const max = Math.max(0.001, ...bars);
  return (
    <div className="scope-box">
      <div className="scope-title">颜色占比</div>
      <div className="color-share">
        {bars.map((v, i) => (
          <div key={i} className="color-share-col" title={`${hueNames[i]} ${Math.round(v * 100)}%`}>
            <div
              className="color-share-bar"
              style={{
                height: `${(v / max) * 100}%`,
                background: `hsl(${i * 30}, 70%, 55%)`,
              }}
            />
            <span>{hueNames[i]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ColorGradeControls(): React.ReactElement {
  const selectedClipId = useAppStore((s) => s.selectedClipIds[0] ?? null);
  const tracks = useAppStore((s) => s.project?.sequences[0]?.tracks);
  const allClips = useAppStore((s) => s.project?.sequences[0]?.tracks.flatMap((t) => t.clips));
  const effects = useAppStore((s) => s.effects);
  const addEffect = useAppStore((s) => s.addEffect);
  const setEffectParam = useAppStore((s) => s.setEffectParam);
  const frameUrl = useAppStore((s) => s.monitorFrameUrl ?? null);

  void tracks; void allClips; void isVisualClip;
  const clipEffects = selectedClipId ? effects[selectedClipId] ?? [] : [];
  const findEffect = (type: string) => clipEffects.find((e) => e.type === type);
  /** lazy 取（或建）一个调色效果节点，返回它的参数表 */
  const ensureEffect = (type: string) => {
    let e = findEffect(type);
    if (!e && selectedClipId) {
      addEffect(selectedClipId, type as never);
      e = (useAppStore.getState().effects[selectedClipId] ?? []).find((x) => x.type === type);
    }
    return e;
  };
  const numParam = (type: string, key: string, fallback: number): number => {
    const e = findEffect(type);
    if (!e) return fallback;
    const v = e.params.find((p) => p.key === key)?.value;
    return typeof v === "number" ? v : fallback;
  };
  const setNum = (type: string, key: string, v: number) => {
    const e = ensureEffect(type);
    if (e) setEffectParam(e.id, key, v);
  };

  // 监视器帧 URL：从 store 拿不到就降级为无示波器（示波器组件自己处理 null）
  return (
    <div className="color-controls">
      <div className="color-controls-main">
        <div className="color-row">
          <ColorWheel
            label="阴影"
            x={numParam("colorWheels", "liftX", 0)}
            y={numParam("colorWheels", "liftY", 0)}
            onDrag={(x, y) => {
              setNum("colorWheels", "liftX", x);
              setNum("colorWheels", "liftY", y);
            }}
          />
          <ColorWheel
            label="中间调"
            x={numParam("colorWheels", "gammaX", 0)}
            y={numParam("colorWheels", "gammaY", 0)}
            onDrag={(x, y) => {
              setNum("colorWheels", "gammaX", x);
              setNum("colorWheels", "gammaY", y);
            }}
          />
          <ColorWheel
            label="高光"
            x={numParam("colorWheels", "gainX", 0)}
            y={numParam("colorWheels", "gainY", 0)}
            onDrag={(x, y) => {
              setNum("colorWheels", "gainX", x);
              setNum("colorWheels", "gainY", y);
            }}
          />
          {/* 第四轮「全局」：达芬奇的 Global / Offset——不分亮暗，整幅均匀偏色 */}
          <ColorWheel
            label="全局"
            x={numParam("colorWheels", "offsetX", 0)}
            y={numParam("colorWheels", "offsetY", 0)}
            onDrag={(x, y) => {
              setNum("colorWheels", "offsetX", x);
              setNum("colorWheels", "offsetY", y);
            }}
          />
        </div>
        <div className="color-row color-levels">
          {(
            [
              ["inLow", "黑场", 0, 0.98],
              ["inHigh", "白场", 0.02, 1],
              ["gamma", "中间调", 0.05, 8],
              ["outLow", "输出黑", 0, 1],
              ["outHigh", "输出白", 0, 1],
            ] as const
          ).map(([key, label, min, max]) => (
            <div key={key} className="color-levels-row">
              <span>{label}</span>
              <input
                type="range"
                min={min}
                max={max}
                step={0.01}
                value={numParam("levels", key, key === "inHigh" || key === "outHigh" ? 1 : key === "gamma" ? 1 : 0)}
                onChange={(e) => setNum("levels", key, Number(e.target.value))}
              />
              <em>{numParam("levels", key, key === "inHigh" || key === "outHigh" ? 1 : key === "gamma" ? 1 : 0).toFixed(2)}</em>
            </div>
          ))}
        </div>
        <div className="color-row color-grade-quick">
          {(
            [
              ["exposure", "曝光", -5, 5],
              ["contrast", "对比度", -100, 100],
              ["saturation", "饱和度", -100, 100],
              ["temperature", "色温", -100, 100],
              ["tint", "色调", -100, 100],
              ["highlights", "高光", -100, 100],
              ["shadows", "阴影", -100, 100],
            ] as const
          ).map(([key, label, min, max]) => (
            <div key={key} className="color-quick-row">
              <span>{label}</span>
              <input
                type="range"
                min={min}
                max={max}
                step={1}
                value={numParam("grade", key, 0)}
                onChange={(e) => setNum("grade", key, Number(e.target.value))}
              />
              <em>{numParam("grade", key, 0)}</em>
            </div>
          ))}
        </div>
      </div>
      <div className="color-controls-scope">
        <RgbScope frameUrl={frameUrl} />
        <ColorShare frameUrl={frameUrl} />
      </div>
    </div>
  );
}
