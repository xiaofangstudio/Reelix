# -*- coding: utf-8 -*-
"""
内容层字体的**字符集定义**（子集化的唯一权威）。

规格来源：docs/09-3D摄像机与素材库.md 第 3.5 节「子集化规格（已定，不再浮动）」。

    | 汉字     | GB2312 全集 6763 字（一级 3755 + 二级 3008）        |
    | 西文数字 | ASCII 0x20-0x7E 全量                                |
    | 标点符号 | 中英标点、数字序号、货币、单位、箭头、制表符、数学符号 |

本模块不依赖任何字体文件，只产出纯文本字符集，可单独运行核对：

    python scaffold/tools/fonts/charset.py

产出：
    charset/gb2312.txt    —— 仅 GB2312 全集的 7445 个字符
    charset/content.txt   —— 子集化实际使用的并集（ASCII + GB2312 + 补充符号）

**这两个文件由本脚本生成，请勿手工编辑。** 需要调整字符集，改这个脚本。
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE / "charset"


def gb2312_chars() -> list[str]:
    """枚举 GB2312 全集的全部字符。

    GB2312 用两个字节表示：首字节 0xA1-0xF7，尾字节 0xA1-0xFE。
    逐码点尝试用 Python 的 `gb2312` 编解码器解码，成功的即有效字符。
    结果是 7445 个：682 个符号（1-9 区）+ 6763 个汉字（16-87 区）。
    """
    chars: list[str] = []
    for hi in range(0xA1, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.append(bytes((hi, lo)).decode("gb2312"))
            except UnicodeDecodeError:
                # 该码位在 GB2312 里是空的，跳过
                continue
    return chars


def ascii_chars() -> list[str]:
    """ASCII 可打印区 0x20-0x7E 全量。"""
    return [chr(c) for c in range(0x20, 0x7F)]


def extra_symbols() -> list[str]:
    """GB2312 覆盖不到的补充符号。

    GB2312 已经含中英标点、①②③、￥＄、←↑→↓、─│┌┐、±×÷、√、△○ 等；
    这里只补少量现代排版常用、但 GB2312 里没有的字符。
    """
    return list(
        "€‰µ№∞"
        "✓✗✔✘"
        "⌘⌥⇧⌫⏎"
        "①②③④⑤⑥⑦⑧⑨⑩"  # 兜底：确保数字序号一定在（GB2312 已含，重复无副作用）
    )


def content_charset() -> list[str]:
    """子集化实际使用的字符并集，保持稳定顺序并去重。"""
    seen: set[str] = set()
    out: list[str] = []
    for ch in ascii_chars() + gb2312_chars() + extra_symbols():
        if ch in seen:
            continue
        seen.add(ch)
        out.append(ch)
    return out


def write_charsets() -> dict[str, int]:
    """生成两个字符集文件，返回各文件字符数。"""
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    gb = gb2312_chars()
    content = content_charset()

    (OUT_DIR / "gb2312.txt").write_text("".join(gb), encoding="utf-8")
    (OUT_DIR / "content.txt").write_text("".join(content), encoding="utf-8")

    return {"gb2312": len(gb), "content": len(content)}


def main() -> int:
    stats = write_charsets()
    gb = stats["gb2312"]
    content = stats["content"]
    hanzi = sum(1 for c in gb2312_chars() if "\u4e00" <= c <= "\u9fff")
    print(f"字符集已生成到 {OUT_DIR}")
    print(f"  gb2312.txt    {gb} 字符（其中汉字 {hanzi}，符号 {gb - hanzi}）")
    print(f"  content.txt   {content} 字符（ASCII + GB2312 + 补充符号）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
