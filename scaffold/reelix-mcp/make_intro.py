"""用 MCP 搭 Reelix 自己的绿色开场（不是照搬 EffectCraft）。

和参考片的区别（这些都是我们自己加的）：
- 配色走 Reelix 品牌绿（#57c08f / #6fd3a2 / 深墨绿底），不是人家的深蓝紫
- 多一层 HUD 网格底纹（grid 节点）
- 双圈刻度：外圈 96 根长刻度 + 内圈 48 根短刻度（参考片只有一圈）
- 三段文字：主标题 + 技术副标 + 底部签名，靠 offsetY 分层
- 发光阈值/强度按绿调重新调

全程只用 MCP 工具，不碰 JSON、不调内部函数。
跑法：python make_intro.py [时长毫秒] [预设]
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
PROJECT = os.path.join(OUT_DIR, "reelix_intro_green.reelix")
MP4 = os.path.join(OUT_DIR, "reelix_intro_green.mp4")
DURATION = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
PRESET = sys.argv[2] if len(sys.argv) > 2 else "h264-720p-proxy"

# —— Reelix 品牌绿 ——
BG_DEEP = "#04120b"   # 最深墨绿
BG_EDGE = "#0f2b1e"   # 渐变另一端
GRID = "#12301f"
RING_OUT = "#57c08f"  # --rl-accent-fill
TICK_OUT = "#6fd3a2"  # 暗色主题 accent
RING_MID = "#2f8a5e"
TICK_IN = "#3fa877"
TITLE = "#eafff5"
SUB = "#7ddcae"


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for f in (PROJECT, MP4):
        if os.path.exists(f):
            os.remove(f)

    m = Mcp(EXE)
    m.request(
        "initialize",
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "make-intro-green", "version": "1"},
        },
    )
    m.notify("notifications/initialized")

    def call(tool, args=None):
        body, is_err = text_of(m.call(tool, args or {}))
        if is_err:
            raise SystemExit(f"[MCP 失败] {tool}: {body}")
        body = body.strip()
        if body.startswith(("{", "[")):
            return json.loads(body)
        return body

    call("new_project", {"name": "Reelix 绿色开场"})

    def add(node_type, **params):
        r = call("add_node", {"nodeType": node_type})
        nid = r["node"]["id"]
        for k, v in params.items():
            call("set_node_param", {"nodeId": nid, "param": k, "value": v})
        return nid

    # —— 图链 ——
    bg = add("gradient", colorA=BG_DEEP, colorB=BG_EDGE, angle=90)
    grid = add("grid", spacing=64.0, lineWidth=1.0, color=GRID)
    r_out = add("ring", centerX=0.5, centerY=0.5, radius=46.0,
                thickness=0.5, color=RING_OUT, feather=1.2)
    t_out = add("ringTicks", centerX=0.5, centerY=0.5, count=96.0, radius=51.0,
                tickLength=2.6, thickness=0.4, startAngle=0.0, color=TICK_OUT)
    r_mid = add("ring", centerX=0.5, centerY=0.5, radius=37.0,
                thickness=0.2, color=RING_MID, feather=0.8)
    t_in = add("ringTicks", centerX=0.5, centerY=0.5, count=48.0, radius=33.0,
               tickLength=1.3, thickness=0.3, startAngle=7.5, color=TICK_IN)
    title = add("text", text="REELIX", fontSize=118.0, color=TITLE,
                align="center", offsetY=-5.0)
    sub = add("text", text="RUST · TAURI · REAL-TIME", fontSize=26.0, color=SUB,
              align="center", offsetY=11.0)
    sign = add("text", text="XIAOFANG STUDIO", fontSize=16.0, color=TICK_IN,
               align="center", offsetY=34.0)
    glow = add("glow", threshold=55.0, radius=24.0, strength=85.0)
    tf = add("transform", scale=100.0)

    graph = call("get_graph")
    nodes = graph.get("nodes", graph if isinstance(graph, list) else [])
    output_id = next(
        (n["id"] for n in nodes if n.get("type") == "output" or n.get("nodeType") == "output"),
        None,
    )
    if not output_id:
        raise SystemExit("图里找不到输出节点")

    chain = [
        (bg, grid),
        (grid, r_out),
        (r_out, t_out),
        (t_out, r_mid),
        (r_mid, t_in),
        (t_in, title),
        (title, sub),
        (sub, sign),
        (sign, glow),
        (glow, tf),
        (tf, output_id),
    ]
    for a, b in chain:
        call("connect", {"fromNode": a, "fromPlug": "out", "toNode": b, "toPlug": "in"})

    # ---------------- 动效（关键帧） ----------------
    # 画面不能是死的：刻度转、环呼吸、光脉冲、文字分级淡入、整体推镜。
    def key(target, param, t, v, easing="ease-in-out"):
        call(
            "set_keyframe",
            {
                "targetId": target,
                "param": param,
                "timeMs": float(t),
                "value": float(v),
                "easing": easing,
            },
        )

    D = float(DURATION)
    # 外圈刻度匀速转一整圈的一半，内圈反向转 → 双层对转，最抓眼
    key(t_out, "startAngle", 0, 0, "linear")
    key(t_out, "startAngle", D, 180, "linear")
    key(t_in, "startAngle", 0, 7.5, "linear")
    key(t_in, "startAngle", D, -172.5, "linear")
    # 外环呼吸（半径慢慢涨落）
    key(r_out, "radius", 0, 46.0)
    key(r_out, "radius", D / 2, 48.5)
    key(r_out, "radius", D, 46.0)
    # 发光脉冲
    key(glow, "strength", 0, 45)
    key(glow, "strength", D / 2, 100)
    key(glow, "strength", D, 45)
    # 主标题：淡入 + 由小涨到定尺（0~700ms）
    key(title, "opacity", 0, 0, "ease-out")
    key(title, "opacity", 520, 100, "ease-out")
    key(title, "fontSize", 0, 90, "ease-out")
    key(title, "fontSize", 760, 118, "ease-out")
    # 副标：延迟到 500ms 才开始淡入
    key(sub, "opacity", 0, 0)
    key(sub, "opacity", 500, 0)
    key(sub, "opacity", 1150, 100, "ease-out")
    # 签名：再晚一点
    key(sign, "opacity", 0, 0)
    key(sign, "opacity", 900, 0)
    key(sign, "opacity", 1600, 100, "ease-out")
    # 整体推镜：一开始略放大，缓慢回落到 100（缓出，像镜头推进）
    key(tf, "scale", 0, 106)
    key(tf, "scale", D, 100, "ease-out")

    print(f"图已搭好：{len(chain)} 条连线 + 动效关键帧，输出 {output_id}")
    call("save_project", {"path": PROJECT})
    print("工程已保存:", PROJECT)

    print(f"开始导出 {DURATION}ms / {PRESET} …")
    r = call(
        "render_video",
        {
            "projectPath": PROJECT,
            "outputPath": MP4,
            "preset": PRESET,
            "startMs": 0,
            "endMs": DURATION,
        },
    )
    print(json.dumps(r, ensure_ascii=False)[:400])
    m.close()


if __name__ == "__main__":
    main()
