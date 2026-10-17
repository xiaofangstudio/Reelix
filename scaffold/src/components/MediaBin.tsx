/**
 * 素材箱。列出工程里的素材，带类型标、名称、时长与分辨率。
 * 搜索框按名称过滤；「导入素材」弹系统选择框，导入与落轨道都走后端，
 * 结果由 projectActions 拉回权威快照后回填，这里不自己造数据。
 * 视频/图片/序列另向后端抽一帧当缩略图（取素材中点），失败静默回退类型文字。
 *
 * 预览：双击条目或点右侧「预览」按钮，监视器切入素材预览模式，
 * 直接看这段素材本身的画面（PR 源监视器的路子）。缩略图走共享缓存
 * （core/thumbCache），时间线胶片条与监视器预览用的是同一份。
 */

import { useMemo, useState } from "react";
import { useAppStore, useAssets } from "../store/appStore";
import { importMedia } from "../store/projectActions";
import { useThumbUrl } from "../hooks/useThumbUrl";
import { msToChinese } from "../core/timecode";
import type { Asset } from "../types/project";

const KIND_LABEL: Record<Asset["kind"], string> = {
  video: "视频",
  audio: "音频",
  image: "图片",
  imageSequence: "序列",
};

export function MediaBin() {
  const assets = useAssets();
  const hasProject = useAppStore((s) => s.project !== null);
  const setPreviewAsset = useAppStore((s) => s.setPreviewAsset);
  const previewAssetId = useAppStore((s) => s.previewAssetId);
  const [keyword, setKeyword] = useState("");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const list = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    if (!key) return assets;
    return assets.filter((a) => a.name.toLowerCase().includes(key));
  }, [assets, keyword]);

  const handleImport = async () => {
    setImporting(true);
    try {
      await importMedia();
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="title">素材箱</span>
        <span className="title">{assets.length} 项</span>
      </div>

      <div className="bin-toolbar">
        <button
          type="button"
          className="btn-import"
          onClick={handleImport}
          disabled={!hasProject || importing}
          title={hasProject ? "导入素材并放到时间线" : "先新建或打开一个工程"}
        >
          {importing ? "导入中…" : "+ 导入素材"}
        </button>
      </div>

      <div className="bin-search">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索素材"
        />
      </div>

      <div className="panel-body">
        {!hasProject ? (
          <div className="tl-empty">还没有打开工程</div>
        ) : list.length === 0 ? (
          <div className="tl-empty">
            {keyword.trim() ? "没有匹配的素材" : "还没有素材，点上面的「导入素材」"}
          </div>
        ) : (
          list.map((asset) => (
            <BinItem
              key={asset.id}
              asset={asset}
              picked={pickedId === asset.id}
              previewing={previewAssetId === asset.id}
              onSelect={() => setPickedId(asset.id)}
              onPreview={() => setPreviewAsset(asset.id)}
            />
          ))
        )}
      </div>
    </section>
  );
}

/** 素材箱的一行。缩略图、预览按钮、离线标记都挂在这一行上。 */
function BinItem({
  asset,
  picked,
  previewing,
  onSelect,
  onPreview,
}: {
  asset: Asset;
  picked: boolean;
  previewing: boolean;
  onSelect: () => void;
  onPreview: () => void;
}) {
  // 音频没有画面、丢失的素材抽不出帧，都不请求缩略图
  const thumbUrl = useThumbUrl(
    asset.id,
    asset.durationMs > 0 ? Math.round(asset.durationMs / 2) : 0,
    asset.kind !== "audio" && !asset.missing
  );

  return (
    <div
      className={`bin-item${picked ? " selected" : ""}${previewing ? " previewing" : ""}`}
      onClick={onSelect}
      onDoubleClick={onPreview}
      draggable
      onDragStart={(e) => {
        // 拖拽上轨：素材 id 塞进 dataTransfer，时间线轨道接住落 clip
        e.dataTransfer.setData("application/reelix-asset", asset.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      title="单击选中，双击在监视器中预览，拖到时间线上轨"
    >
      <div className="thumb">
        {thumbUrl ? (
          <img src={thumbUrl} alt={asset.name} draggable={false} />
        ) : (
          KIND_LABEL[asset.kind]
        )}
        {asset.missing && <span className="bin-offline">离线</span>}
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
