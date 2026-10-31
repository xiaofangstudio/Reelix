"""Nexus OS 宣传片 · 蒙太奇 B 段（教程第 4 段，640–1020 帧 / 12.67 秒）。

规格：
- 100 张新图（080–179.jpg）× 3 帧（100ms @30fps）
- 第 20/50/75/100 张之后各插入一次「老图重放」，停留 20 帧
- **B 段不叠 logo**（教程明确：新图无 logo 叠加，纯图片）
- 摄像机继续右移 + 缓慢推近，用自定义贝塞尔

总帧 = 100×3 + 4×20 = 380 帧 = 12667ms

跑法：python make_nexus_montage_b.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from selftest import Mcp, text_of  # noqa: E402

EXE = os.environ.get(
    "REELIX_MCP_EXE",
    r"D:\20533\deskbox\fangwork\Reelix\scaffold\reelix-mcp\target\release\reelix-mcp.exe",
)
BASE = r"D:\20533\deskbox\fangwork\Reelix\reference\nexusos\frames"
OUT_DIR = r"D:\20533\deskbox\fangwork\Reelix\out"
PROJECT = os.path.join(OUT_DIR, "nexus_montage_b.reelix")
MP4 = os.path.join(OUT_DIR, "nexus_montage_b.mp4")

FPS = 30
NEW_IMGS = 100          # 080..179
FRAMES_PER_IMG = 3
REPLAY_AT = (20, 50, 75, 100)   # 第 n 张之后插重放
REPLAY_FRAMES = 20


def build_plan():
    """(图片序号, 帧数) 序列。"""
    plan = []
    for i in range(1, NEW_IMGS + 1):
        plan.append((80 + i - 1, FRAMES_PER_IMG))
        if i in REPLAY_AT:
            # 重放一张前面出现过的老图（挑中间偏前的位置）
            plan.append((80 + max(0, i // 2 - 1), REPLAY_FRAMES))
    return plan


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for f in (PROJECT, MP4):
        if os.path.exists(f):
            os.remove(f)

    plan = build_plan()
    total_frames = sum(n for _, n in plan)
    duration = int(total_frames * 1000 / FPS)

    m = Mcp(EXE)
    m.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                             "clientInfo": {"name": "nexus-montage-b", "version": "1"}})
    m.notify("notifications/initialized")

    def call(tool, args=None):
        body, is_err = text_of(m.call(tool, args or {}))
        if is_err:
            raise SystemExit(f"[MCP 失败] {tool}: {body}")
        body = body.strip()
        return json.loads(body) if body.startswith(("{", "[")) else body

    call("new_project", {"name": "Nexus OS · 蒙太奇 B"})
    call("set_sequence", {"width": 1920, "height": 1080, "frameRate": FPS,
                          "durationMs": duration})

    # 登记用到的所有图（去重）
    needed = sorted({idx for idx, _ in plan})
    asset_of = {}
    for idx in needed:
        path = os.path.join(BASE, f"{idx:03d}.jpg")
        asset_of[idx] = call("import_media", {"path": path, "addToTimeline": False})["assetId"]
    print(f"登记 {len(asset_of)} 张图，铺 {len(plan)} 段，共 {total_frames} 帧 / {duration}ms")

    seq_info = call("get_timeline")[0]
    v_track = next((t["id"] for t in seq_info["tracks"] if t.get("kind") == "video"), None)
    if not v_track:
        raise SystemExit("找不到视频轨")

    # 按帧精确铺轨
    cursor_frames = 0
    for idx, frames in plan:
        start = int(cursor_frames * 1000 / FPS)
        dur = int(frames * 1000 / FPS)
        call("add_clip", {"assetId": asset_of[idx], "trackId": v_track,
                          "startMs": start, "durationMs": dur})
        cursor_frames += frames

    # 摄像机：继续右移 + 缓推，全自定义贝塞尔
    tf = call("add_node", {"nodeType": "transform"})["node"]["id"]
    call("set_node_param", {"nodeId": tf, "param": "scale", "value": 108.0})

    nodes = call("get_graph").get("nodes", [])
    out = next((n["id"] for n in nodes
                if n.get("type") == "output" or n.get("nodeType") == "output"), None)
    seq_id = next((n["id"] for n in nodes
                   if n.get("type") == "sequence" or n.get("nodeType") == "sequence"), None)
    for a, b in [(seq_id, tf), (tf, out)]:
        call("connect", {"fromNode": a, "fromPlug": "out", "toNode": b, "toPlug": "in"})

    def key(target, param, t, v, **extra):
        payload = {"targetId": target, "param": param, "timeMs": float(t), "value": float(v),
                   "easing": "custom"}
        payload.update(extra)
        call("set_keyframe", payload)

    third = duration / 3.0
    key(tf, "scale", 0, 108.0, outTangentX=0.25, outTangentY=0.7,
        inTangentX=0.6, inTangentY=0.85)
    key(tf, "scale", third, 116.0, outTangentX=0.45, outTangentY=0.55,
        inTangentX=0.8, inTangentY=0.55)
    key(tf, "scale", duration, 110.0, outTangentX=0.3, outTangentY=0.45,
        inTangentX=0.9, inTangentY=0.6)
    key(tf, "posX", 0, 2.0, outTangentX=0.3, outTangentY=0.6,
        inTangentX=0.7, inTangentY=0.6)
    key(tf, "posX", duration, 8.0, outTangentX=0.4, outTangentY=0.5,
        inTangentX=0.85, inTangentY=0.55)

    call("save_project", {"path": PROJECT})
    print("工程:", PROJECT)
    r = call("render_video", {"projectPath": PROJECT, "outputPath": MP4,
                              "preset": "h264-1080p", "startMs": 0, "endMs": duration})
    print(json.dumps(r, ensure_ascii=False)[:240])
    m.close()


if __name__ == "__main__":
    main()
