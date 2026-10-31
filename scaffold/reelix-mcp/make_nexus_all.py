"""Nexus OS 宣传片 · 单一完整工程（40 秒，六段合一）。

之前是 6 个独立工程（分段渲染用），但交付形态应该是**一个工程**。
难点：Reelix 的节点图作用于整个序列，不能按时间段换链，
所以六段全部塞进同一张图，靠 opacity 关键帧分段显隐：

  0-3s    警告页   黑底 + 三角 + 标题 + 正文
  3-12s   Logo     白底 + 网格 + 25 条黑线逐笔生长
  12-13.3 反色     invert.amount 4 帧内 0→100
  13.3-34 蒙太奇   184 段图片片段 + 25 条白线 logo（A 段亮，B 段灭）
  34-40   乱码     白底 + 乱码文字 + 25 条黑线重新逐笔锁定

跑法：python make_nexus_all.py [--no-render]
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
BASE = r"D:\20533\deskbox\fangwork\Reelix\reference\nexusos\frames"
OUT_DIR = r"D:\20533\deskbox\fangwork\Reelix\out"
PROJECT = os.path.join(OUT_DIR, "NexusOS_宣传片_完整工程.reelix")
MP4 = os.path.join(OUT_DIR, "nexus_all.mp4")

FPS = 30
TOTAL = 40000
CANVAS_W, CANVAS_H = 1084.0, 609.0

# 六段时间（ms）
T_WARN_END = 3000
T_LOGO_END = 12000
T_INVERT_END = 13333
T_MA_END = 21333
T_MB_END = 34000
T_CODE_START = 34000

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
GARBLE = "█▓▒░▚▞◤◥◣◢#%&@$*+=<>/\\|~^01"

# 蒙太奇排片：A 段 80 张，B 段 100 张 + 4 次重放
def montage_plan():
    plan = []
    t = T_INVERT_END
    for i in range(80):                      # A
        plan.append((t, 100, i))
        t += 100
    for i in range(1, 101):                  # B
        plan.append((t, 100, 80 + i - 1))
        t += 100
        if i in (20, 50, 75, 100):
            plan.append((t, 667, 80 + max(0, i // 2 - 1)))  # 20 帧重放
            t += 667
    return plan


def norm(x, y, k=1.0):
    return (round(0.5 + (x / CANVAS_W - 0.5) * k, 5),
            round(0.5 + (y / CANVAS_H - 0.5) * k, 5))


def main():
    render = "--no-render" not in sys.argv
    os.makedirs(OUT_DIR, exist_ok=True)
    for f in (PROJECT, MP4):
        if os.path.exists(f):
            os.remove(f)

    m = Mcp(EXE)
    m.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                             "clientInfo": {"name": "nexus-all", "version": "1"}})
    m.notify("notifications/initialized")

    def call(tool, args=None):
        body, is_err = text_of(m.call(tool, args or {}))
        if is_err:
            raise SystemExit(f"[MCP 失败] {tool}: {body}")
        body = body.strip()
        return json.loads(body) if body.startswith(("{", "[")) else body

    call("new_project", {"name": "Nexus OS 宣传片（完整工程）"})
    call("set_sequence", {"width": 1920, "height": 1080, "frameRate": FPS,
                          "durationMs": TOTAL})

    def add(node_type, **params):
        nid = call("add_node", {"nodeType": node_type})["node"]["id"]
        for k, v in params.items():
            call("set_node_param", {"nodeId": nid, "param": k, "value": v})
        return nid

    def key(target, param, t, v, easing="ease-in-out"):
        call("set_keyframe", {"targetId": target, "param": param,
                              "timeMs": float(t), "value": float(v), "easing": easing})

    # ---------- 背景：黑/白互补 ----------
    bg_black = add("gradient", colorA="#000000", colorB="#000000", angle=90, opacity=100.0)
    bg_white = add("gradient", colorA="#ffffff", colorB="#ffffff", angle=90, opacity=0.0)
    grid = add("grid", spacing=60.0, lineWidth=1.0, color="#ededed", opacity=0.0)

    # ---------- 警告页 ----------
    tri = []
    for (x1, y1, x2, y2) in [(0.470, 0.315, 0.500, 0.245),
                             (0.500, 0.245, 0.530, 0.315),
                             (0.470, 0.315, 0.530, 0.315),
                             (0.500, 0.272, 0.500, 0.292)]:
        tri.append(add("line", x1=x1, y1=y1, x2=x2, y2=y2, thickness=0.42,
                       color="#ffffff", progress=100.0, opacity=0.0))
    warn_title = add("text", text="光敏性癫痫警告", fontSize=64.0, color="#ffffff",
                     align="center", offsetY=-18.0, opacity=0.0)
    warn_body = add("text", text=WARN_BODY, fontSize=24.0, color="#cfcfcf",
                    align="center", offsetY=4.0, opacity=0.0)

    # ---------- Logo 25 笔（黑，logo 段与乱码段共用）----------
    black_lines = []
    for (x1, y1, x2, y2) in STROKES:
        ax, ay = norm(x1, y1)
        bx, by = norm(x2, y2)
        black_lines.append(add("line", x1=ax, y1=ay, x2=bx, y2=by, thickness=0.333,
                               color="#000000", progress=0.0, opacity=0.0))

    # ---------- 蒙太奇段白线 logo（72% 宽）----------
    k72 = 0.72 / (848.0 / CANVAS_W)
    white_lines = []
    for (x1, y1, x2, y2) in STROKES:
        ax, ay = norm(x1, y1, k72)
        bx, by = norm(x2, y2, k72)
        white_lines.append(add("line", x1=ax, y1=ay, x2=bx, y2=by, thickness=0.42,
                               color="#ffffff", progress=100.0, opacity=0.0))

    # ---------- 乱码 ----------
    random.seed(20261025)
    rows = ["".join(random.choice(GARBLE) for _ in range(42)) for _ in range(5)]
    garble = add("text", text="\n".join(rows), fontSize=30.0, color="#999999",
                 align="center", offsetY=0.0, opacity=0.0)

    inv = add("invert", amount=0.0)
    tf = add("transform", scale=100.0)

    nodes = call("get_graph").get("nodes", [])
    out = next((n["id"] for n in nodes
                if n.get("type") == "output" or n.get("nodeType") == "output"), None)
    seq_id = next((n["id"] for n in nodes
                   if n.get("type") == "sequence" or n.get("nodeType") == "sequence"), None)

    chain = [(seq_id, bg_black), (bg_black, bg_white), (bg_white, grid)]
    chain += [(grid, tri[0])] + [(tri[i - 1], tri[i]) for i in range(1, 4)]
    chain += [(tri[-1], warn_title), (warn_title, warn_body), (warn_body, black_lines[0])]
    chain += [(black_lines[i - 1], black_lines[i]) for i in range(1, len(black_lines))]
    chain += [(black_lines[-1], white_lines[0])]
    chain += [(white_lines[i - 1], white_lines[i]) for i in range(1, len(white_lines))]
    chain += [(white_lines[-1], garble), (garble, inv), (inv, tf), (tf, out)]
    for a, b in chain:
        call("connect", {"fromNode": a, "fromPlug": "out", "toNode": b, "toPlug": "in"})
    print(f"图已搭好：{len(chain)} 条连线")

    # ---------- 时间线：蒙太奇 184 段 ----------
    plan = montage_plan()
    needed = sorted({idx for _, _, idx in plan})
    asset_of = {}
    for idx in needed:
        asset_of[idx] = call("import_media",
                             {"path": os.path.join(BASE, f"{idx:03d}.jpg"),
                              "addToTimeline": False})["assetId"]
    seq_info = call("get_timeline")[0]
    v_track = next((t["id"] for t in seq_info["tracks"] if t.get("kind") == "video"), None)
    for start, dur, idx in plan:
        call("add_clip", {"assetId": asset_of[idx], "trackId": v_track,
                          "startMs": start, "durationMs": dur})
    print(f"时间线：{len(plan)} 段图片片段，{len(asset_of)} 张素材")

    # ---------- 关键帧：六段显隐 ----------
    key(bg_black, "opacity", 0, 100.0, "linear")
    key(bg_black, "opacity", T_WARN_END, 100.0, "linear")
    key(bg_black, "opacity", T_WARN_END + 100, 0.0, "linear")
    key(bg_white, "opacity", 0, 0.0, "linear")
    key(bg_white, "opacity", T_WARN_END, 0.0, "linear")
    key(bg_white, "opacity", T_WARN_END + 100, 100.0, "linear")
    # 蒙太奇段必须让白底退场，否则 184 段图片会被整层白色盖掉（第一版就是这么翻车的）
    key(bg_white, "opacity", T_INVERT_END - 150, 100.0, "linear")
    key(bg_white, "opacity", T_INVERT_END + 50, 0.0, "linear")
    # 乱码段再回到白底
    key(bg_white, "opacity", T_CODE_START - 50, 0.0, "linear")
    key(bg_white, "opacity", T_CODE_START + 100, 100.0, "linear")

    key(grid, "opacity", T_WARN_END, 0.0)
    key(grid, "opacity", T_WARN_END + 1200, 32.0)

    for nid in tri:
        key(nid, "opacity", 200, 0.0, "ease-out")
        key(nid, "opacity", 600, 100.0, "ease-out")
        key(nid, "opacity", T_WARN_END - 200, 0.0, "ease-in")
    key(warn_title, "opacity", 200, 0.0, "ease-out")
    key(warn_title, "opacity", 700, 100.0, "ease-out")
    key(warn_title, "opacity", T_WARN_END - 200, 0.0, "ease-in")
    key(warn_body, "opacity", 700, 0.0, "ease-out")
    key(warn_body, "opacity", 1600, 100.0, "ease-out")
    key(warn_body, "opacity", T_WARN_END - 200, 0.0, "ease-in")

    # Logo：25 笔均分 3000→12000，opacity 段内常亮
    per = (T_LOGO_END - T_WARN_END) / len(black_lines)
    for i, nid in enumerate(black_lines):
        s = T_WARN_END + i * per
        key(nid, "opacity", T_WARN_END, 100.0, "linear")
        key(nid, "progress", s, 0.0, "linear")
        key(nid, "progress", s + per * 0.92, 100.0, "linear")
        # 反色后到蒙太奇前退场
        key(nid, "opacity", T_INVERT_END - 300, 100.0, "linear")
        key(nid, "opacity", T_INVERT_END + 100, 0.0, "linear")

    # 反色：12000 起停顿 400ms，再 4 帧内推到 100，到蒙太奇结束
    key(inv, "amount", 0, 0.0, "linear")
    key(inv, "amount", T_LOGO_END, 0.0, "linear")
    key(inv, "amount", T_LOGO_END + 400, 0.0, "linear")
    key(inv, "amount", T_LOGO_END + 533, 100.0, "ease-in-out")
    # 反色只属于「停顿反色」那一小段。第一版让它一直保持到 34 秒，
    # 结果整个蒙太奇段（190 张图）全被反色处理。
    key(inv, "amount", T_INVERT_END - 100, 100.0, "linear")
    key(inv, "amount", T_INVERT_END + 60, 0.0, "linear")

    # 白线 logo：A 段亮，B 段灭
    for nid in white_lines:
        key(nid, "opacity", T_INVERT_END, 0.0, "linear")
        key(nid, "opacity", T_INVERT_END + 400, 92.0, "ease-out")
        key(nid, "opacity", T_MA_END - 200, 92.0, "linear")
        key(nid, "opacity", T_MA_END, 0.0, "linear")

    # 乱码 + 重新逐笔锁定
    key(garble, "opacity", T_CODE_START, 0.0, "linear")
    key(garble, "opacity", T_CODE_START + 100, 100.0, "linear")
    key(garble, "opacity", T_CODE_START + 800, 100.0, "linear")
    key(garble, "opacity", T_CODE_START + 1100, 0.0, "ease-out")
    per2 = 2000.0 / len(black_lines)
    for i, nid in enumerate(black_lines):
        s = T_CODE_START + 1000 + i * per2
        key(nid, "opacity", T_CODE_START + 900, 100.0, "linear")
        key(nid, "progress", s, 0.0, "linear")
        key(nid, "progress", s + per2 * 0.85, 100.0, "linear")

    # 摄像机：全程缓推
    key(tf, "scale", 0, 100.0)
    key(tf, "scale", TOTAL, 104.0)

    call("save_project", {"path": PROJECT})
    print("完整工程:", PROJECT)
    if not render:
        m.close()
        return

    print(f"开始导出 {TOTAL}ms（节点较多，耗时较长）…")
    r = call("render_video", {"projectPath": PROJECT, "outputPath": MP4,
                              "preset": "h264-1080p", "startMs": 0, "endMs": TOTAL})
    print(json.dumps(r, ensure_ascii=False)[:240])
    m.close()


if __name__ == "__main__":
    main()
