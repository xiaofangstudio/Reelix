/**
 * 特效页的 Project 面板（EC 参考 的「项目」面板：左上角常驻）。
 *
 * 搜索框（真过滤）+ 素材列表（双击真进监视器预览）+ 合成列表。
 * 「新建合成」需要后端 add_sequence 命令——**没有就不放按钮**（防假功能铁律）。
 * 素材拖拽上轨与素材箱同一条链路（application/reelix-asset）。
 */

import { useMemo, useState } from "react";
import { useAppStore, useAssets } from "../store/appStore";
import { useThumbUrl } from "../hooks/useThumbUrl";
import { msToChinese } from "../core/timecode";
import type { Asset } from "../types/project";

const KIND_LABEL: Record<Asset["kind"], string> = {
  video: "视频",
  audio: "音频",
  image: "图片",
  imageSequence: "序列",
};

export function ProjectPanel() {
  const assets = useAssets();
  const setPreviewAsset = useAppStore((s) => s.setPreviewAsset);
  const previewAssetId = useAppStore((s) => s.previewAssetId);
  const setPickedAsset = useAppStore((s) => s.setPickedAsset);
  const [keyword, setKeyword] = useState("");
  const [tab, setTab] = useState<"assets" | "comps">("assets");

  const list = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    if (!key) return assets;
    return assets.filter((a) => a.name.toLowerCase().includes(key));
  }, [assets, keyword]);

  return (
    <section className="panel project-panel">
      <div className="panel-head">
        <span className="title">项目</span>
        <span className="title">{assets.length} 项</span>
      </div>

      {/* 页签：素材 / 合成（合成=序列，Reelix 的数据模型里序列就是合成） */}
      <div className="project-tabs">
        <button
          type="button"
          className={`project-tab${tab === "assets" ? " active" : ""}`}
          onClick={() => setTab("assets")}
        >
          素材
        </button>
        <button
          type="button"
          className={`project-tab${tab === "comps" ? " active" : ""}`}
          onClick={() => setTab("comps")}
        >
          合成
        </button>
      </div>

      {tab === "assets" ? (
        <>
          <div className="bin-search">
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索项目"
            />
          </div>
          <div className="panel-body">
            {list.length === 0 ? (
              <div className="tl-empty">还没有素材，去剪辑页的项目面板导入</div>
            ) : (
              list.map((asset) => (
                <ProjectRow
                  key={asset.id}
                  asset={asset}
                  previewing={previewAssetId === asset.id}
                  onPreview={() => setPreviewAsset(asset.id)}
                  onPick={() => setPickedAsset(asset.id)}
                />
              ))
            )}
          </div>
        </>
      ) : (
        <div className="panel-body">
          <div className="tl-empty">
            合成 = 剪辑页的序列（当前工程只有一条时间线，多序列即将支持）
          </div>
        </div>
      )}
    </section>
  );
}

/** 项目面板的一行素材。可拖（同素材箱链路）、双击预览。 */
function ProjectRow({
  asset,
  previewing,
  onPreview,
  onPick,
}: {
  asset: Asset;
  previewing: boolean;
  onPreview: () => void;
  onPick: () => void;
}) {
  const thumbUrl = useThumbUrl(
    asset.id,
    asset.durationMs > 0 ? Math.round(asset.durationMs / 2) : 0,
    asset.kind !== "audio" && !asset.missing
  );

  return (
    <div
      className={`project-row${previewing ? " previewing" : ""}${asset.missing ? " missing" : ""}`}
      onClick={onPick}
      onDoubleClick={onPreview}
      draggable={!asset.missing}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/reelix-asset", asset.id);
        e.dataTransfer.setData("text/plain", asset.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      title="双击在监视器中预览，拖到时间线上轨"
    >
      <span className="project-row-kind">{KIND_LABEL[asset.kind]}</span>
      {asset.missing ? (
        <span className="project-row-thumb offline" aria-hidden="true" />
      ) : (
        <span
          className="project-row-thumb"
          style={thumbUrl ? { backgroundImage: `url("${thumbUrl}")` } : undefined}
          aria-hidden="true"
        />
      )}
      <span className="project-row-name" title={asset.name}>
        {asset.name}
      </span>
      <span className="project-row-sub">{msToChinese(asset.durationMs)}</span>
    </div>
  );
}
