"""Nexus OS 宣传片 · Logo 绘制段复刻（第 90–360 帧，9 秒）。

完全按 `复刻包/复刻教程.md` 的规格：
- 画板 1084×609，25 笔坐标原样搬（除以画板尺寸归一化，等比到 1920×1080）
- 笔画宽 3.6px（= 短边 0.333%）
- 每笔按顺序生长，9 秒 / 25 笔 = 每笔 360ms
- 白底 + 极淡构造网格，黑线
- 摄像机 9 秒内推近 25%（transform.scale 100→125）

全程只用 MCP 工具。跑法：python make_nexus_logo.py [时长毫秒]
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
PROJECT = os.path.join(OUT_DIR, "nexus_logo.reelix")
MP4 = os.path.join(OUT_DIR, "nexus_logo.mp4")
DURATION = int(sys.argv[1]) if len(sys.argv) > 1 else 9000

# 教程「25 笔笔画顺序与坐标」原样照搬（画板 1084×609）
CANVAS_W, CANVAS_H = 1084.0, 609.0
STROKES = [
    (120, 188, 120, 407),
    (169, 185, 169, 407),
    (169, 185, 286, 337),
    (120, 188, 288, 408),
    (287, 189, 287, 408),
    (342, 189, 342, 407),
    (287, 358, 342, 407),
    (287, 187, 511, 187),
    (342, 235, 509, 235),
    (342, 360, 508, 360),
    (342, 406, 506, 406),
    (392, 274, 463, 274),
    (392, 322, 463, 322),
    (511, 187, 688, 405),
    (511, 406, 688, 187),
    (689, 187, 689, 405),
    (724, 287, 724, 361),
    (772, 287, 772, 359),
    (808, 186, 808, 405),
    (809, 186, 967, 186),
    (810, 403, 967, 403),
    (810, 314, 882, 314),
    (810, 358, 882, 358),
    (902, 235, 968, 235),
    (900, 279, 968, 279),
]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for f in (PROJECT, MP4):
        if os.path.exists(f):
            os.remove(f)

    m = Mcp(EXE)
    m.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                             "clientInfo": {"name": "nexus-logo", "version": "1"}})
    m.notify("notifications/initialized")

    def call(tool, args=None):
        body, is_err = text_of(m.call(tool, args or {}))
        if is_err:
            raise SystemExit(f"[MCP 失败] {tool}: {body}")
        body = body.strip()
        return json.loads(body) if body.startswith(("{", "[")) else body

    call("new_project", {"name": "Nexus OS · Logo 绘制"})
    call("set_sequence", {"width": 1920, "height": 1080, "frameRate": 30,
                          "durationMs": DURATION})

    def add(node_type, **params):
        nid = call("add_node", {"nodeType": node_type})["node"]["id"]
        for k, v in params.items():
            call("set_node_param", {"nodeId": nid, "param": k, "value": v})
        return nid

    # 白底（渐变两端同色 = 纯白）+ 极淡构造网格
    bg = add("gradient", colorA="#ffffff", colorB="#ffffff", angle=90, opacity=100.0)
    grid = add("grid", spacing=60.0, lineWidth=1.0, color="#ededed", opacity=100.0)

    # 25 笔：progress 从 0 开始，后面用关键帧推上去
    lines = []
    for i, (x1, y1, x2, y2) in enumerate(STROKES):
        nid = add(
            "line",
            x1=round(x1 / CANVAS_W, 5), y1=round(y1 / CANVAS_H, 5),
            x2=round(x2 / CANVAS_W, 5), y2=round(y2 / CANVAS_H, 5),
            thickness=0.333, color="#000000", progress=0.0, opacity=100.0,
        )
        lines.append(nid)

    tf = add("transform", scale=100.0)

    nodes = call("get_graph").get("nodes", [])
    output_id = next((n["id"] for n in nodes
                      if n.get("type") == "output" or n.get("nodeType") == "output"), None)
    if not output_id:
        raise SystemExit("图里找不到输出节点")

    chain = [(bg, grid)] + [(grid if i == 0 else lines[i - 1], lines[i]) for i in range(len(lines))]
    chain += [(lines[-1], tf), (tf, output_id)]
    for a, b in chain:
        call("connect", {"fromNode": a, "fromPlug": "out", "toNode": b, "toPlug": "in"})

    def key(target, param, t, v, easing="ease-in-out"):
        call("set_keyframe", {"targetId": target, "param": param,
                              "timeMs": float(t), "value": float(v), "easing": easing})

    # 25 笔均分整段：每笔 360ms（9s/25），首尾相接，匀速生长
    per = DURATION / len(lines)
    for i, nid in enumerate(lines):
        start = i * per
        key(nid, "progress", start, 0.0, "linear")
        key(nid, "progress", start + per * 0.92, 100.0, "linear")

    # 摄像机缓慢推近 25%
    key(tf, "scale", 0, 100.0, "ease-in-out")
    key(tf, "scale", DURATION, 125.0, "ease-in-out")

    print(f"图已搭好：{len(chain)} 条连线（25 笔 + 底 + 网格 + 推镜）")
    call("save_project", {"path": PROJECT})
    print("工程:", PROJECT)

    print(f"开始导出 {DURATION}ms / 1080p")
    r = call("render_video", {"projectPath": PROJECT, "outputPath": MP4,
                              "preset": "h264-1080p", "startMs": 0, "endMs": DURATION})
    print(json.dumps(r, ensure_ascii=False)[:260])
    m.close()


if __name__ == "__main__":
    main()
