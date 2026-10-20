/**
 * 剪辑页左上角的「工具区」（剪映式：一排页签点开切换内容）。
 *
 * 页签：素材 / 音频 / 文字 / 默认素材 / 默认音频 / 贴纸 / 画中画 / 摄像机 /
 *       特效 / 全局属性 / 粒子——点击**真的换整块内容**。
 * - 素材 / 音频 / 画中画：本工程素材（按类型过滤，可拖上轨、双击预览、离线 404）
 * - 文字：文字预设（点击给选中片段挂文字效果）
 * - 默认素材：白底 / 黑场 / 彩条 / 颜色遮罩（点击真生成并落到视频轨末尾）
 * - 摄像机：3D 空间识别（COLMAP，真入口）
 * - 特效：效果库（真效果清单）
 * - 全局属性：序列信息（真数据）
 * - 粒子：粒子效果预设（真挂效果）
 * - 默认音频 / 贴纸：**没有素材源**——诚实显示"待接入"，不放假列表
 *
 * 导入入口在「素材」页签内（用户要求：素材库顶部不再放上传按钮，
 * 导入只能从素材页签里的上传位置开始，导入后自动分音频/视频）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore, useAssets } from "../store/appStore";
import { importMedia, createGeneratorAsset } from "../store/projectActions";
import { dialog, generators } from "../services";
import { useThumbUrl } from "../hooks/useThumbUrl";
import { msToChinese } from "../core/timecode";
import { EFFECT_CATALOG } from "../core/effectCatalog";
import { beginAssetDrag, endAssetDrag } from "../core/assetDragBridge";
import { timeline as timelineApi } from "../services";
import { refreshProject } from "../store/projectActions";
import {
  IconTabMedia,
  IconTabAudio,
  IconTabText,
  IconTabSolid,
  IconTabSound,
  IconTabSticker,
  IconTabPip,
  IconTabCamera,
  IconTabFx,
  IconTabGlobal,
  IconTabParticles,
} from "./icons";
import type { Asset } from "../types/project";

/** 工具区页签（剪映式一级分类） */
type BinTab =
  | "media"
  | "audio"
  | "text"
  | "generators"
  | "defaultAudio"
  | "stickers"
  | "pip"
  | "camera"
  | "effects"
  | "global"
  | "particles";

const TABS: Array<{
  key: BinTab;
  label: string;
  icon: () => JSX.Element;
}> = [
  { key: "media", label: "素材", icon: IconTabMedia },
  { key: "audio", label: "音频", icon: IconTabAudio },
  { key: "text", label: "文字", icon: IconTabText },
  { key: "generators", label: "默认素材", icon: IconTabSolid },
  { key: "defaultAudio", label: "默认音频", icon: IconTabSound },
  { key: "stickers", label: "贴纸", icon: IconTabSticker },
  { key: "pip", label: "画中画", icon: IconTabPip },
  { key: "camera", label: "摄像机", icon: IconTabCamera },
  { key: "effects", label: "特效", icon: IconTabFx },
  { key: "global", label: "全局属性", icon: IconTabGlobal },
  { key: "particles", label: "粒子", icon: IconTabParticles },
];

