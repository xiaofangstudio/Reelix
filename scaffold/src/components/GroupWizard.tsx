/**
 * 编组向导（工具栏「编组」按下后弹出）：
 * - 左侧：本序列全部片段的点选清单（默认勾选当前已选中的）；
 * - 右下角：确认按钮；
 * - 确认后把它们合并到一个轨道（后端 collapse_compound 真编组）。
 *
 * 位置刻意放在「左侧浮层 + 右下确认」，和用户说的一致。
 */

import { useMemo, useState } from "react";
import { useAppStore } from "../store/appStore";
import { nestSelectedClips } from "../store/projectActions";

function trackNameOf(track: { kind: string; index: number }): string {
  if (track.kind === "video") return "V" + (track.index + 1);
  if (track.kind === "audio") return "A" + (track.index + 1);
  if (track.kind === "subtitle") return "字幕";
  return "摄像机";
}

export function GroupWizard({ onClose }: { onClose: () => void }) {
  const project = useAppStore((s) => s.project);
  const selectedIds = useAppStore((s) => s.selectedClipIds);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(selectedIds));
  const [busy, setBusy] = useState(false);

  const clips = useMemo(() => {
    if (!project) return [];
    const seq = project.sequences[0];
    if (!seq) return [];
    const out: Array<{ id: string; name: string; trackName: string; startMs: number }> = [];
    for (const track of seq.tracks) {
      for (const clip of track.clips) {
        const asset = project.assets.find((a) => a.id === clip.assetId);
        out.push({
          id: clip.id,
          name: asset?.name ?? (track.kind === "camera" ? "摄像机" : "片段"),
          trackName: trackNameOf(track),
          startMs: clip.startMs,
        });
      }
    }
    return out;
  }, [project]);

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirm = async () => {
    if (picked.size < 2) return;
    setBusy(true);
    try {
      useAppStore.getState().selectClips([...picked]);
      const ok = await nestSelectedClips();
      if (ok) onClose();
    } catch (err) {
      useAppStore
        .getState()
        .pushNotice("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group-wizard">
      <div className="group-wizard-panel">
        <div className="group-wizard-head">
          <span>创建编组</span>
          <span className="group-wizard-sub">勾选要合并的片段（至少 2 个）</span>
        </div>
        <div className="group-wizard-list">
          {clips.length === 0 && <div className="tl-empty">时间线里还没有片段</div>}
          {clips.map((c) => (
            <label key={c.id} className={`group-wizard-row${picked.has(c.id) ? " on" : ""}`}>
              <input
                type="checkbox"
                checked={picked.has(c.id)}
                onChange={() => toggle(c.id)}
              />
              <span className="group-wizard-name">{c.name}</span>
              <span className="group-wizard-meta">
                {c.trackName} · {(c.startMs / 1000).toFixed(1)}s
              </span>
            </label>
          ))}
        </div>
        <div className="group-wizard-foot">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={picked.size < 2 || busy}
            onClick={() => void confirm()}
          >
            {busy ? "编组中…" : `确认编组（${picked.size} 个片段）`}
          </button>
        </div>
      </div>
      {/* 点击空白处关闭 */}
      <div className="group-wizard-mask" onClick={onClose} />
    </div>
  );
}
