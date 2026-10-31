"""Nexus OS 宣传片 · 停顿反色段（教程第 2 段，360–400 帧 / 1.33 秒）。

规格：
- 承接 logo 绘制段的最后一帧：白底 + 完整黑线 logo，静止
- 392–396 帧（约 1067–1100ms）4 帧内背景白→黑、笔画黑→白
- 用 `invert` 节点打 amount 关键帧实现（0 → 100）

跑法：python make_nexus_invert.py
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
OUT_DIR = r"D:\20533\deskbox\fangwork\Reelix\out"
PROJECT = os.path.join(OUT_DIR, "nexus_invert.reelix")
MP4 = os.path.join(OUT_DIR, "nexus_invert.mp4")
DURATION = 1333

CANVAS_W, CANVAS_H = 1084.0, 609.0
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


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for f in (PROJECT, MP4):
        if os.path.exists(f):
            os.remove(f)

    m = Mcp(EXE)
    m.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                             "clientInfo": {"name": "nexus-invert", "version": "1"}})
    m.notify("notifications/initialized")

    def call(tool, args=None):
        body, is_err = text_of(m.call(tool, args or {}))
        if is_err:
            raise SystemExit(f"[MCP 失败] {tool}: {body}")
        body = body.strip()
        return json.loads(body) if body.startswith(("{", "[")) else body

    call("new_project", {"name": "Nexus OS · 停顿反色"})
    call("set_sequence", {"width": 1920, "height": 1080, "frameRate": 30,
                          "durationMs": DURATION})

    def add(node_type, **params):
        nid = call("add_node", {"nodeType": node_type})["node"]["id"]
        for k, v in params.items():
            call("set_node_param", {"nodeId": nid, "param": k, "value": v})
        return nid

    bg = add("gradient", colorA="#ffffff", colorB="#ffffff", angle=90, opacity=100.0)
    lines = []
    for (x1, y1, x2, y2) in STROKES:
        lines.append(add("line",
                         x1=round(x1 / CANVAS_W, 5), y1=round(y1 / CANVAS_H, 5),
                         x2=round(x2 / CANVAS_W, 5), y2=round(y2 / CANVAS_H, 5),
                         thickness=0.333, color="#000000", progress=100.0, opacity=100.0))
    # 反色层：amount 从 0 推到 100 就是「白底黑字 → 黑底白字」
    inv = add("invert", amount=0.0)

    nodes = call("get_graph").get("nodes", [])
    out = next((n["id"] for n in nodes
                if n.get("type") == "output" or n.get("nodeType") == "output"), None)

    chain = [(bg, lines[0])] + [(lines[i - 1], lines[i]) for i in range(1, len(lines))]
    chain += [(lines[-1], inv), (inv, out)]
    for a, b in chain:
        call("connect", {"fromNode": a, "fromPlug": "out", "toNode": b, "toPlug": "in"})

    def key(target, param, t, v, easing="ease-in-out"):
        call("set_keyframe", {"targetId": target, "param": param,
                              "timeMs": float(t), "value": float(v), "easing": easing})

    # 0–1067ms 保持白底黑字（停顿），1067–1200ms 4 帧内完成反色，之后保持
    key(inv, "amount", 0, 0.0, "linear")
    key(inv, "amount", 1067, 0.0, "linear")
    key(inv, "amount", 1200, 100.0, "ease-in-out")
    key(inv, "amount", DURATION, 100.0, "linear")

    call("save_project", {"path": PROJECT})
    print("工程:", PROJECT)
    r = call("render_video", {"projectPath": PROJECT, "outputPath": MP4,
                              "preset": "h264-1080p", "startMs": 0, "endMs": DURATION})
    print(json.dumps(r, ensure_ascii=False)[:240])
    m.close()


if __name__ == "__main__":
    main()
