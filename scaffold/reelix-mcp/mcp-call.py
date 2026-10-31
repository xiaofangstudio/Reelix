"""命令行调用 reelix-mcp 的任意工具（不经宿主，直连 stdio）。

宿主面板里的原生工具需要人工点一次“信任”才会出现；在那之前，
这个脚本就是我的常备通道——功能完全一样，调的是同一个 MCP 进程。

注意：MCP 每次启动都是**空会话**（工程只活在进程内存里），
所以多步操作必须写进同一个批次，不能一条条分开跑。

用法：
    python mcp-call.py                          # 列出全部工具
    python mcp-call.py list_node_types          # 单步调用
    python mcp-call.py new_project '{"name":"测试工程"}'
    python mcp-call.py --batch steps.json       # 多步同一会话（推荐）

steps.json 形状：
    [
      {"tool": "new_project", "args": {"name": "复刻"}},
      {"tool": "import_media", "args": {"path": "C:/a.mp4", "addToTimeline": true}},
      {"tool": "get_timeline"}
    ]

退出码：0 成功；1 某个工具报错；2 协议/启动失败。
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


def _open():
    m = Mcp(EXE)
    m.request(
        "initialize",
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "cli", "version": "1"},
        },
    )
    m.notify("notifications/initialized")
    return m


def _run_batch(m, steps):
    """在一个会话里顺序执行多步，遇到错误立刻停（后续步骤依赖前置状态）。"""
    for i, step in enumerate(steps, 1):
        tool = step.get("tool")
        args = step.get("args") or {}
        if not tool:
            print(f"[{i}] 跳过：缺少 tool")
            return 1
        body, is_err = text_of(m.call(tool, args))
        flag = "ERR" if is_err else "OK "
        print(f"[{flag}] {i}/{len(steps)} {tool}: {body[:400]}")
        if is_err:
            print("→ 后续步骤已中止（前一步失败，状态不可靠）")
            return 1
    return 0


def main(argv):
    batch_file = None
    if len(argv) >= 3 and argv[1] == "--batch":
        batch_file = argv[2]

    m = _open()
    try:
        if batch_file:
            with open(batch_file, "r", encoding="utf-8") as f:
                steps = json.load(f)
            return _run_batch(m, steps)

        if len(argv) < 2:
            r = m.request("tools/list")
            names = [t["name"] for t in r["result"]["tools"]]
            print(f"{len(names)} 个工具：")
            for n in names:
                print("  -", n)
            return 0

        tool = argv[1]
        args = json.loads(argv[2]) if len(argv) > 2 else {}
        body, is_err = text_of(m.call(tool, args))
        print(body)
        return 1 if is_err else 0
    except Exception as e:  # noqa: BLE001
        print(f"调用失败：{e}", file=sys.stderr)
        return 2
    finally:
        m.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
