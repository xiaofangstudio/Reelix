/*
 * Reelix 启动页 —— 应用正常启动的第一屏。
 * 注意：这不是欢迎页（StartScreen），欢迎页在加载完成后出现，保持原样未动。
 * 与 Strata 启动页同一家布局：背景图 + 左侧黑色渐晕 + 超粗应用名 + 应用信息 + 加载进度。
 * 节奏刻意放慢，整屏停留约 4 秒再淡出。
 */
import { useEffect, useState } from "react";
import bg from "../assets/splash-bg.jpg";
import "./Splash.css";

const STEPS = [
  "正在加载解码器（ffmpeg）",
  "正在扫描效果目录",
  "正在连接渲染管线",
  "正在载入预览缓存",
  "正在打开工作区",
];

const STEP_MS = 640;   // 每一步的停留
const HOLD_MS = 420;   // 最后一步走完再停一下
const FADE_MS = 620;   // 淡出时长

export default function Splash({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    // 按 ESC 随时跳过启动页
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !cancelled) onDone();
    };
    window.addEventListener("keydown", onKey);

    (async () => {
      // 字体可能永远 ready 不了（离线字形、字体服务异常），最多等 1.2 秒就往下走
      const fontsReady = Promise.race([
        document.fonts?.ready ?? Promise.resolve(),
        wait(1200),
      ]);
      for (let i = 0; i < STEPS.length; i++) {
        await wait(STEP_MS);
        if (cancelled) return;
        setStep(i + 1);
      }
      await fontsReady;
      if (cancelled) return;
      await wait(HOLD_MS);
      if (cancelled) return;
      setFading(true);
      await wait(FADE_MS);
      if (!cancelled) onDone();
    })();

    // 硬兜底：无论上面卡在哪一步，最多 7 秒一定撤掉启动页，绝不挡住主界面
    const hardStop = setTimeout(() => { if (!cancelled) onDone(); }, 7000);

    return () => { cancelled = true; clearTimeout(hardStop); window.removeEventListener("keydown", onKey); };
  }, [onDone]);

  const pct = Math.round((step / STEPS.length) * 100);

  return (
    <div className={"splash" + (fading ? " splash--fading" : "")} style={{ backgroundImage: `url(${bg})` }}>
      <div className="splash__inner">
        <div className="splash__name">Reelix</div>
        <div className="splash__meta">Reelix 1.0.8 · 小方工作室 · 特效合成软件，剪辑是它的附属能力</div>
        <div className="splash__loading">
          {STEPS[Math.min(step, STEPS.length - 1)]}…
          <span className="splash__pct">{pct}%</span>
        </div>
        <div className="splash__bar"><i style={{ width: `${pct}%` }} /></div>
      </div>
      {/* 底部信息条：左版权、右版本与跳过提示 */}
      <div className="splash__bottom">
        <span className="splash__bottom-copy">© 2026 小方工作室 · XiaoFang Studio</span>
        <span className="splash__bottom-ver">Reelix 1.0.8 · 本地渲染引擎（ffmpeg）· 按 ESC 跳过</span>
      </div>
    </div>
  );
}
