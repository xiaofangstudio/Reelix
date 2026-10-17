# -*- coding: utf-8 -*-
"""
内容层字体**子集化管线**。

把整包源字体裁成「GB2312 全集 + ASCII + 常用符号」（见 charset.py），
按 docs/09-3D摄像机与素材库.md 第 3.5 / 3.6 节产出可入库的子集产物：

    scaffold/src-tauri/assets/fonts/<字体目录>/<名字>.ttf
    scaffold/src-tauri/assets/fonts/<字体目录>/<名字>.woff2   （界面内预览用副本）

规矩（照文档，不要改）：
  * 子集化是**构建期**动作，产物入库、**源字体不入库**（docs/09 第 3.5 节）。
  * 参数固定：--layout-features='*' --glyph-names --symbol-cmap --legacy-cmap。
  * 含 **Reserved Font Name** 的字体，子集后**必须改内部字体名**（docs/09 第 3.6 节），
    改名映射写在 fonts.config.json 的 family 字段里。

用法：
    python scaffold/tools/fonts/subset_fonts.py              # 全部字体
    python scaffold/tools/fonts/subset_fonts.py --only Inter # 只做某一款
    python scaffold/tools/fonts/subset_fonts.py --dry-run    # 只报缺哪些源字体，不产出
    python scaffold/tools/fonts/subset_fonts.py --no-woff2   # 不产 woff2 副本

依赖：fonttools（已在用）、brotli（产 woff2 需要）。若缺 brotli：
    python -m pip install brotli
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# 仓库根：.../scaffold/tools/fonts/subset_fonts.py -> parents[3] 即 Reelix
REPO_ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "fonts.config.json"

WOFF2_MIN_BYTES = 1  # 占位：便于以后加阈值校验


def human(n: int) -> str:
    """人类可读体积。"""
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / (1024 * 1024):.2f} MB"


def load_config() -> dict:
    with CONFIG_PATH.open(encoding="utf-8") as fh:
        return json.load(fh)


def read_charset(config: dict, auto_build: bool = True) -> str:
    """读取字符集文件；缺失时用 charset.py 现生成。"""
    path = REPO_ROOT / config["charsetFile"]
    if not path.exists():
        if not auto_build:
            raise SystemExit(f"字符集文件不存在：{path}")
        import charset as _charset  # 同目录

        _charset.write_charsets()
    return path.read_text(encoding="utf-8")


def build_subset_options(config: dict):
    """把配置里的 subsetOptions 映射成 fontTools 的 Subsetter Options。"""
    from fontTools.subset import Options

    cfg = config.get("subsetOptions", {})
    opts = Options()
    opts.layout_features = cfg.get("layoutFeatures", ["*"])
    opts.glyph_names = bool(cfg.get("glyphNames", True))
    opts.symbol_cmap = bool(cfg.get("symbolCmap", True))
    opts.legacy_cmap = bool(cfg.get("legacyCmap", True))
    opts.notdef_outline = bool(cfg.get("notdefOutline", True))
    opts.recalc_bounds = bool(cfg.get("recalcBounds", True))
    opts.recalc_timestamp = bool(cfg.get("recalcTimestamp", False))
    # 保留字体的元信息，改名才有东西可改
    opts.name_IDs = ["*"]
    opts.name_legacy = True
    opts.name_languages = ["*"]
    return opts


def rename_reserved_family(font, family: str, ps_family: str) -> None:
    """按 OFL 的 RFN 条款改内部字体名。

    修改版（子集）不得继续使用保留字名，所以把 family / full / postscript
    等记录统一换成中性名。subfamily（字重）保留原样。
    """
    name_table = font["name"]
    for rec in name_table.names:
        try:
            current = rec.toUnicode()
        except (UnicodeDecodeError, ValueError):
            continue
        if rec.nameID == 1:  # family
            rec.string = family
        elif rec.nameID == 16:  # typographic family
            rec.string = family
        elif rec.nameID == 4:  # full name：换 family，保留字重后缀
            tail = current[len(current.split(" ")[0]):].strip() if current else ""
            rec.string = f"{family} {tail}".strip() if tail else family
        elif rec.nameID == 6:  # postscript name
            rec.string = ps_family
        elif rec.nameID == 3:  # unique id
            rec.string = f"{family}-subset"


def verify_output(path: Path, expect_family: str) -> bool:
    """重新读回产物，确认内部字体名已生效。

    同时看 family（1）与 typographic family（16）；对「JetBrains Mono Light」
    这类样式连写名，用前缀匹配兜住。
    """
    from fontTools.ttLib import TTFont

    font = TTFont(str(path))
    got = set()
    for rec in font["name"].names:
        if rec.nameID in (1, 16):
            try:
                got.add(rec.toUnicode())
            except (UnicodeDecodeError, ValueError):
                pass
    font.close()
    return any(v == expect_family or v.startswith(expect_family + " ") for v in got)


def subset_one(source: Path, output_base: str, charset: str, opts, family: str,
               rfn: bool, instance_axes: dict | None, out_dir: Path,
               make_woff2: bool) -> dict:
    """处理一款字重的字体：实例化 → 子集 → 改名 → 落盘。"""
    from fontTools.ttLib import TTFont

    font = TTFont(str(source))

    if instance_axes:
        from fontTools.varLib import instancer

        # 关键：必须把所有轴都钉死。只钉 wght 而留下别的轴（如 opsz），
        # 字体仍是可变字体、会残留 gvar 表，子集时撞 KeyError '.notdef'。
        axes: dict = {}
        if "fvar" in font:
            for axis in font["fvar"].axes:
                axes[axis.axisTag] = axis.defaultValue
        axes.update(instance_axes)
        instancer.instantiateVariableFont(font, axes, inplace=True)

    from fontTools.subset import Subsetter

    subsetter = Subsetter(options=opts)
    subsetter.populate(text=charset)
    subsetter.subset(font)

    if rfn:
        ps_family = "".join(ch for ch in family if ch.isalnum())
        rename_reserved_family(font, family, ps_family)

    font.recalcTimestamp = False
    out_dir.mkdir(parents=True, exist_ok=True)

    ttf_path = out_dir / f"{output_base}.ttf"
    font.flavor = None
    font.save(str(ttf_path))
    ttf_size = ttf_path.stat().st_size

    woff2_size = 0
    woff2_path = out_dir / f"{output_base}.woff2"
    if make_woff2:
        font.flavor = "woff2"
        font.save(str(woff2_path))
        woff2_size = woff2_path.stat().st_size

    font.close()

    return {
        "output": output_base,
        "ttf": ttf_size,
        "woff2": woff2_size,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Reelix 内容层字体子集化")
    parser.add_argument("--only", help="只处理配置里某个 dir")
    parser.add_argument("--dry-run", action="store_true", help="只检查源字体是否就位")
    parser.add_argument("--no-woff2", action="store_true", help="不产出 woff2 副本")
    args = parser.parse_args()

    config = load_config()
    out_root = REPO_ROOT / config["outputRoot"]

    fonts = config["fonts"]
    if args.only:
        fonts = [f for f in fonts if f["dir"].lower() == args.only.lower()]
        if not fonts:
            print(f"配置里没有 dir={args.only}", file=sys.stderr)
            return 2

    if args.dry_run:
        print("源字体就位检查：")
        for entry in fonts:
            for w in entry["weights"]:
                src = REPO_ROOT / w["source"]
                mark = "就位" if src.exists() else "缺失"
                print(f"  [{mark}] {entry['dir']:<16} {w['output']:<26} <- {w['source']}")
        return 0

    charset = read_charset(config)
    opts = build_subset_options(config)

    rows: list[dict] = []
    missing: list[str] = []
    total_ttf = 0
    total_woff2 = 0

    for entry in fonts:
        out_dir = out_root / entry["dir"]
        for w in entry["weights"]:
            src = REPO_ROOT / w["source"]
            if not src.exists():
                missing.append(f"{entry['dir']} / {w['output']} <- {w['source']}")
                continue
            res = subset_one(
                source=src,
                output_base=w["output"],
                charset=charset,
                opts=opts,
                family=entry["family"],
                rfn=bool(entry.get("rfn")),
                instance_axes=w.get("instance"),
                out_dir=out_dir,
                make_woff2=not args.no_woff2,
            )
            ok = verify_output(out_dir / f"{w['output']}.ttf", entry["family"])
            res["dir"] = entry["dir"]
            res["family"] = entry["family"]
            res["rfn"] = bool(entry.get("rfn"))
            res["name_ok"] = ok
            rows.append(res)
            total_ttf += res["ttf"]
            total_woff2 += res["woff2"]
            print(f"  完成 {entry['dir']:<16} {w['output']:<26} "
                  f"ttf {human(res['ttf'])}  woff2 {human(res['woff2'])}  "
                  f"内部名{'已改名' if res['rfn'] else '保留'}{'✓' if ok else '✗'}")

    print()
    print(f"产出字体 {len(rows)} 个子集，ttf 合计 {human(total_ttf)}，"
          f"woff2 合计 {human(total_woff2)}")
    if missing:
        print(f"\n以下源字体未就位（跳过 {len(missing)} 项）：")
        for m in missing:
            print(f"  - {m}")
        print("  获取方式见 scaffold/tools/fonts/README.md 与各字体目录的 LICENSE.txt。")

    # 机器可读报告，便于回填 MANIFEST
    report = {
        "charsetChars": len(charset),
        "totalTtfBytes": total_ttf,
        "totalWoff2Bytes": total_woff2,
        "entries": rows,
        "missing": missing,
    }
    report_path = HERE / "subset-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n报告写入 {report_path.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
