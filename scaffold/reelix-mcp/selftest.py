"""最小 MCP stdio 客户端：用来证明 reelix-mcp 真的能跑、工具真的能调。

不引任何 SDK，手写 JSON-RPC 一行一条消息，与 docs/13 的协议说明一致。
"""
import json
import subprocess
import sys

EXE = r"D:\20533\deskbox\fangwork\Reelix\scaffold\reelix-mcp\target\release\reelix-mcp.exe"


class Mcp:
    def __init__(self, exe):
        self.p = subprocess.Popen(
            [exe],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._id = 0

    def _send(self, obj):
        self.p.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self.p.stdin.flush()

    def _recv(self):
        line = self.p.stdout.readline()
        if not line:
            err = self.p.stderr.read()
            raise RuntimeError(f"MCP 无输出，stderr={err!r}")
        return json.loads(line)

    def request(self, method, params=None):
        self._id += 1
        msg = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            msg["params"] = params
        self._send(msg)
        return self._recv()

    def notify(self, method, params=None):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        self._send(msg)

    def call(self, name, args=None):
        r = self.request("tools/call", {"name": name, "arguments": args or {}})
        return r

    def close(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.wait(timeout=5)
        except Exception:
            self.p.kill()


def text_of(resp):
    """把 tools/call 的 content 拼成纯文本。"""
    res = resp.get("result", {})
    parts = []
    for c in res.get("content", []):
        if c.get("type") == "text":
            parts.append(c.get("text", ""))
    return "\n".join(parts), res.get("isError", False)


if __name__ == "__main__":
    m = Mcp(EXE)
    init = m.request(
        "initialize",
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "reelix-mcp-selftest", "version": "1.0"},
        },
    )
    print("initialize:", json.dumps(init.get("result", {}).get("serverInfo", {}), ensure_ascii=False))
    m.notify("notifications/initialized")

    tl = m.request("tools/list")
    names = [t["name"] for t in tl["result"]["tools"]]
    print(f"tools/list: {len(names)} 个")
    print("  ", ", ".join(names))

    # 建一个空工程，确认工具真的改到了会话里的工程
    r = m.call("new_project", {"name": "自检工程"})
    body, is_err = text_of(r)
    print("new_project:", "ERR " if is_err else "OK ", body[:200])

    r = m.call("get_timeline")
    body, is_err = text_of(r)
    print("get_timeline:", "ERR " if is_err else "OK ", body[:300])

    m.close()
