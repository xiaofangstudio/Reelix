"""Reelix 30 秒展示片（全 Reelix 渲染，无任何外部剪辑软件）。

结构：一个工程、一条图链，靠 opacity / 位置 / 缩放关键帧分五幕推进：
  ① 0-7s   开场：网格淡入、双环 + 双圈刻度、REELIX 大标题 + 副标
  ② 6.6-13s 图片登场：山林图从 18% 放大到 58%，下移让位给文字
  ③ 13.5-20s 功能幕：图片缩到 34% 移到左侧，右侧滑入功能词，环向外扩张
  ④ 20-27s  收束：图与功能词淡出，签名浮现
  ⑤ 27-30s  整体压黑收尾

素材只用 Reelix 自己的生成节点 + 一张山林图（用户认可的启动页图），
**不使用任何含人物/宠物的实拍素材**。

全程只用 MCP 工具，跑法：python make_showcase.py [时长毫秒] [预设]
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
PROJECT = os.path.join(OUT_DIR, "reelix_showcase_30s.reelix")
MP4 = os.path.join(OUT_DIR, "reelix_showcase_30s.mp4")
PHOTO = r"C:\Users\ASUS\Desktop\liquid-glass-web\bg-3.jpg"

DURATION = int(sys.argv[1]) if len(sys.argv) > 1 else 30000
PRESET = sys.argv[2] if len(sys.argv) > 2 else "h264-720p-proxy"

# Reelix 品牌绿
BG_DEEP, BG_EDGE = "#04120b", "#0f2b1e"
GRID = "#12301f"
RING_OUT, TICK_OUT = "#57c08f", "#6fd3a2"
RING_MID, TICK_IN = "#2f8a5e", "#3fa877"
TITLE, SUB = "#eafff5", "#7ddcae"


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for f in (PROJECT, MP4):
        if os.path.exists(f):
            os.remove(f)

    m = Mcp(EXE)
    m.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                             "clientInfo": {"name": "showcase", "version": "1"}})
    m.notify("notifications/initialized")

    def call(tool, args=None):
        body, is_err = text_of(m.call(tool, args or {}))
        if is_err:
            raise SystemExit(f"[MCP 失败] {tool}: {body}")
        body = body.strip()
        return json.loads(body) if body.startswith(("{", "[")) else body

    call("new_project", {"name": "Reelix 30 秒展示片"})

    def add(node_type, **params):
        nid = call("add_node", {"nodeType": node_type})["node"]["id"]
        for k, v in params.items():
            call("set_node_param", {"nodeId": nid, "param": k, "value": v})
        return nid

    # ---------------- 图链 ----------------
    bg = add("gradient", colorA=BG_DEEP, colorB=BG_EDGE, angle=90)
    grid = add("grid", spacing=64.0, lineWidth=1.0, color=GRID, opacity=0.0)
    r_out = add("ring", centerX=0.5, centerY=0.5, radius=46.0,
                thickness=0.5, color=RING_OUT, feather=1.2, opacity=0.0)
    t_out = add("ringTicks", centerX=0.5, centerY=0.5, count=96.0, radius=51.0,
                tickLength=2.6, thickness=0.4, color=TICK_OUT, opacity=0.0)
    r_mid = add("ring", centerX=0.5, centerY=0.5, radius=37.0,
                thickness=0.2, color=RING_MID, feather=0.8, opacity=0.0)
    t_in = add("ringTicks", centerX=0.5, centerY=0.5, count=48.0, radius=33.0,
               tickLength=1.3, thickness=0.3, startAngle=7.5, color=TICK_IN, opacity=0.0)
    pic = add("image", source=PHOTO, opacity=0.0, posX=0.5, posY=0.5, scale=18.0)
    title = add("text", text="REELIX", fontSize=92.0, color=TITLE, align="center",
                offsetY=-5.0, opacity=0.0)
    sub = add("text", text="RUST · TAURI · REAL-TIME", fontSize=26.0, color=SUB,
              align="center", offsetY=11.0, opacity=0.0)
    feat = add("text", text="剪辑 · 特效 · 3D 摄像机 · 关键帧", fontSize=30.0, color=TITLE,
               align="center", offsetY=6.0, offsetX=14.0, opacity=0.0)
    sign = add("text", text="XIAOFANG STUDIO", fontSize=18.0, color=TICK_IN,
               align="center", offsetY=30.0, opacity=0.0)
    glow = add("glow", threshold=55.0, radius=24.0, strength=55.0)
    tf = add("transform", scale=100.0)
    # 收尾压黑：一层黑色渐变，最后 3 秒把不透明度推到 100
    black = add("gradient", colorA="#000000", colorB="#000000", angle=90, opacity=0.0)

    nodes = call("get_graph").get("nodes", [])
    output_id = next((n["id"] for n in nodes
                      if n.get("type") == "output" or n.get("nodeType") == "output"), None)
    if not output_id:
        raise SystemExit("图里找不到输出节点")

    chain = [(bg, grid), (grid, r_out), (r_out, t_out), (t_out, r_mid), (r_mid, t_in),
             (t_in, pic), (pic, title), (title, sub), (sub, feat), (feat, sign),
             (sign, glow), (glow, tf), (tf, black), (black, output_id)]
    for a, b in chain:
        call("connect", {"fromNode": a, "fromPlug": "out", "toNode": b, "toPlug": "in"})

    # ---------------- 关键帧 ----------------
    def key(target, param, t, v, easing="ease-in-out"):
        call("set_keyframe", {"targetId": target, "param": param,
                              "timeMs": float(t), "value": float(v), "easing": easing})

    # ① 开场 0-7s
    key(grid, "opacity", 0, 0); key(grid, "opacity", 1200, 32)
    key(r_out, "opacity", 300, 0); key(r_out, "opacity", 900, 100)
    key(t_out, "opacity", 500, 0); key(t_out, "opacity", 1100, 100)
    key(r_mid, "opacity", 700, 0); key(r_mid, "opacity", 1300, 100)
    key(t_in, "opacity", 900, 0); key(t_in, "opacity", 1500, 100)
    key(title, "opacity", 900, 0); key(title, "opacity", 1700, 100)
    key(title, "opacity", 6200, 100); key(title, "opacity", 7000, 0)
    key(title, "fontSize", 900, 92); key(title, "fontSize", 1800, 118)
    key(sub, "opacity", 1600, 0); key(sub, "opacity", 2400, 100)
    key(sub, "opacity", 6200, 100); key(sub, "opacity", 7000, 0)
    # 刻度一直转 + 外环呼吸
    key(t_out, "startAngle", 0, 0, "linear"); key(t_out, "startAngle", DURATION, 540, "linear")
    key(t_in, "startAngle", 0, 7.5, "linear"); key(t_in, "startAngle", DURATION, -532.5, "linear")
    key(r_out, "radius", 0, 46); key(r_out, "radius", 10000, 48); key(r_out, "radius", 20000, 46)

    # ② 6.6-13s 图片登场
    key(pic, "opacity", 6600, 0); key(pic, "opacity", 7700, 100)
    key(pic, "scale", 6600, 18); key(pic, "scale", 8800, 58, "ease-out")
    key(pic, "posY", 6600, 0.5); key(pic, "posY", 8800, 0.62)

    # ③ 13.5-20s 功能幕：图缩到左侧，功能词从右滑入
    key(pic, "scale", 13500, 58); key(pic, "scale", 15500, 34)
    key(pic, "posX", 13500, 0.5); key(pic, "posX", 15500, 0.26)
    key(pic, "posY", 13500, 0.62); key(pic, "posY", 15500, 0.5)
    key(feat, "opacity", 14300, 0); key(feat, "opacity", 16000, 100)
    key(feat, "offsetX", 14300, 14); key(feat, "offsetX", 16200, 16)
    key(r_out, "radius", 13500, 46); key(r_out, "radius", 20500, 78)

    # ④ 20-27s 收束
    key(pic, "opacity", 20000, 100); key(pic, "opacity", 21200, 0)
    key(feat, "opacity", 20000, 100); key(feat, "opacity", 21200, 0)
    key(sign, "opacity", 21000, 0); key(sign, "opacity", 22800, 100)
    key(r_out, "opacity", 20000, 100); key(r_out, "opacity", 23000, 45)
    key(t_out, "opacity", 20000, 100); key(t_out, "opacity", 23000, 40)

    # ⑤ 27-30s 压黑
    key(black, "opacity", 27000, 0); key(black, "opacity", 30000, 100)

    print(f"图已搭好：{len(chain)} 条连线 + 多幕关键帧")
    call("save_project", {"path": PROJECT})
    print("工程:", PROJECT)

    print(f"开始导出 {DURATION}ms / {PRESET} …")
    r = call("render_video", {"projectPath": PROJECT, "outputPath": MP4,
                              "preset": PRESET, "startMs": 0, "endMs": DURATION})
    print(json.dumps(r, ensure_ascii=False)[:300])
    m.close()


if __name__ == "__main__":
    main()
