/**
 * 效果库（AE「效果和预设」面板的蒸馏版）。
 *
 * 左栏分四格，对应 EC 参考 里一个面板解决的事：
 * - 效果：可搜索的分类列表，双击挂到当前图层；
 * - 预设：效果栈里右键存下的参数组合，双击直接套用；
 * - 转场：淡入 / 淡出这类片段级过渡；
 * - 3D 空间：图层 3D 开关 + 空间场景识别入口。
 *
 * 找效果的路径是「搜名字 → 双击」，不是「点菜单 → 找分类」。
 * 效果清单来自 core/effectCatalog（docs/02 第 D3 节），这里只做检索与派发。
 */

import { useEffect, useMemo, useState } from "react";
import { useAppStore, useSelectedClip } from "../store/appStore";
import { effectsByCategory, findEffect } from "../core/effectCatalog";
import type { EffectParamValue, EffectType } from "../types/effect";

/** 可加到图层上的效果，按分类摊平 */
const EFFECT_GROUPS = effectsByCategory()
  .map((group) => ({
    category: group.category,
    options: group.effects.filter((effect) => effect.addable),
  }))
  .filter((group) => group.options.length > 0);

/** 与 EffectStack 共用同一份本地预设 */
const PRESET_KEY = "reelix:fx-presets";

type ParamPreset = Record<string, EffectParamValue>;

function readPresets(): Array<{ type: EffectType; label: string; values: ParamPreset }> {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    return Object.entries(parsed as Record<string, ParamPreset>)
      .filter(([, values]) => values && typeof values === "object")
      .map(([type, values]) => ({
        type: type as EffectType,
        label: findEffect(type)?.label ?? type,
        values,
      }));
  } catch {
    return [];
  }
}

type BrowserTab = "effects" | "presets" | "transitions" | "spatial";

const TABS: Array<{ key: BrowserTab; label: string }> = [
  { key: "effects", label: "效果" },
  { key: "presets", label: "预设" },
  { key: "transitions", label: "转场" },
  { key: "spatial", label: "3D 空间" },
];

interface EffectsBrowserProps {
  /** 切到剪辑页的「空间」子页，做空间场景识别 */
  onOpenSpatial: () => void;
}

