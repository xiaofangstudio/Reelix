/**
 * 设置面板（模态框）。
 *
 * 主题 / 预览缩放 / 自动保存 / 缓存四组，全部落在后端 settings.json
 * （%APPDATA%\Reelix\settings.json）——没有云端、没有账号，配置只存在本机。
 * 主题改完立即同步到 store：<html data-theme> 当场换肤，不用重启。
 *
 * 打开时拉一份后端设置；每个控件改了立刻写回后端，不积压到「确定」——
 * 设置是低频操作，但「改了没生效」的体感很差。
 */

import { useEffect, useState } from "react";
import { useAppStore } from "../store/appStore";
import { getSettings, setSettings, type Settings } from "../services/settings";
import { clearCache, getCacheStats } from "../services/render";
import { setPreviewQuality } from "../services/render";

/** 缓存上限的可选档位（字节） */
const CACHE_LIMITS: Array<{ label: string; bytes: number }> = [
  { label: "2 GB", bytes: 2 * 1024 * 1024 * 1024 },
  { label: "5 GB", bytes: 5 * 1024 * 1024 * 1024 },
  { label: "20 GB", bytes: 20 * 1024 * 1024 * 1024 },
  { label: "50 GB", bytes: 50 * 1024 * 1024 * 1024 },
];

/** 自动保存间隔的可选档位（毫秒；0 = 关闭） */
const AUTO_SAVES: Array<{ label: string; ms: number }> = [
  { label: "关闭", ms: 0 },
  { label: "1 分钟", ms: 60_000 },
  { label: "5 分钟", ms: 5 * 60_000 },
  { label: "15 分钟", ms: 15 * 60_000 },
];

/** 静止图片上轨默认时长的可选档位（毫秒） */
const IMAGE_DURATIONS: Array<{ label: string; ms: number }> = [
  { label: "2 秒", ms: 2000 },
  { label: "3 秒", ms: 3000 },
  { label: "5 秒", ms: 5000 },
  { label: "8 秒", ms: 8000 },
  { label: "10 秒", ms: 10_000 },
];

/** 默认转场 / 淡入淡出时长的可选档位（毫秒） */
const TRANSITION_DURATIONS: Array<{ label: string; ms: number }> = [
  { label: "0.25 秒", ms: 250 },
  { label: "0.5 秒", ms: 500 },
  { label: "1 秒", ms: 1000 },
  { label: "1.5 秒", ms: 1500 },
  { label: "2 秒", ms: 2000 },
];

/** 默认字幕时长的可选档位（毫秒） */
const SUBTITLE_DURATIONS: Array<{ label: string; ms: number }> = [
  { label: "1.5 秒", ms: 1500 },
  { label: "2 秒", ms: 2000 },
  { label: "3 秒", ms: 3000 },
  { label: "5 秒", ms: 5000 },
];

/** 新建工程默认画幅预设 */
const FRAME_SIZES: Array<{ label: string; w: number; h: number }> = [
  { label: "1920×1080（1080p）", w: 1920, h: 1080 },
  { label: "1280×720（720p）", w: 1280, h: 720 },
  { label: "2560×1440（2K）", w: 2560, h: 1440 },
  { label: "3840×2160（4K）", w: 3840, h: 2160 },
  { label: "1080×1920（竖屏）", w: 1080, h: 1920 },
];

/** 新建工程默认帧率档位 */
const FRAME_RATES: Array<number> = [24, 25, 30, 50, 60];

