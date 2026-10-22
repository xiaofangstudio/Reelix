/*
 * Reelix 启动页 —— 应用正常启动的第一屏。
 * 注意：这不是欢迎页（StartScreen），欢迎页在加载完成后出现，保持原样未动。
 * 与 Strata 启动页同一家布局：背景图 + 左侧黑色渐晕 + 超粗应用名 + 应用信息 + 加载进度。
 */
import { useEffect, useRef, useState } from "react";
import bg from "../assets/splash-bg.jpg";
import "./Splash.css";

const STEPS = [
  "正在加载解码器（ffmpeg）",
  "正在准备效果目录",
  "正在连接渲染管线",
  "正在打开工作区",
];

export default function Splash({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [fading, setFading] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      const fontsReady = document.fonts?.ready ?? Promise.resolve();
      for (let i = 0; i < STEPS.length; i++) {
        if (!alive.current) return;
        await wait(340);
        if (!alive.current) return;
        setStep(i + 1);
      }
      await fontsReady;
      if (!alive.current) return;
      await wait(180);
      setFading(true);
      setTimeout(() => alive.current && onDone(), 520);
    })();
    return () => { alive.current = false; };
  }, [onDone]);

  const pct = Math.round((step / STEPS.length) * 100);

  return (
    <div className={"splash" + (fading ? " splash--fading" : "")} style={{ backgroundImage: `url(${bg})` }}>
      <div className="splash__inner">
        <div className="splash__name">Reelix</div>
        <div className="splash__meta">Reelix 0.1.0 · 小方工作室 · 特效合成软件，剪辑是它的附属能力</div>
        <div className="splash__loading">{STEPS[Math.min(step, STEPS.length - 1)]}…</div>
        <div className="splash__bar"><i style={{ width: `${pct}%` }} /></div>
      </div>
    </div>
  );
}