export function EffectsBrowser({ onOpenSpatial }: EffectsBrowserProps) {
  const clip = useSelectedClip();
  const addEffect = useAppStore((s) => s.addEffect);
  const setEffectParam = useAppStore((s) => s.setEffectParam);
  const addFade = useAppStore((s) => s.addFade);
  const setClip3DEnabled = useAppStore((s) => s.setClip3DEnabled);
  const [tab, setTab] = useState<BrowserTab>("effects");
  const [keyword, setKeyword] = useState("");
  const [openCategories, setOpenCategories] = useState<Set<string>>(
    () => new Set(EFFECT_GROUPS.map((g) => g.category))
  );
  const [picked, setPicked] = useState<EffectType | null>(null);
  const [presets, setPresets] = useState(readPresets);

  // 预设可能在效果栈里刚存过：切回这一格时重新读一次本地存储
  useEffect(() => {
    if (tab === "presets") setPresets(readPresets());
  }, [tab]);

  const groups = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    if (!key) return EFFECT_GROUPS;
    return EFFECT_GROUPS.map((g) => ({
      category: g.category,
      options: g.options.filter(
        (e) => e.label.toLowerCase().includes(key) || e.type.toLowerCase().includes(key)
      ),
    })).filter((g) => g.options.length > 0);
  }, [keyword]);

  const toggleCategory = (category: string) => {
    setOpenCategories((cur) => {
      const next = new Set(cur);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  /** 双击 / 回车：挂到这个图层上。挂完立刻选中新效果（AE 的应用后聚焦） */
  const apply = (type: EffectType) => {
    if (!clip) return;
    addEffect(clip.id, type);
    setPicked(type);
  };

  /** 套用保存过的预设：先挂同类效果，再把参数逐项写回去 */
  const applyPreset = (type: EffectType, values: ParamPreset) => {
    if (!clip) return;
    const before = useAppStore.getState().effects[clip.id]?.length ?? 0;
    addEffect(clip.id, type);
    const list = useAppStore.getState().effects[clip.id] ?? [];
    const created = list[before];
    if (!created || created.type !== type) return;
    for (const [key, value] of Object.entries(values)) {
      setEffectParam(created.id, key, value);
    }
    setPicked(type);
  };

  return (
    <section className="panel fx-browser">
      <div className="panel-head">
        <span className="title">效果库</span>
        <span className="title">{clip ? "双击添加" : "先选中片段"}</span>
      </div>

      <div className="fx-browser-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`fx-browser-tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "effects" && (
        <div className="bin-search">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索效果"
          />
        </div>
      )}

      <div className="panel-body">
        {!clip && tab !== "spatial" && (
          <div className="fx-browser-hint">在时间线上选中一个片段，这里列出的效果就能直接挂上去</div>
        )}

        {tab === "effects" && (
          <>
            {groups.length === 0 && <div className="fx-browser-hint">没有匹配的效果</div>}
            {groups.map((group) => {
              const open = keyword.trim() !== "" || openCategories.has(group.category);
              return (
                <div className="fx-browser-group" key={group.category}>
                  <button
                    type="button"
                    className="fx-browser-cat"
                    onClick={() => toggleCategory(group.category)}
                  >
                    <span>{open ? "▾" : "▸"}</span>
                    {group.category}
                    <span className="num">{group.options.length}</span>
                  </button>
                  {open &&
                    group.options.map((opt) => (
                      <button
                        key={opt.type}
                        type="button"
                        className={`fx-browser-item${picked === opt.type ? " selected" : ""}`}
                        disabled={!clip}
                        title={clip ? `双击加到「${clip.id}」这个图层` : "先在时间线上选中片段"}
                        onClick={() => setPicked(opt.type)}
                        onDoubleClick={() => apply(opt.type)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") apply(opt.type);
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                </div>
              );
            })}
          </>
        )}

        {tab === "presets" && (
          <>
            {presets.length === 0 && (
              <div className="fx-browser-hint">
                还没有预设。在右侧效果栈里右键一张效果，选「保存为预设」，这里就会出现
              </div>
            )}
            {presets.map((preset) => (
              <button
                key={preset.type}
                type="button"
                className="fx-browser-item fx-browser-preset"
                disabled={!clip}
                title={clip ? "双击把参数套到当前片段" : "先在时间线上选中片段"}
                onDoubleClick={() => applyPreset(preset.type, preset.values)}
              >
                <span>{preset.label}</span>
                <span className="num">{Object.keys(preset.values).length} 项</span>
              </button>
            ))}
          </>
        )}

        {tab === "transitions" && (
          <>
            <div className="fx-browser-hint">
              转场是片段自己的出入场过渡，时长按片段长度自动取一半（最多 0.5 秒）
            </div>
            <button
              type="button"
              className="fx-browser-item"
              disabled={!clip}
              onClick={() => clip && addFade(clip.id, "in")}
            >
              淡入
            </button>
            <button
              type="button"
              className="fx-browser-item"
              disabled={!clip}
              onClick={() => clip && addFade(clip.id, "out")}
            >
              淡出
            </button>
          </>
        )}

        {tab === "spatial" && (
          <>
            <div className="fx-browser-hint">
              3D 空间场景识别：对视频做相机解算，得到相机轨迹与稀疏点云，给 3D 图层、空间文字和视差动画做参照
            </div>
            <button
              type="button"
              className="fx-browser-action"
              onClick={onOpenSpatial}
            >
              打开空间识别
            </button>

            <div className="fx-browser-section-title">图层 3D</div>
            <button
              type="button"
              className={`fx-browser-item${clip?.enable3D ? " selected" : ""}`}
              disabled={!clip}
              onClick={() => clip && setClip3DEnabled(clip.id, !clip.enable3D)}
            >
              {clip?.enable3D ? "关闭 3D 图层" : "启用 3D 图层"}
            </button>
            <div className="fx-browser-hint">
              开启后可在右侧效果控件里调位置、旋转、锚点与朝向，3D 图层之间按 Z 深度排序
            </div>
          </>
        )}
      </div>
    </section>
  );
}