function bytesLabel(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// 拉不到后端设置时顶着的默认值，与 Rust Settings::default() 一一对应
const FALLBACK_SETTINGS: Settings = {
  cacheDir: "",
  cacheLimitBytes: 20 * 1024 * 1024 * 1024,
  previewScale: 1,
  autoSaveIntervalMs: 5 * 60_000,
  language: "zh-CN",
  theme: "light",
  imageDefaultMs: 5000,
  transitionDefaultMs: 500,
  subtitleDefaultMs: 3000,
  defaultWidth: 1920,
  defaultHeight: 1080,
  defaultFrameRate: 25,
  snapEnabled: true,
};

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [cache, setCache] = useState<{ memoryBytes: number; diskBytes: number } | null>(null);
  const [busy, setBusy] = useState(false);

  // 打开就拉后端设置与缓存占用
  useEffect(() => {
    void (async () => {
      try {
        const [s, stats] = await Promise.all([getSettings(), getCacheStats()]);
        setSettingsState(s);
        setCache({ memoryBytes: stats.memoryBytes, diskBytes: stats.diskBytes });
      } catch {
        // 拉不到设置不阻塞面板：用一份默认值顶着，保存时再写回去
        setSettingsState(FALLBACK_SETTINGS);
      }
    })();
  }, []);

  /** 改一项就整体写回后端（设置小，全量写最稳） */
  const patch = async (next: Partial<Settings>) => {
    if (!settings) return;
    const merged = { ...settings, ...next };
    setSettingsState(merged);
    try {
      await setSettings(merged);
    } catch (err) {
      useAppStore.getState().pushNotice("error", err instanceof Error ? err.message : String(err));
    }
  };

  /** 主题：store 立即换肤 + 写回后端（下次启动还是这个主题） */
  const changeTheme = (mode: "light" | "dark") => {
    setTheme(mode);
    void patch({ theme: mode });
  };

  const refreshCache = async () => {
    try {
      const stats = await getCacheStats();
      setCache({ memoryBytes: stats.memoryBytes, diskBytes: stats.diskBytes });
    } catch {
      /* 缓存统计失败不打扰用户 */
    }
  };

  const clearAllCache = async () => {
    setBusy(true);
    try {
      await clearCache("all");
      await refreshCache();
      useAppStore.getState().pushNotice("info", "缓存已清空");
    } catch (err) {
      useAppStore.getState().pushNotice("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** 全部恢复出厂值：保留缓存目录与当前主题（主题由 store 管），其余归位 */
  const resetAll = async () => {
    if (!settings) return;
    const next: Settings = {
      ...FALLBACK_SETTINGS,
      cacheDir: settings.cacheDir,
      theme: theme as Settings["theme"],
    };
    setBusy(true);
    try {
      const saved = await setSettings(next);
      setSettingsState({ ...saved, cacheDir: settings.cacheDir });
      useAppStore.getState().pushNotice("info", "已恢复默认设置");
    } catch (err) {
      useAppStore.getState().pushNotice("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="settings-mask" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <span className="settings-title">偏好设置</span>
          <button type="button" className="ctl-btn" onClick={onClose} title="关闭（ESC）">
            关闭
          </button>
        </div>

        {!settings ? (
          <div className="settings-body settings-loading">正在读取设置…</div>
        ) : (
          <div className="settings-body">
            {/* 主题：浅色（默认）/ 深色。改完立即换肤并记住 */}
            <section className="settings-group">
              <div className="group-title">主题</div>
              <div className="settings-row">
                <span className="label">界面主题</span>
                <div className="settings-seg">
                  <button
                    type="button"
                    className={`ctl-btn${theme === "light" ? " on" : ""}`}
                    onClick={() => changeTheme("light")}
                  >
                    浅色
                  </button>
                  <button
                    type="button"
                    className={`ctl-btn${theme === "dark" ? " on" : ""}`}
                    onClick={() => changeTheme("dark")}
                  >
                    深色
                  </button>
                </div>
              </div>
              <div className="settings-note">绿色雾林主题；浅色为默认，深色为长时间剪辑准备。</div>
            </section>

            {/* 预览缩放：低配机降采样换流畅 */}
            <section className="settings-group">
              <div className="group-title">预览性能</div>
              <div className="settings-row">
                <span className="label">预览分辨率</span>
                <input
                  type="range"
                  min={0.25}
                  max={1}
                  step={0.25}
                  value={settings.previewScale}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    void patch({ previewScale: v });
                    void setPreviewQuality(v);
                  }}
                />
                <em className="prop-num">
                  {settings.previewScale >= 1 ? "完整" : `1/${Math.round(1 / settings.previewScale)}`}
                </em>
              </div>
              <div className="settings-note">画面卡顿时降到 1/2 或 1/4，导出仍按完整分辨率。</div>
            </section>

            {/* 自动保存：间隔可调 / 可关。只在工程落过盘且有改动时写 */}
            <section className="settings-group">
              <div className="group-title">工程</div>
              <div className="settings-row">
                <span className="label">自动保存</span>
                <select
                  className="value num"
                  value={String(settings.autoSaveIntervalMs)}
                  onChange={(e) => void patch({ autoSaveIntervalMs: Number(e.target.value) })}
                >
                  {AUTO_SAVES.map((a) => (
                    <option key={a.ms} value={String(a.ms)}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-note">
                工程第一次手动保存（Ctrl+S）之后才会自动保存；没有未保存改动时不会反复写盘。
              </div>
            </section>

            {/* 缓存：目录 / 上限 / 占用 / 清理 */}
            <section className="settings-group">
              <div className="group-title">缓存</div>
              <div className="settings-row">
                <span className="label">缓存目录</span>
                <span className="settings-path" title={settings.cacheDir}>
                  {settings.cacheDir || "默认目录"}
                </span>
              </div>
              <div className="settings-row">
                <span className="label">容量上限</span>
                <select
                  className="value num"
                  value={String(settings.cacheLimitBytes)}
                  onChange={(e) => void patch({ cacheLimitBytes: Number(e.target.value) })}
                >
                  {CACHE_LIMITS.map((c) => (
                    <option key={c.bytes} value={String(c.bytes)}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-row">
                <span className="label">当前占用</span>
                <span className="settings-path">
                  {cache
                    ? `内存 ${bytesLabel(cache.memoryBytes)} · 磁盘 ${bytesLabel(cache.diskBytes)}`
                    : "统计中…"}
                </span>
                <button
                  type="button"
                  className="ctl-btn"
                  disabled={busy}
                  onClick={() => void clearAllCache()}
                  title="清空预览帧缓存（内存 + 磁盘），不影响工程文件"
                >
                  {busy ? "清理中…" : "清理缓存"}
                </button>
              </div>
            </section>

            {/* 编辑默认值：图片上轨、加字幕、加转场时的初始时长 */}
            <section className="settings-group">
              <div className="group-title">编辑默认值</div>
              <div className="settings-row">
                <span className="label">静止图片默认时长</span>
                <select
                  className="value num"
                  value={String(settings.imageDefaultMs)}
                  onChange={(e) => void patch({ imageDefaultMs: Number(e.target.value) })}
                >
                  {IMAGE_DURATIONS.map((d) => (
                    <option key={d.ms} value={String(d.ms)}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-row">
                <span className="label">默认字幕时长</span>
                <select
                  className="value num"
                  value={String(settings.subtitleDefaultMs)}
                  onChange={(e) => void patch({ subtitleDefaultMs: Number(e.target.value) })}
                >
                  {SUBTITLE_DURATIONS.map((d) => (
                    <option key={d.ms} value={String(d.ms)}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-row">
                <span className="label">默认转场时长</span>
                <select
                  className="value num"
                  value={String(settings.transitionDefaultMs)}
                  onChange={(e) => void patch({ transitionDefaultMs: Number(e.target.value) })}
                >
                  {TRANSITION_DURATIONS.map((d) => (
                    <option key={d.ms} value={String(d.ms)}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-note">
                决定素材刚放上时间线时的初始时长；上轨后仍可单独拖片段两端改，互不影响。
              </div>
            </section>

            {/* 新建工程的默认画幅与帧率 */}
            <section className="settings-group">
              <div className="group-title">新建工程默认</div>
              <div className="settings-row">
                <span className="label">画幅</span>
                <select
                  className="value num"
                  value={`${settings.defaultWidth}x${settings.defaultHeight}`}
                  onChange={(e) => {
                    const [w, h] = e.target.value.split("x").map(Number);
                    void patch({ defaultWidth: w, defaultHeight: h });
                  }}
                >
                  {FRAME_SIZES.map((f) => (
                    <option key={`${f.w}x${f.h}`} value={`${f.w}x${f.h}`}>
                      {f.label}
                    </option>
                  ))}
                  {/* 当前值不在预设里也别让它悄悄跳回第一项 */}
                  {FRAME_SIZES.some(
                    (f) => f.w === settings.defaultWidth && f.h === settings.defaultHeight
                  ) ? null : (
                    <option value={`${settings.defaultWidth}x${settings.defaultHeight}`}>
                      自定义 {settings.defaultWidth}×{settings.defaultHeight}
                    </option>
                  )}
                </select>
              </div>
              <div className="settings-row">
                <span className="label">帧率</span>
                <select
                  className="value num"
                  value={String(settings.defaultFrameRate)}
                  onChange={(e) => void patch({ defaultFrameRate: Number(e.target.value) })}
                >
                  {FRAME_RATES.map((r) => (
                    <option key={r} value={String(r)}>
                      {r} fps
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-note">
                新建工程窗口会带上这两个值；拖入首个视频素材时仍会按素材规格自动适配。
              </div>
            </section>

            {/* 时间线吸附 */}
            <section className="settings-group">
              <div className="group-title">时间线</div>
              <div className="settings-row">
                <span className="label">拖动吸附</span>
                <div className="settings-seg">
                  <button
                    type="button"
                    className={`ctl-btn${settings.snapEnabled ? " on" : ""}`}
                    onClick={() => void patch({ snapEnabled: true })}
                  >
                    开
                  </button>
                  <button
                    type="button"
                    className={`ctl-btn${settings.snapEnabled ? "" : " on"}`}
                    onClick={() => void patch({ snapEnabled: false })}
                  >
                    关
                  </button>
                </div>
              </div>
              <div className="settings-note">
                靠近片段端点、播放头、标记时自动吸附；关掉后完全按松手时的位置摆放。
              </div>
            </section>

            {/* 语言：全中文界面，固定项 */}
            <section className="settings-group">
              <div className="group-title">语言</div>
              <div className="settings-row">
                <span className="label">界面语言</span>
                <select className="value num" value="zh-CN" disabled>
                  <option value="zh-CN">简体中文</option>
                </select>
              </div>
              <div className="settings-note">当前版本只有简体中文。</div>
            </section>
          </div>
        )}

        <div className="settings-foot">
          <span>设置保存在本机 %APPDATA%\Reelix\settings.json，每步改动即时生效</span>
          <button
            type="button"
            className="ctl-btn"
            disabled={busy}
            onClick={() => void resetAll()}
            title="把所有偏好项恢复成出厂值（不会动工程文件和缓存目录）"
          >
            恢复默认设置
          </button>
        </div>
      </div>
    </div>
  );
}
