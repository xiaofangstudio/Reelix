# -*- coding: utf-8 -*-
"""
缓动预设**构建期生成器**。

把 30 个缓动预设从一张表生成成可入库的 JSON 数据：

    scaffold/src-tauri/assets/presets/easing/<id>.json   （单个预设）
    scaffold/src-tauri/assets/presets/easing/index.json  （目录清单）

坐标系与前端完全一致：`bezier = [x1, y1, x2, y2]`，就是 CSS 的
cubic-bezier 控制点，与 `scaffold/src/core/curveEval.ts` 里
`EASING_TANGENTS` 的元组同构（见 docs/09 第四节）。

规矩：
  * 预设是**数据不是代码**；数值必须我们自己算或来自公开标准（easing.net / Material），
    禁止抄 Adobe 的 .ffx 或任何商业预设包。
  * 前 6 个是**具名内置**，`id` 与 `types/keyframe.ts` 的 `EasingPreset` 联合类型逐字对应，
    这样它们能直接落在关键帧的 `easing` 字段上。
  * 其余 24 个是**曲线预设**：套用时把 `bezier` 写进关键帧的 inTangent / outTangent。

用法：
    python scaffold/tools/presets/build_easing.py
"""

from __future__ import annotations

import json
from pathlib import Path

# 仓库根：.../scaffold/tools/presets/build_easing.py -> parents[3] 即 Reelix
REPO_ROOT = Path(__file__).resolve().parents[3]
OUT_DIR = REPO_ROOT / "scaffold/src-tauri/assets/presets/easing"

SCHEMA_PRESET = "reelix.easing/v1"
SCHEMA_INDEX = "reelix.easing-index/v1"

# 表结构：(id, 中文名, 英文名, 分类, bezier[x1,y1,x2,y2], 是否具名内置, 说明)
# 前 6 条 = EasingPreset 联合类型，bezier 值必须与 curveEval.ts 的 EASING_TANGENTS 一致。
EASINGS: list[tuple[str, str, str, str, list[float], bool, str]] = [
    # --- 具名内置：与 EasingPreset 逐字对应，改这里必须同步改 curveEval.ts ---
    ("linear", "线性", "linear", "basic", [0, 0, 1, 1], True, "匀速，无缓动"),
    ("ease-in", "缓入", "ease-in", "basic", [0.42, 0, 1, 1], True, "起步慢、结尾快"),
    ("ease-out", "缓出", "ease-out", "basic", [0, 0, 0.58, 1], True, "起步快、结尾慢"),
    ("ease-in-out", "缓入缓出", "ease-in-out", "basic", [0.42, 0, 0.58, 1], True, "两头慢、中间快"),
    ("bounce", "回弹", "bounce", "overshoot", [0.34, 1.56, 0.64, 1], True, "过冲后回落，轻快弹入"),
    ("elastic", "弹性", "elastic", "overshoot", [0.22, 1.4, 0.36, 1], True, "强过冲，弹性入位"),
    # --- 以下为曲线预设：套用时写入关键帧切线 ---
    ("ease-in-sine", "正弦缓入", "ease-in-sine", "sine", [0.12, 0, 0.39, 0], False, "正弦族缓入，柔和"),
    ("ease-out-sine", "正弦缓出", "ease-out-sine", "sine", [0.61, 1, 0.88, 1], False, "正弦族缓出"),
    ("ease-in-out-sine", "正弦缓入缓出", "ease-in-out-sine", "sine", [0.37, 0, 0.63, 1], False, "正弦族对称缓动"),
    ("ease-in-quad", "二次缓入", "ease-in-quad", "quad", [0.11, 0, 0.5, 0], False, "平方加速"),
    ("ease-out-quad", "二次缓出", "ease-out-quad", "quad", [0.5, 1, 0.89, 1], False, "平方减速"),
    ("ease-in-out-quad", "二次缓入缓出", "ease-in-out-quad", "quad", [0.45, 0, 0.55, 1], False, "平方对称缓动"),
    ("ease-in-cubic", "三次缓入", "ease-in-cubic", "cubic", [0.32, 0, 0.67, 0], False, "立方加速，比二次更陡"),
    ("ease-out-cubic", "三次缓出", "ease-out-cubic", "cubic", [0.33, 1, 0.68, 1], False, "立方减速"),
    ("ease-in-out-cubic", "三次缓入缓出", "ease-in-out-cubic", "cubic", [0.65, 0, 0.35, 1], False, "立方对称缓动"),
    ("ease-in-quart", "四次缓入", "ease-in-quart", "quart", [0.5, 0, 0.75, 0], False, "四次方加速"),
    ("ease-out-quart", "四次缓出", "ease-out-quart", "quart", [0.25, 1, 0.5, 1], False, "四次方减速"),
    ("ease-in-out-quart", "四次缓入缓出", "ease-in-out-quart", "quart", [0.76, 0, 0.24, 1], False, "四次方对称缓动"),
    ("ease-in-quint", "五次缓入", "ease-in-quint", "quint", [0.64, 0, 0.78, 0], False, "五次方加速，重"),
    ("ease-out-quint", "五次缓出", "ease-out-quint", "quint", [0.22, 1, 0.36, 1], False, "五次方减速"),
    ("ease-in-out-quint", "五次缓入缓出", "ease-in-out-quint", "quint", [0.83, 0, 0.17, 1], False, "五次方对称缓动"),
    ("ease-in-expo", "指数缓入", "ease-in-expo", "expo", [0.7, 0, 0.84, 0], False, "指数加速，极陡"),
    ("ease-out-expo", "指数缓出", "ease-out-expo", "expo", [0.16, 1, 0.3, 1], False, "指数减速，冲入后骤停"),
    ("ease-in-out-expo", "指数缓入缓出", "ease-in-out-expo", "expo", [0.87, 0, 0.13, 1], False, "指数对称缓动"),
    ("ease-in-circ", "圆弧缓入", "ease-in-circ", "circ", [0.55, 0, 1, 0.45], False, "圆函数缓入"),
    ("ease-out-circ", "圆弧缓出", "ease-out-circ", "circ", [0, 0.55, 0.45, 1], False, "圆函数缓出"),
    ("ease-in-out-circ", "圆弧缓入缓出", "ease-in-out-circ", "circ", [0.85, 0, 0.15, 1], False, "圆函数对称缓动"),
    ("ease-in-back", "回撤缓入", "ease-in-back", "back", [0.36, 0, 0.66, -0.56], False, "起步先反向蓄力"),
    ("ease-in-out-back", "回撤缓入缓出", "ease-in-out-back", "back", [0.68, -0.6, 0.32, 1.6], False, "两头反向蓄力的对称曲线"),
    ("smooth", "平滑", "smooth", "basic", [0.4, 0, 0.2, 1], False, "Material 标准缓动，通用"),
]