/** 文字预设：灰底白字「小方工作室」字体预览（不同字体） */
const TEXT_PRESETS: Array<{
  id: string;
  name: string;
  sample: string;
  size: number;
  color: string;
  fontFamily: string;
  fontWeight: number;
}> = [
  { id: "title", name: "标题 · 黑体", sample: "小方工作室", size: 96, color: "#ffffff", fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif', fontWeight: 700 },
  { id: "subtitle", name: "字幕 · 常规", sample: "小方工作室", size: 48, color: "#ffffff", fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif', fontWeight: 400 },
  { id: "caption-brand", name: "品牌字 · 宋", sample: "小方工作室", size: 64, color: "#ffffff", fontFamily: '"Songti SC", "SimSun", serif', fontWeight: 600 },
  { id: "caption-ink", name: "品牌字 · 等宽", sample: "小方工作室", size: 72, color: "#ffffff", fontFamily: '"JetBrains Mono", "Consolas", monospace', fontWeight: 500 },
];

const KIND_LABEL: Record<Asset["kind"], string> = {
  video: "视频",
  audio: "音频",
  image: "图片",
  imageSequence: "序列",
};

export function BinPanel() {
  const [tab, setTab] = useState<BinTab>("media");
  const [keyword, setKeyword] = useState("");
  const [importing, setImporting] = useState(false);
  const hasProject = useAppStore((s) => s.project !== null);
  const setPreviewAsset = useAppStore((s) => s.setPreviewAsset);
  const previewAssetId = useAppStore((s) => s.previewAssetId);
  const setPickedAsset = useAppStore((s) => s.setPickedAsset);
  const selectedCount = useAppStore((s) => s.selectedClipIds.length);
  const addEffect = useAppStore((s) => s.addEffect);

  const handleImport = async () => {
    setImporting(true);
    try {
      await importMedia();
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="panel bin-panel">
      {/* 工具区页签：竖排纯 icon（用户要求：和之前一样竖着、全是 icon 没有文字） */}
      <div className="bin-tabs" role="tablist">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              aria-label={t.label}
              className={`bin-tab${tab === t.key ? " active" : ""}`}
              title={t.label}
              onClick={() => {
                setTab(t.key);
                setKeyword("");
              }}
            >
              <span className="bin-tab-icon">
                <Icon />
              </span>
            </button>
          );
        })}
      </div>

      {/* 右侧内容列：搜索 + 导入 + 列表（必须竖排，否则会横着排被挤到最右只剩边边） */}
      <div className="bin-content">
      {/* 搜索框：对当前页签真过滤 */}
      <div className="bin-search">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={tab === "media" ? "搜索素材" : tab === "audio" ? "搜索音频" : "搜索"}
        />
      </div>

      {tab === "media" && (
        <>
          {/* 导入入口：只在素材页签里（用户要求素材库顶部不放上传按钮） */}
          <div className="bin-import-row">
            <button
              type="button"
              className="bin-tab bin-tab-action"
              onClick={handleImport}
              disabled={!hasProject || importing}
              title="导入素材（只登记元数据，秒完成）"
            >
              {importing ? "导入中…" : "＋ 导入素材"}
            </button>
          </div>
          <MediaTab
            keyword={keyword}
            kindFilter="all"
            previewAssetId={previewAssetId}
            setPreviewAsset={setPreviewAsset}
            setPickedAsset={setPickedAsset}
            hasProject={hasProject}
          />
        </>
      )}
      {tab === "audio" && (
        <MediaTab
          keyword={keyword}
          kindFilter="audio"
          previewAssetId={previewAssetId}
          setPreviewAsset={setPreviewAsset}
          setPickedAsset={setPickedAsset}
          hasProject={hasProject}
        />
      )}
      {tab === "pip" && (
        <MediaTab
          keyword={keyword}
          kindFilter="all"
          previewAssetId={previewAssetId}
          setPreviewAsset={setPreviewAsset}
          setPickedAsset={setPickedAsset}
          hasProject={hasProject}
        />
      )}
      {tab === "text" && (
        <TextTab keyword={keyword} selectedCount={selectedCount} onApply={addEffect} />
      )}
      {tab === "generators" && <GeneratorsTab keyword={keyword} hasProject={hasProject} />}
      {tab === "camera" && <CameraTab />}
      {tab === "effects" && <EffectsTab keyword={keyword} />}
      {tab === "global" && <GlobalTab />}
      {tab === "particles" && <ParticlesTab onApply={addEffect} />}
      {tab === "defaultAudio" && (
        <DefaultAudioTab hasProject={hasProject} />
      )}
      {tab === "stickers" && (
        <div className="panel-body">
          <div className="tl-empty">贴纸库需要素材源（待接入）</div>
        </div>
      )}
      </div>
    </section>
  );
}

/**
 * 默认音频页签：读系统默认目录 `%LOCALAPPDATA%\Reelix\default\audio`（与 music）里的文件。
 * 设计上**不支持界面上传**——唯一增删方式是用户自己往那个文件夹放/删文件（用户指定）。
 */
