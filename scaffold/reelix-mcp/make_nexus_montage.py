"""Nexus OS 宣传片 · 蒙太奇 A 段（教程 400–640 帧，8 秒）。

规格（照 `复刻教程.md`）：
- 80 张图 × 3 帧（0.1s @30fps），共 240 帧 / 8000ms
- 白色线框 logo 叠在每张图中央，占画面宽 72%
- 每张图轻微放大（这里用摄像机统一推近替代逐图关键帧，观感一致且省 80 条曲线）
- 摄像机：左进 → 右移，全部用**自定义贝塞尔**切线（easing=custom + 四个控制柄）

全程只用 MCP。跑法：python make_nexus_montage.py [图数] [段号A|B]
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
PROJECT = os.path.join(OUT_DIR, "nexus_montage_a.reelix")
MP4 = os.path.join(OUT_DIR, "nexus_montage_a.mp4")

COUNT = int(sys.argv[1]) if len(sys.argv) > 1 else 80
FPS = 30
FRAMES_PER_IMG = 3
DURATION = COUNT * FRAMES_PER_IMG * 1000 // FPS  # 80 张 → 8000ms

CANVAS_W, CANVAS_H = 1084.0, 609.0
# logo 在画面里占 72% 宽：原画板 logo 宽 848/1084=0.782 → k=0.72/0.782
LOGO_K = round(0.72 / (848.0 / CANVAS_W), 4)
STROKES = [
    (120, 188, 120, 407), (169, 185, 169, 407), (169, 185, 286, 337),
    (120, 188, 288, 408), (287, 189, 287, 408), (342, 189, 342, 407),
    (287, 358, 342, 407), (287, 187, 511, 187), (342, 235, 509, 235),
    (342, 360, 508, 360), (342, 406, 506, 406), (392, 274, 463, 274),
    (392, 322, 463, 322), (511, 187, 688, 405), (511, 406, 688, 187),
    (689, 187, 689, 405), (724, 287, 724, 361), (772, 287, 772, 359),
    (808, 186, 808, 405), (809, 186, 967, 186), (810, 403, 967, 403),
    (810, 314, 882, 314), (810, 358, 882, 358), (902, 235, 968, 235),
    (900, 279, 968, 279),
]


def norm(x, y):
    """画板坐标 → 归一化，并按 0.92 缩放到画面宽 72%，保持中心。"""
    nx = x / CANVAS_W
    ny = y / CANVAS_H
    return (round(0.5 + (nx - 0.5) * LOGO_K, 5), round(0.5 + (ny - 0.5) * LOGO_K, 5))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for f in (PROJECT, MP4):
        if os.path.exists(f):
            os.remove(f)

    m = Mcp(EXE)
    m.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                             "clientInfo": {"name": "nexus-montage", "version": "1"}})
    m.notify("notifications/initialized")

    def call(tool, args=None):
        body, is_err = text_of(m.call(tool, args or {}))
        if is_err:
            raise SystemExit(f"[MCP 失败] {tool}: {body}")
        body = body.strip()
        return json.loads(body) if body.startswith(("{", "[")) else body

    call("new_project", {"name": "Nexus OS · 蒙太奇 A"})
    call("set_sequence", {"width": 1920, "height": 1080, "frameRate": FPS,
                          "durationMs": DURATION})

    # —— 1) 批量登记 80 张图（先不上轨，后面按帧精确定位）——
    assets = []
    for i in range(COUNT):
        path = os.path.join(BASE, f"{i:03d}.jpg")
        r = call("import_media", {"path": path, "addToTimeline": False})
        assets.append(r["assetId"])
    print(f"素材登记 {len(assets)} 张")

    # —— 2) 按 3 帧一张铺到 V 轨 ——
    # get_timeline 返回 [sequence]，轨道在 sequence.tracks 里
    seq_info = call("get_timeline")[0]
    tracks = seq_info["tracks"]
    v_track = next((t["id"] for t in tracks if t.get("kind") == "video"), None)
    if not v_track:
        raise SystemExit("找不到视频轨")
    per = 1000 * FRAMES_PER_IMG // FPS  # 100ms
    for i, aid in enumerate(assets):
        call("add_clip", {"assetId": aid, "trackId": v_track,
                          "startMs": i * per, "durationMs": per})
    print(f"已铺 {len(assets)} 段，每段 {per}ms，总 {DURATION}ms")

    # —— 3) 白色线框 logo（25 条线，progress=100 常亮）——
    lines = []
    for (x1, y1, x2, y2) in STROKES:
        ax, ay = norm(x1, y1)
        bx, by = norm(x2, y2)
        lines.append(call("add_node", {"nodeType": "line"})["node"]["id"])
        nid = lines[-1]
        call("set_node_param", {"nodeId": nid, "param": "x1", "value": ax})
        call("set_node_param", {"nodeId": nid, "param": "y1", "value": ay})
        call("set_node_param", {"nodeId": nid, "param": "x2", "value": bx})
        call("set_node_param", {"nodeId": nid, "param": "y2", "value": by})
        call("set_node_param", {"nodeId": nid, "param": "thickness", "value": 0.42})
        call("set_node_param", {"nodeId": nid, "param": "color", "value": "#ffffff"})
        call("set_node_param", {"nodeId": nid, "param": "progress", "value": 100.0})
        call("set_node_param", {"nodeId": nid, "param": "opacity", "value": 92.0})

    tf = call("add_node", {"nodeType": "transform"})["node"]["id"]
    call("set_node_param", {"nodeId": tf, "param": "scale", "value": 105.0})

    nodes = call("get_graph").get("nodes", [])
    output_id = next((n["id"] for n in nodes
                      if n.get("type") == "output" or n.get("nodeType") == "output"), None)
    seq_id = next((n["id"] for n in nodes
                   if n.get("type") == "sequence" or n.get("nodeType") == "sequence"), None)

    chain = [(seq_id, lines[0])] + [(lines[i - 1], lines[i]) for i in range(1, len(lines))]
    chain += [(lines[-1], tf), (tf, output_id)]
    for a, b in chain:
        call("connect", {"fromNode": a, "fromPlug": "out", "toNode": b, "toPlug": "in"})
    print(f"图已搭好：{len(chain)} 条连线（视频源 + 25 笔 logo + 摄像机）")

    # —— 4) 摄像机：左进 → 右移，自定义贝塞尔 ——
    def key(target, param, t, v, **extra):
        payload = {"targetId": target, "param": param, "timeMs": float(t), "value": float(v)}
        payload.update(extra)
        call("set_keyframe", payload)

    half = DURATION / 2.0
    # 左进：从偏左、略小，推到正中并放大
    key(tf, "posX", 0, -7.0, easing="custom",
        outTangentX=0.18, outTangentY=0.62, inTangentX=0.42, inTangentY=0.92)
    key(tf, "posX", half, 0.0, easing="custom",
        outTangentX=0.55, outTangentY=0.55, inTangentX=0.85, inTangentY=0.55)
    key(tf, "posX", DURATION, 7.0, easing="custom",
        outTangentX=0.3, outTangentY=0.4, inTangentX=0.9, inTangentY=0.6)
    key(tf, "scale", 0, 105.0, easing="custom",
        outTangentX=0.2, outTangentY=0.75, inTangentX=0.6, inTangentY=0.9)
    key(tf, "scale", half, 118.0, easing="custom",
        outTangentX=0.5, outTangentY=0.5, inTangentX=0.8, inTangentY=0.5)
    key(tf, "scale", DURATION, 112.0, easing="custom",
        outTangentX=0.3, outTangentY=0.5, inTangentX=0.9, inTangentY=0.5)

    call("save_project", {"path": PROJECT})
    print("工程:", PROJECT)

    r = call("render_video", {"projectPath": PROJECT, "outputPath": MP4,
                              "preset": "h264-1080p", "startMs": 0, "endMs": DURATION})
    print(json.dumps(r, ensure_ascii=False)[:300])
    m.close()


if __name__ == "__main__":
    main()
