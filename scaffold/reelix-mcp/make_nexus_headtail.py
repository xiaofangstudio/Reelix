"""Nexus OS 宣传片 · 头尾两段（教程第 0 段与第 5 段）。

段 0（0–90 帧 / 3 秒）：光敏性癫痫警告，黑底白字
段 5（1020–1200 帧 / 6 秒）：乱码风暴 → logo 25 笔逐笔锁定，白底黑字

全程只用 MCP。跑法：python make_nexus_headtail.py [warn|code|both]
"""
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from selftest import Mcp, text_of  # noqa: E402

EXE = os.environ.get(
    "REELIX_MCP_EXE",
    r"D:\20533\deskbox\fangwork\Reelix\scaffold\reelix-mcp\target\release\reelix-mcp.exe",
)
OUT_DIR = r"D:\20533\deskbox\fangwork\Reelix\out"
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

WARN_BODY = (
    "部分人群在观看含有闪烁光线或强烈视觉图案的内容时可能诱发癫痫发作。\n"
    "如果您或家人有癫痫病史，请在观看前咨询医生。\n"
    "观看时若出现头晕、视力模糊、眼睛或面部抽搐，请立即停止观看。"
)

GARBLE_CHARS = "█▓▒░▚▞◤◥◣◢#%&@$*+=<>/\\|~^01"


def connect(m):
    m.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                             "clientInfo": {"name": "nexus-headtail", "version": "1"}})
    m.notify("notifications/initialized")
    return m


def make_call(m):
    def call(tool, args=None):
        body, is_err = text_of(m.call(tool, args or {}))
        if is_err:
            raise SystemExit(f"[MCP 失败] {tool}: {body}")
        body = body.strip()
        return json.loads(body) if body.startswith(("{", "[")) else body
    return call


def add_node(call, node_type, **params):
    nid = call("add_node", {"nodeType": node_type})["node"]["id"]
    for k, v in params.items():
        call("set_node_param", {"nodeId": nid, "param": k, "value": v})
    return nid


def make_key(call):
    def key(target, param, t, v, easing="ease-in-out", **extra):
        payload = {"targetId": target, "param": param, "timeMs": float(t), "value": float(v),
                   "easing": easing}
        payload.update(extra)
        call("set_keyframe", payload)
    return key


def output_of(call):
    nodes = call("get_graph").get("nodes", [])
    return next((n["id"] for n in nodes
                 if n.get("type") == "output" or n.get("nodeType") == "output"), None)


def build_warn(call):
    """段 0：光敏警告（0–90 帧 / 3 秒）。"""
    call("new_project", {"name": "Nexus OS · 光敏警告"})
    call("set_sequence", {"width": 1920, "height": 1080, "frameRate": 30, "durationMs": 3000})

    bg = add_node(call, "gradient", colorA="#000000", colorB="#000000", angle=90, opacity=100.0)
    # 警告三角：用 3 条 line 拼（Reelix 没有多边形节点，线段足够）
    tri_a = add_node(call, "line", x1=0.470, y1=0.315, x2=0.500, y2=0.245,
                     thickness=0.42, color="#ffffff", progress=100.0, opacity=100.0)
    tri_b = add_node(call, "line", x1=0.500, y1=0.245, x2=0.530, y2=0.315,
                     thickness=0.42, color="#ffffff", progress=100.0, opacity=100.0)
    tri_c = add_node(call, "line", x1=0.470, y1=0.315, x2=0.530, y2=0.315,
                     thickness=0.42, color="#ffffff", progress=100.0, opacity=100.0)
    tri_d = add_node(call, "line", x1=0.500, y1=0.272, x2=0.500, y2=0.292,
                     thickness=0.42, color="#ffffff", progress=100.0, opacity=100.0)
    title = add_node(call, "text", text="光敏性癫痫警告", fontSize=64.0, color="#ffffff",
                     align="center", offsetY=-18.0, opacity=100.0)
    body = add_node(call, "text", text=WARN_BODY, fontSize=24.0, color="#cfcfcf",
                    align="center", offsetY=4.0, opacity=100.0)
    tf = add_node(call, "transform", scale=100.0)

    out = output_of(call)
    for a, b in [(bg, tri_a), (tri_a, tri_b), (tri_b, tri_c), (tri_c, tri_d),
                 (tri_d, title), (title, body), (body, tf), (tf, out)]:
        call("connect", {"fromNode": a, "fromPlug": "out", "toNode": b, "toPlug": "in"})

    key = make_key(call)
    # 标题先出、正文跟上；整体在最后 12 帧轻微压暗收尾
    key(title, "opacity", 0, 0, "ease-out")
    key(title, "opacity", 420, 100, "ease-out")
    key(body, "opacity", 300, 0, "ease-out")
    key(body, "opacity", 1100, 100, "ease-out")
    key(tf, "scale", 0, 100.0, "ease-in-out")
    key(tf, "scale", 3000, 103.0, "ease-in-out")
    return 3000