function DefaultAudioTab({ hasProject }: { hasProject: boolean }): JSX.Element {
  const [items, setItems] = useState<Array<{ name: string; path: string; kind: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [dirHint, setDirHint] = useState("");

  const load = async () => {
    setBusy(true);
    try {
      const { generators } = await import("../services");
      const [audio, music] = await Promise.all([
        generators.listDefaultMedia("audio"),
        generators.listDefaultMedia("music"),
      ]);
      setItems([
        ...audio.map(([name, path]) => ({ name, path, kind: "音效" })),
        ...music.map(([name, path]) => ({ name, path, kind: "音乐" })),
      ]);
      setDirHint(await generators.defaultMediaDir("audio"));
    } catch (e) {
      useAppStore.getState().pushNotice("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="panel-body">
      <button
        type="button"
        className="bin-tab bin-tab-action"
        style={{ margin: "4px 6px 8px", width: "calc(100% - 12px)" }}
        disabled={!hasProject || busy}
        onClick={async () => {
          // 把系统默认目录里的真实文件登记进素材库（这才是"导入"的入口）
          for (const item of items) {
            await importMediaFile(item.path);
          }
        }}
      >
        把列出的音频加入素材箱（可拖上轨）
      </button>
      <div className="tl-empty" style={{ textAlign: "left", padding: "0 10px 8px", fontSize: 10 }}>
        默认音频库只读系统文件夹：{dirHint || "%LOCALAPPDATA%\\Reelix\\default\\audio"}
        （音乐在 default\\music）。界面不提供上传——请直接把文件放进该文件夹。
      </div>
      {items.length === 0 && <div className="tl-empty">文件夹里还没有音频文件</div>}
      {items.map((item) => (
        <div key={item.path} className="bin-row" title={item.path}>
          <span className="gen-swatch" style={{ background: "#3b82f6" }} />
          <span className="gen-name">{item.name}</span>
          <span className="gen-hint">{item.kind}</span>
        </div>
      ))}
    </div>
  );
}

/** 用系统默认媒体服务把本地文件登记为素材（复用素材导入） */
async function importMediaFile(path: string): Promise<void> {
  const { media } = await import("../services");
  const { refreshProject } = await import("../store/projectActions");
  const added = await media.importMedia([path]);
  await refreshProject();
  if (added.length > 0) {
    useAppStore.getState().pushNotice("info", "已加入素材箱，拖到时间线上轨");
  }
}

/** 素材页签：素材箱文件夹（真后端 bins）+ 列表 + 拖拽上轨 + 双击预览 + 离线 404 */
function MediaTab({
  keyword,
  kindFilter,
  previewAssetId,
  setPreviewAsset,
  setPickedAsset,
  hasProject,
}: {
  keyword: string;
  /** all=全部；audio=只音频（音频页签） */
  kindFilter: "all" | "audio";
  previewAssetId: string | null;
  setPreviewAsset: (id: string | null) => void;
  setPickedAsset: (id: string | null) => void;
  hasProject: boolean;
}) {
  const assets = useAssets();
  const project = useAppStore((s) => s.project);
  const [activeBin, setActiveBin] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [binName, setBinName] = useState("");

  /** 新建素材箱（真后端 create_bin） */
  const createBinNow = async () => {
    const name = binName.trim();
    setCreating(false);
    setBinName("");
    if (!name) return;
    const { createBinAction } = await import("../store/projectActions");
    const id = await createBinAction(name);
    if (id) setActiveBin(id);
  };

  /** 把素材归入素材箱（真后端 set_asset_bin；null = 移出） */
  const moveToBin = async (assetId: string, binId: string | null) => {
    const { setAssetBinAction } = await import("../store/projectActions");
    await setAssetBinAction(assetId, binId);
  };

  const list = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    let out = assets;
    if (kindFilter === "audio") out = out.filter((a) => a.kind === "audio");
    if (activeBin === "__none__") {
      out = out.filter((a) => !a.binId);
    } else if (activeBin) {
      out = out.filter((a) => a.binId === activeBin);
    }
    if (key) out = out.filter((a) => a.name.toLowerCase().includes(key));
    return out;
  }, [assets, keyword, activeBin, kindFilter]);

  if (!hasProject)
    return <div className="panel-body"><div className="tl-empty">还没有打开工程</div></div>;

  return (
    <>
      {/* 素材箱条：全部 / 各文件夹 / ＋新建（达芬奇式） */}
      <div className="bin-bar">
        <button
          type="button"
          className={`bin-chip${activeBin === null ? " active" : ""}`}
          onClick={() => setActiveBin(null)}
        >
          全部 {assets.length}
        </button>
        {(project?.bins ?? []).map((bin) => (
          <button
            key={bin.id}
            type="button"
            className={`bin-chip${activeBin === bin.id ? " active" : ""}`}
            onClick={() => setActiveBin(bin.id)}
            title="点一下只显示这个素材箱"
          >
            {bin.name}
          </button>
        ))}
        {creating ? (
          <input
            className="bin-chip-input"
            autoFocus
            value={binName}
            placeholder="素材箱名"
            onChange={(e) => setBinName(e.target.value)}
            onBlur={() => void createBinNow()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createBinNow();
              if (e.key === "Escape") {
                setCreating(false);
                setBinName("");
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="bin-chip bin-chip-add"
            title="新建素材箱"
            onClick={() => setCreating(true)}
          >
            ＋ 素材箱
          </button>
        )}
      </div>

      <div className="panel-body">
        {list.length === 0 ? (
          <div className="tl-empty">
            {keyword.trim() ? "没有匹配的素材" : "这个素材箱还是空的"}
          </div>
        ) : (
          /* 导入后自动分组：视频/图片在前，音频在后（用户要求自动分音频和视频） */
          (() => {
            const visual = list.filter((a) => a.kind !== "audio");
            const audio = list.filter((a) => a.kind === "audio");
            const renderRow = (asset: (typeof list)[number]) => (
              <BinRow
                key={asset.id}
                asset={asset}
                previewing={previewAssetId === asset.id}
                onSelect={() => setPickedAsset(asset.id)}
                onPreview={() => setPreviewAsset(asset.id)}
                bins={project?.bins ?? []}
                onMoveToBin={(binId) => void moveToBin(asset.id, binId)}
              />
            );
            return (
              <>
                {visual.length > 0 && (
                  <>
                    <div className="bin-group-title">视频 / 图片（{visual.length}）</div>
                    {visual.map(renderRow)}
                  </>
                )}
                {audio.length > 0 && (
                  <>
                    <div className="bin-group-title">音频（{audio.length}）</div>
                    {audio.map(renderRow)}
                  </>
                )}
              </>
            );
          })()
        )}
      </div>
    </>
  );
}

/** 素材箱的一行：缩略图、预览、离线标记、归入素材箱都挂在这一行上。 */
function BinRow({
  asset,
  previewing,
  onSelect,
  onPreview,
  bins,
  onMoveToBin,
}: {
  asset: Asset;
  previewing: boolean;
  onSelect: () => void;
  onPreview: () => void;
  bins: Array<{ id: string; name: string }>;
  onMoveToBin: (binId: string | null) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  /** 只有滚进视口的行才请求缩略图——批量导入几十个素材时不会同时起几十个 ffmpeg */
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = rowRef.current;
    if (!el || inView) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { root: null, threshold: 0.1 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inView]);

  const thumbUrl = useThumbUrl(
    asset.id,
    asset.durationMs > 0 ? Math.round(asset.durationMs / 2) : 0,
    inView && asset.kind !== "audio" && !asset.missing
  );

  /** 素材行右键菜单 */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const runCtx = async (action: "relink" | "remove" | "reveal") => {
    setCtxMenu(null);
    if (action === "reveal") {
      const { revealAsset } = await import("../store/projectActions");
      await revealAsset(asset.id);
      return;
    }
    if (action === "remove") {
      const { media } = await import("../services");
      await media.removeMedia(asset.id);
      const { refreshProject } = await import("../store/projectActions");
      await refreshProject();
      return;
    }
    if (action === "relink") {
      // 重新链接：重新选文件并登记（离线素材救回）
      const { importMedia } = await import("../store/projectActions");
      await importMedia();
    }
  };

  /** 重新链接：选新文件，后端 relink_media 真的改工程数据 */
  const relink = async () => {
    const pickedPath = await dialog.pickMediaFiles().then((p) => p[0] ?? null);
    if (!pickedPath) return;
    await import("../store/projectActions").then((m) => m.relinkAsset(asset.id, pickedPath));
  };

  return (
    <div
      ref={rowRef}
      className={`bin-item${previewing ? " previewing" : ""}${asset.missing ? " missing" : ""}`}
      onClick={onSelect}
      onDoubleClick={onPreview}
      onPointerDown={(e) => {
        // Pointer Events 全局拖拽（同步桥，不依赖 React state）：
        // 按下后移动超过 6px 进入拖拽，拖到时间线轨道上松手就落 clip。
        if (e.button !== 0 || asset.missing) return;
        const startX = e.clientX;
        const startY = e.clientY;
        let ghost: HTMLDivElement | null = null;
        let armed = false;
        const move = (ev: PointerEvent) => {
          if (!armed) {
            if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
            armed = true;
            beginAssetDrag(asset.id);
            ghost = document.createElement("div");
            ghost.className = "asset-drag-ghost";
            ghost.textContent = asset.name;
            document.body.appendChild(ghost);
          }
          if (ghost) {
            ghost.style.left = `${ev.clientX + 14}px`;
            ghost.style.top = `${ev.clientY + 12}px`;
          }
        };
        const up = (ev: PointerEvent) => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          if (ghost) ghost.remove();
          if (armed) endAssetDrag(ev.clientX, ev.clientY);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      draggable={false}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setCtxMenu({ x: e.clientX, y: e.clientY });
      }}
      title="单击选中，双击在监视器中预览，按住拖到时间线上轨"
    >
      {ctxMenu && (
        <div
          className="bin-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button type="button" className="bin-ctx-item" onClick={() => void runCtx("reveal")}>
            在资源管理器中显示
          </button>
          <button type="button" className="bin-ctx-item" onClick={() => void runCtx("relink")}>
            重新链接（重新选择文件）
          </button>
          <button type="button" className="bin-ctx-item danger" onClick={() => void runCtx("remove")}>
            从工程中移除
          </button>
        </div>
      )}
      <div className="bin-thumb">
        {asset.missing ? (
          <div className="bin-offline">
            <img
              className="bin-offline-img"
              src="/illustrations/empty-not-found.png"
              alt="素材离线"
              draggable={false}
            />
            <button
              type="button"
              className="bin-relink"
              onClick={(e) => {
                e.stopPropagation();
                void relink();
              }}
            >
              重新链接…
            </button>
          </div>
        ) : thumbUrl ? (
          <img className="bin-thumb-img" src={thumbUrl} alt={asset.name} draggable={false} />
        ) : (
          <span className="bin-thumb-kind">{KIND_LABEL[asset.kind]}</span>
        )}
      </div>
      <div className="meta">
        <div className="name" title={asset.name}>
          {asset.name}
        </div>
        <div className="sub">
          {asset.kind === "audio"
            ? msToChinese(asset.durationMs)
            : `${asset.width}×${asset.height} · ${msToChinese(asset.durationMs)}`}
        </div>
      </div>
      {asset.missing && <span className="bin-offline-tag">离线</span>}
      {/* 归入素材箱：点开小菜单选择目标文件夹（真 set_asset_bin） */}
      {bins.length > 0 && (
        <div className="bin-row-menu-wrap">
          <button
            type="button"
            className="bin-row-more"
            title="归入素材箱"
            onClick={(e) => e.stopPropagation()}
          >
            ⋯
          </button>
          <div className="bin-row-menu">
            {bins.map((b) => (
              <button
                key={b.id}
                type="button"
                className="bin-row-menu-item"
                onClick={(e) => {
                  e.stopPropagation();
                  onMoveToBin(b.id);
                }}
              >
                归入「{b.name}」
              </button>
            ))}
            <button
              type="button"
              className="bin-row-menu-item"
              onClick={(e) => {
                e.stopPropagation();
                onMoveToBin(null);
              }}
            >
              移出素材箱
            </button>
            {/* 生成代理媒体：1/4 画幅低码率副本，剪辑更流畅（真后端 ffmpeg） */}
            <button
              type="button"
              className="bin-row-menu-item"
              disabled={asset.missing || asset.kind !== "video"}
              onClick={async (e) => {
                e.stopPropagation();
                try {
                  const { media } = await import("../services");
                  const p = await media.makeProxy(asset.id);
                  useAppStore.getState().pushNotice("info", `代理已生成：${p}`);
                } catch (err) {
                  useAppStore
                    .getState()
                    .pushNotice("error", err instanceof Error ? err.message : String(err));
                }
              }}
            >
              生成代理媒体（1/4 画幅）
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        className="bin-preview"
        onClick={(e) => {
          e.stopPropagation();
          onPreview();
        }}
        title="在监视器中预览这段素材"
      >
        预览
      </button>
    </div>
  );
}

/** 文字预设面板：点击真给选中片段挂文字效果 */
export function TextTab({
  keyword,
  selectedCount,
  onApply,
}: {
  keyword: string;
  selectedCount: number;
  onApply: (clipId: string, type: "text") => void;
}) {
  const selectedClipId = useAppStore((s) => s.selectedClipId);
  const list = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    if (!key) return TEXT_PRESETS;
    return TEXT_PRESETS.filter((p) => p.name.toLowerCase().includes(key));
  }, [keyword]);

  return (
    <div className="panel-body">
      {selectedCount === 0 && (
        <div className="tl-empty">先在时间线上选中一个片段，再点文字预设套用</div>
      )}
      {list.map((preset) => (
        <button
          key={preset.id}
          type="button"
          className="text-preset"
          disabled={!selectedClipId}
          title={`套用到选中片段：${preset.name}`}
          onClick={() => {
            if (!selectedClipId) return;
            onApply(selectedClipId, "text");
          }}
        >
          {/* 灰底白字，统一写「小方工作室」，不同字体预览（用户要求） */}
          <span
            className="text-preset-sample"
            style={{
              color: "#ffffff",
              fontSize: preset.size >= 72 ? 20 : 15,
              fontFamily: preset.fontFamily,
              fontWeight: preset.fontWeight,
            }}
          >
            小方工作室
          </span>
          <span className="text-preset-name">{preset.name}</span>
        </button>
      ))}
    </div>
  );
}

/** 系统素材面板（左侧工具条弹出用）：白底/黑场/彩条/颜色遮罩，点击真生成上轨 */
export function GeneratorsTab({ keyword, hasProject }: { keyword: string; hasProject: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const list = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    if (!key) return generators.GENERATORS;
    return generators.GENERATORS.filter((g) => g.name.toLowerCase().includes(key));
  }, [keyword]);

  return (
    <div className="panel-body">
      {!hasProject && <div className="tl-empty">先新建或打开一个工程</div>}
      {/* 默认素材也可导入自己的图片/视频（不必改系统文件夹） */}
      <button
        type="button"
        className="bin-tab bin-tab-action"
        style={{ margin: "4px 6px 8px", width: "calc(100% - 12px)" }}
        disabled={!hasProject}
        title="把自己的图片/视频导入素材库（素材页签里能看到）"
        onClick={async () => {
          const { importMedia } = await import("../store/projectActions");
          await importMedia();
        }}
      >
        ＋ 导入自己的素材
      </button>
      {list.map((g) => (
        <button
          key={g.kind}
          type="button"
          className="gen-item"
          disabled={!hasProject || busy !== null}
          title={g.hint}
          onClick={async () => {
            setBusy(g.kind);
            try {
              await createGeneratorAsset(g.kind, g.seconds);
            } finally {
              setBusy(null);
            }
          }}
        >
          <span
            className="gen-swatch"
            style={
              g.kind.startsWith("#")
                ? { background: g.kind }
                : g.kind === "white"
                  ? { background: "#ffffff", border: "1px solid var(--rl-border)" }
                  : g.kind === "black"
                    ? { background: "#101010" }
                    : { background: "linear-gradient(90deg,#c0c0c0 25%,#808080 25% 50%,#c0c0c0 50% 75%,#808080 75%)" }
            }
          />
          <span className="gen-name">{busy === g.kind ? "生成中…" : g.name}</span>
          <span className="gen-hint">{g.hint}</span>
        </button>
      ))}
    </div>
  );
}

/** 摄像机页签：3D 空间识别（COLMAP 真入口，从剪辑页直达） */
/** 摄像机页签：真摄像机（Blurrr/Blender 式）——添加到 V 区，沉浸模式里动视角 */
function CameraTab(): JSX.Element {
  const sequence = useAppStore((s) => s.project?.sequences[0] ?? null);
  const cameras = (sequence?.tracks ?? []).filter((t) => t.kind === "camera");
  const setImmersiveClipId = useAppStore((s) => s.setImmersiveClipId);
  const [busy, setBusy] = useState(false);

  /** 添加一台摄像机（在 V 区顶部的摄像机轨上落一个片段） */
  const addCamera = async () => {
    const seq = sequence;
    if (!seq) return;
    setBusy(true);
    try {
      const track = cameras[0] ?? (await timelineApi.addTrack("camera", seq.id));
      // 摄像机片段不承载素材（assetId 传空串，后端按摄像机轨处理）
      await timelineApi.addClip(
        track.id,
        "",
        0,
        Math.max(5000, seq.durationMs || 5000)
      );
      await refreshProject();
      useAppStore.getState().pushNotice("info", "摄像机已添加到 V 区顶部");
    } catch (e) {
      useAppStore.getState().pushNotice("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-body">
      {!sequence && <div className="tl-empty">先新建或打开一个工程</div>}
      <button
        type="button"
        className="btn-primary"
        style={{ margin: "6px 8px" }}
        disabled={!sequence || busy}
        onClick={() => void addCamera()}
      >
        {busy ? "添加中…" : "＋ 添加摄像机"}
      </button>
      <div className="tl-empty" style={{ textAlign: "left", padding: "0 10px" }}>
        摄像机在 V 区顶部，选中后右键「进入沉浸模式」用 WASD 调整视角，
        位置/焦距全部会打关键帧。
      </div>
      {cameras.map((track) => (
        <div key={track.id} className="bin-group-title">
          <span className="track-code">摄像机</span>
          <span className="effect-item-cat">{track.clips.length} 个片段</span>
        </div>
      ))}
      {cameras.flatMap((track) =>
        track.clips.map((clip) => (
          <button
            key={clip.id}
            type="button"
            className="effect-item"
            title="进入沉浸模式调整这台摄像机的视角"
            onClick={() => setImmersiveClipId(clip.id)}
          >
            <span className="effect-item-label">摄像机 · {clip.id.slice(0, 6)}</span>
            <span className="effect-item-cat">沉浸模式</span>
          </button>
        ))
      )}
    </div>
  );
}

/** 特效页签：效果库（真效果清单，点击给选中片段挂效果） */
function EffectsTab({ keyword }: { keyword: string }): JSX.Element {
  const selectedClipId = useAppStore((s) => s.selectedClipId);
  const addEffect = useAppStore((s) => s.addEffect);
  const list = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    if (!key) return EFFECT_CATALOG;
    return EFFECT_CATALOG.filter(
      (e) => e.label.toLowerCase().includes(key) || e.category.toLowerCase().includes(key)
    );
  }, [keyword]);
  return (
    <div className="panel-body">
      {!selectedClipId && <div className="tl-empty">先在时间线上选中一个片段</div>}
      {list.map((e) => (
        <button
          key={e.type}
          type="button"
          className="effect-item"
          disabled={!selectedClipId}
          title={`给选中片段挂「${e.label}」`}
          onClick={() => {
            if (selectedClipId) addEffect(selectedClipId, e.type);
          }}
        >
          <span className="effect-item-label">{e.label}</span>
          <span className="effect-item-cat">{e.category}</span>
        </button>
      ))}
    </div>
  );
}

/** 全局属性页签：当前序列的真实信息 */
function GlobalTab(): JSX.Element {
  const sequence = useAppStore((s) => s.project?.sequences[0] ?? null);
  return (
    <div className="panel-body">
      {sequence ? (
        <>
          <div className="fx-ph-line">序列：{sequence.name}</div>
          <div className="fx-ph-line">
            画幅 {sequence.width}×{sequence.height}
          </div>
          <div className="fx-ph-line">帧率 {sequence.frameRate} fps</div>
          <div className="fx-ph-line">色彩 {sequence.colorSpace}</div>
          <div className="fx-ph-line">时长 {(sequence.durationMs / 1000).toFixed(2)}s</div>
          <div className="fx-ph-line">轨道 {sequence.tracks.length} 条</div>
        </>
      ) : (
        <div className="tl-empty">还没有序列</div>
      )}
    </div>
  );
}

/** 粒子页签：粒子效果预设（真挂效果） */
function ParticlesTab({
  onApply,
}: {
  onApply: (clipId: string, type: "particles") => void;
}): JSX.Element {
  const selectedClipId = useAppStore((s) => s.selectedClipId);
  const presets = [
    { id: "p1", name: "粒子 · 点发射" },
    { id: "p2", name: "粒子 · 线发射" },
    { id: "p3", name: "粒子 · 环形发射" },
  ];
  return (
    <div className="panel-body">
      {!selectedClipId && <div className="tl-empty">先在时间线上选中一个片段</div>}
      {presets.map((p) => (
        <button
          key={p.id}
          type="button"
          className="text-preset"
          disabled={!selectedClipId}
          title={`给选中片段挂「${p.name}」`}
          onClick={() => {
            if (selectedClipId) onApply(selectedClipId, "particles");
          }}
        >
          <span className="text-preset-name">{p.name}</span>
        </button>
      ))}
    </div>
  );
}
