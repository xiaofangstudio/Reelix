/**
 * 开场界面。
 *
 * 启动时没有工程就停在这里：先定工程名、分辨率、帧率、色彩空间，再进编辑器；
 * 已经有工程时它由「文件 → 新建工程」唤起，可以直接取消、回到原来那份工程。
 *
 * 按规矩，这里只调 store/projectActions，不直接碰 Tauri IPC；失败提示由动作层兜。
 */

import { useState } from "react";
import { useAppStore } from "../store/appStore";
import { newProject, openProject, openProjectAt } from "../store/projectActions";
import { loadRecentProjects } from "../core/recentProjects";

/** 分辨率档位，最后一项是「自定义」 */
const RESOLUTIONS = [
  { label: "1920 × 1080　全高清", width: 1920, height: 1080 },
  { label: "3840 × 2160　超高清 4K", width: 3840, height: 2160 },
  { label: "2560 × 1440　四倍高清", width: 2560, height: 1440 },
  { label: "1280 × 720　高清", width: 1280, height: 720 },
  { label: "1080 × 1920　竖屏", width: 1080, height: 1920 },
  { label: "1080 × 1080　方形", width: 1080, height: 1080 },
] as const;

/** 「自定义」在下来菜单里的取值 */
const CUSTOM = "custom";

const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
const COLOR_SPACES = ["Rec.709", "Rec.2020", "sRGB"];
const DEFAULT_NAME = "未命名项目";

/** 把输入框里的数夹到 1 ~ 16384 的整数，越界就退默认值。 */
function clampSize(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > 16384) return fallback;
  return rounded;
}

/** 分辨率档位的下拉取值，如 "1920x1080" */
function presetKey(width: number, height: number): string {
  return `${width}x${height}`;
}

export function StartScreen() {
  const hasProject = useAppStore((s) => s.project !== null);
  const hideStartScreen = useAppStore((s) => s.hideStartScreen);

  const [name, setName] = useState(DEFAULT_NAME);
  const [preset, setPreset] = useState(presetKey(1920, 1080));
  const [customWidth, setCustomWidth] = useState(1920);
  const [customHeight, setCustomHeight] = useState(1080);
  const [frameRate, setFrameRate] = useState(25);
  const [colorSpace, setColorSpace] = useState("Rec.709");
  const [busy, setBusy] = useState(false);

  const recent = loadRecentProjects();

  /** 把界面上的选择收成一份画幅设置；自定义档用输入框里的值。 */
  const collectSettings = () => {
    const chosen = RESOLUTIONS.find((r) => presetKey(r.width, r.height) === preset);
    if (chosen) {
      return { width: chosen.width, height: chosen.height, frameRate, colorSpace };
    }
    return {
      width: clampSize(customWidth, 1920),
      height: clampSize(customHeight, 1080),
      frameRate,
      colorSpace,
    };
  };

  /** 跑一个会改动工程的异步动作，期间锁住按钮，避免连点建出两份工程。 */
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(() => newProject(name.trim() === "" ? DEFAULT_NAME : name.trim(), collectSettings()));

  return (
    <div className="start-screen">
      <div className="start-card">
        <div className="start-brand">
          Reelix<span className="dot">.</span>
        </div>
        <p className="start-tagline">特效合成与合成预览，先定画幅，再开工程。</p>

        <label className="start-field">
          <span className="start-label">工程名</span>
          <input
            className="start-input"
            type="text"
            value={name}
            maxLength={80}
            placeholder={DEFAULT_NAME}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="start-field">
          <span className="start-label">分辨率</span>
          <select
            className="start-select"
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
          >
            {RESOLUTIONS.map((r) => (
              <option key={presetKey(r.width, r.height)} value={presetKey(r.width, r.height)}>
                {r.label}
              </option>
            ))}
            <option value={CUSTOM}>自定义…</option>
          </select>
        </label>

        {preset === CUSTOM && (
          <div className="start-field start-field-custom">
            <span className="start-label">画幅（像素）</span>
            <div className="start-custom-row">
              <input
                className="start-input start-input-num"
                type="number"
                min={1}
                max={16384}
                value={customWidth}
                onChange={(e) => setCustomWidth(Number(e.target.value))}
              />
              <span className="start-times">×</span>
              <input
                className="start-input start-input-num"
                type="number"
                min={1}
                max={16384}
                value={customHeight}
                onChange={(e) => setCustomHeight(Number(e.target.value))}
              />
            </div>
          </div>
        )}

        <div className="start-grid">
          <label className="start-field">
            <span className="start-label">帧率</span>
            <select
              className="start-select"
              value={String(frameRate)}
              onChange={(e) => setFrameRate(Number(e.target.value))}
            >
              {FRAME_RATES.map((fps) => (
                <option key={fps} value={String(fps)}>
                  {fps} fps
                </option>
              ))}
            </select>
          </label>

          <label className="start-field">
            <span className="start-label">色彩空间</span>
            <select
              className="start-select"
              value={colorSpace}
              onChange={(e) => setColorSpace(e.target.value)}
            >
              {COLOR_SPACES.map((cs) => (
                <option key={cs} value={cs}>
                  {cs}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="start-actions">
          <button type="button" className="btn-primary" onClick={create} disabled={busy}>
            创建工程
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void run(() => openProject())}
            disabled={busy}
          >
            打开已有工程…
          </button>
          {hasProject && (
            <button
              type="button"
              className="btn-ghost"
              onClick={hideStartScreen}
              disabled={busy}
            >
              取消
            </button>
          )}
        </div>

        <div className="start-recent">
          <div className="start-recent-head">打开最近工程</div>
          {recent.length === 0 ? (
            <div className="start-recent-empty">还没有打开过工程</div>
          ) : (
            <div className="start-recent-list">
              {recent.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  className="start-recent-item"
                  title={item.path}
                  disabled={busy}
                  onClick={() => void run(() => openProjectAt(item.path))}
                >
                  <span className="start-recent-name">{item.name}</span>
                  <span className="start-recent-path">{item.path}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