def build_code(call):
    """段 5：乱码风暴 → logo 逐笔锁定（0–6000ms，对应 1020–1200 帧）。"""
    call("new_project", {"name": "Nexus OS · 乱码结尾"})
    call("set_sequence", {"width": 1920, "height": 1080, "frameRate": 30, "durationMs": 6000})

    bg = add_node(call, "gradient", colorA="#ffffff", colorB="#ffffff", angle=90, opacity=100.0)

    # 乱码风暴：5 行随机字符，灰 #999，前 25 帧后淡出
    random.seed(20261025)
    rows = []
    for r in range(5):
        line = "".join(random.choice(GARBLE_CHARS) for _ in range(42))
        rows.append(line)
    garble = add_node(call, "text", text="\n".join(rows), fontSize=30.0, color="#999999",
                      align="center", offsetY=0.0, opacity=100.0)

    # logo 25 笔，初始 progress=0
    lines = []
    for (x1, y1, x2, y2) in STROKES:
        lines.append(add_node(
            call, "line",
            x1=round(x1 / CANVAS_W, 5), y1=round(y1 / CANVAS_H, 5),
            x2=round(x2 / CANVAS_W, 5), y2=round(y2 / CANVAS_H, 5),
            thickness=0.333, color="#000000", progress=0.0, opacity=100.0,
        ))
    tf = add_node(call, "transform", scale=100.0)

    out = output_of(call)
    chain = [(bg, garble)] + [(garble if i == 0 else lines[i - 1], lines[i]) for i in range(len(lines))]
    chain += [(lines[-1], tf), (tf, out)]
    for a, b in chain:
        call("connect", {"fromNode": a, "fromPlug": "out", "toNode": b, "toPlug": "in"})

    key = make_key(call)
    # 乱码：前 25 帧可见（约 833ms），之后淡出
    key(garble, "opacity", 0, 100, "linear")
    key(garble, "opacity", 700, 100, "linear")
    key(garble, "opacity", 1000, 0, "ease-out")

    # logo 逐笔锁定：局部帧 30–90 → 1000–3000ms，25 笔均分
    start_ms, end_ms = 1000.0, 3000.0
    per = (end_ms - start_ms) / len(lines)
    for i, nid in enumerate(lines):
        s = start_ms + i * per
        key(nid, "progress", s, 0.0, "linear")
        key(nid, "progress", s + per * 0.85, 100.0, "linear")

    # 最后 3 秒静止（不做任何动画），只留一个极缓的推近
    key(tf, "scale", 3000, 100.0, "ease-in-out")
    key(tf, "scale", 6000, 101.5, "ease-in-out")
    return 6000


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "both"
    jobs = []
    if which in ("warn", "both"):
        jobs.append(("nexus_warn", build_warn, "h264-1080p"))
    if which in ("code", "both"):
        jobs.append(("nexus_code", build_code, "h264-1080p"))

    for name, builder, preset in jobs:
        project = os.path.join(OUT_DIR, f"{name}.reelix")
        mp4 = os.path.join(OUT_DIR, f"{name}.mp4")
        for f in (project, mp4):
            if os.path.exists(f):
                os.remove(f)

        m = connect(Mcp(EXE))
        call = make_call(m)
        duration = builder(call)
        call("save_project", {"path": project})
        print(f"[{name}] 工程已存，导出 {duration}ms …")
        r = call("render_video", {"projectPath": project, "outputPath": mp4,
                                  "preset": preset, "startMs": 0, "endMs": duration})
        print(f"[{name}]", json.dumps(r, ensure_ascii=False)[:200])
        m.close()


if __name__ == "__main__":
    main()