# 分类中文名，供界面分组用
CATEGORY_LABELS = {
    "basic": "基础",
    "sine": "正弦",
    "quad": "二次",
    "cubic": "三次",
    "quart": "四次",
    "quint": "五次",
    "expo": "指数",
    "circ": "圆弧",
    "back": "回撤",
    "overshoot": "回弹",
}


def preset_obj(row: tuple) -> dict:
    pid, name, name_en, category, bezier, builtin, note = row
    return {
        "schema": SCHEMA_PRESET,
        "id": pid,
        "name": name,
        "nameEn": name_en,
        "category": category,
        "categoryLabel": CATEGORY_LABELS[category],
        "bezier": bezier,
        "builtin": builtin,
        "note": note,
    }


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # 先清掉旧的 .json，避免删表后残留孤儿文件
    for old in OUT_DIR.glob("*.json"):
        old.unlink()

    rows = [preset_obj(r) for r in EASINGS]
    for obj in rows:
        path = OUT_DIR / f"{obj['id']}.json"
        path.write_text(
            json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    index = {
        "schema": SCHEMA_INDEX,
        "version": 1,
        "generatedBy": "scaffold/tools/presets/build_easing.py",
        "coordinateSystem": (
            "bezier = [x1, y1, x2, y2]，CSS cubic-bezier 控制点；"
            "与 scaffold/src/core/curveEval.ts 的 EASING_TANGENTS 同构"
        ),
        "builtinIds": [r[0] for r in EASINGS if r[5]],
        "count": len(rows),
        "items": [
            {
                "id": o["id"],
                "name": o["name"],
                "nameEn": o["nameEn"],
                "category": o["category"],
                "categoryLabel": o["categoryLabel"],
                "bezier": o["bezier"],
                "builtin": o["builtin"],
            }
            for o in rows
        ],
    }
    (OUT_DIR / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    builtin = index["builtinIds"]
    print(f"缓动预设已生成到 {OUT_DIR.relative_to(REPO_ROOT)}")
    print(f"  单个预设 {len(rows)} 个 + index.json")
    print(f"  具名内置 {len(builtin)} 个：{', '.join(builtin)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
