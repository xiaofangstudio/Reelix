"""端到端：完全通过 MCP 完成「建工程 → 导素材 → 加字幕 → 存工程 → 导出成片」。

跑法：python mcp_e2e.py
成功标准：生成的 mp4 能被 ffprobe 读出时长，且工程文件能被重新打开。
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from selftest import Mcp, text_of  # noqa: E402

EXE = r"D:\20533\deskbox\fangwork\Reelix\scaffold\reelix-mcp\target\release\reelix-mcp.exe"
VIDEO = r"C:\Users\ASUS\Videos\小组作业\jason go to school.mp4"
OUT_DIR = r"D:\20533\deskbox\fangwork\Reelix\out"
PROJECT = os.path.join(OUT_DIR, "mcp_e2e.reelix")
MP4 = os.path.join(OUT_DIR, "mcp_e2e.mp4")
FFPROBE = r"D:\Tools\FFmpeg\ffmpeg-n9.0.1-11-ge47273f4d9-win64-gpl-9.0\bin\ffprobe.exe"


def show(label, resp):
    body, is_err = text_of(resp)
    print(f"[{'ERR' if is_err else 'OK '}] {label}: {body[:240]}")
    return body, is_err


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
            "clientInfo": {"name": "e2e", "version": "1"},
        },
    )
    m.notify("notifications/initialized")

    show("new_project", m.call("new_project", {"name": "MCP 端到端"}))
    show("import_media", m.call("import_media", {"path": VIDEO, "addToTimeline": True}))
    show(
        "add_subtitle",
        m.call(
            "add_subtitle",
            {"text": "这条字幕是 MCP 加进去的", "startMs": 500, "durationMs": 3000},
        ),
    )
    show("save_project", m.call("save_project", {"path": PROJECT}))

    print("→ 开始导出（这一步会真的跑 ffmpeg，可能需要一两分钟）…")
    body, is_err = show(
        "render_video",
        m.call(
            "render_video",
            {
                "projectPath": PROJECT,
                "outputPath": MP4,
                "preset": "h264-720p-proxy",
                "startMs": 0,
                "endMs": 5000,
            },
        ),
    )
    m.close()

    # 独立校验：产物真的存在、真的是视频
    print("\n=== 产物校验 ===")
    print("工程文件:", PROJECT, os.path.getsize(PROJECT) if os.path.exists(PROJECT) else "缺失")
    if os.path.exists(MP4):
        print("视频文件:", MP4, os.path.getsize(MP4), "字节")
        if os.path.exists(FFPROBE):
            out = subprocess.run(
                [FFPROBE, "-v", "error", "-show_entries",
                 "format=duration,size:stream=codec_name,width,height",
                 "-of", "default=nw=1", MP4],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
            )
            print(out.stdout.strip() or out.stderr.strip())
    else:
        print("视频文件: 缺失（导出失败）")

    # 再用 MCP 重新打开工程，证明工程文件可读
    m2 = Mcp(EXE)
    m2.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                              "clientInfo": {"name": "reopen", "version": "1"}})
    m2.notify("notifications/initialized")
    show("open_project", m2.call("open_project", {"path": PROJECT}))
    show("get_timeline", m2.call("get_timeline"))
    m2.close()


if __name__ == "__main__":
    main()
