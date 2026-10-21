# 内置预设库（骨架）

本目录是第一方**预设动效库**的唯一权威来源，随包内置，计入 150MB 红线的 2MB 预算。
规格见 [docs/09-3D摄像机与素材库.md](../../../../docs/09-3D摄像机与素材库.md) 第四节。

> 与字体库同理：这里放的是**内置**预设。用户自己保存的预设存在「上传素材/预设/」下（用户数据，不进安装包）。

---

## 一、计划中的目录结构

```
assets/presets/
├── README.md          ← 本文件
├── easing/            ← 缓动预设 30 个（JSON：cubic-bezier 控制点）
├── transition/        ← 转场预设 12 个（JSON + WGSL 参数引用）
├── text-motion/       ← 文字动效预设 8 个（JSON：关键帧模板）
└── lut/               ← LUT 色彩预设 20 组（.cube，只用 CC0 / MIT 或自研）
```

**全部是数据，不是代码。** 一个预设 = 一段关键帧 JSON + 参数范围；套用时注入目标属性的曲线上，
用户能直接看到预设「拆开」后的关键帧并修改。

---

## 二、当前状态

| 类别 | 目标数量 | 已完成 | 说明 |
| --- | --- | --- | --- |
| 缓动预设 | 30 | **30** | 已生成，JSON 结构见第三节 |
| 转场预设 | 12 | 0 | 需先定「JSON 参数 ↔ WGSL uniform」的映射约定 |
| 文字动效 | 8 | 0 | 依赖文字层的参数集（打字机 / 逐字浮现需逐字位移能力） |
| LUT | 20 | 0 | 只用 CC0 / MIT 或自研，商用 LUT 包一律不收 |

**下一步（M2）**：转场与文字动效等对应图层能力落地后再补；
把 `easing/index.json` 接进界面（预设面板 + 套用到关键帧）。

**禁止**：抄 Adobe 的预设文件（`.ffx` 等）、抄商业 LUT 包。预设数值必须我们自己算或来自 CC0 / MIT 来源。

---

## 三、缓动预设的 JSON 结构（已定）

缓动预设是**纯数据**，坐标系与前端一条不差：控制点就是 CSS 的
cubic-bezier，与 `scaffold/src/core/curveEval.ts` 里 `EASING_TANGENTS` 的元组同构。

单个预设 `easing/<id>.json`：

```json
{
  "schema": "reelix.easing/v1",
  "id": "ease-out-sine",
  "name": "正弦缓出",
  "nameEn": "ease-out-sine",
  "category": "sine",
  "categoryLabel": "正弦",
  "bezier": [0.61, 1, 0.88, 1],
  "builtin": false,
  "note": "正弦族缓出"
}
```

| 字段 | 含义 |
| --- | --- |
| `id` | 唯一标识；**具名内置**的 id 与 `types/keyframe.ts` 的 `EasingPreset` 逐字一致 |
| `name` / `nameEn` | 中文名 / 英文名（界面显示中文名） |
| `category` / `categoryLabel` | 分类 id 与中文标（基础 / 正弦 / 二次 / 三次 / 四次 / 五次 / 指数 / 圆弧 / 回撤 / 回弹） |
| `bezier` | `[x1, y1, x2, y2]`，CSS cubic-bezier 控制点 |
| `builtin` | 是否落进关键帧既有的 `easing` 字段（true）/ 需写入切线（false） |

目录清单 `easing/index.json`（`reelix.easing-index/v1`）汇总全部 30 条，
字段 `builtinIds` 列出 6 个具名内置：`linear / ease-in / ease-out / ease-in-out / bounce / elastic`。

**两种用法的区别：**

- `builtin: true`（6 个）→ 直接把 `id` 写进关键帧的 `easing` 字段，引擎查 `EASING_TANGENTS` 求值。
- `builtin: false`（24 个）→ 套用时把 `bezier` 写进关键帧的 `inTangent` / `outTangent`。

**维护方式**：改 `scaffold/tools/presets/build_easing.py` 里的表，再跑
`python scaffold/tools/presets/build_easing.py` 重新生成，**不要手改本目录下的 JSON**。
6 个具名预设的 `bezier` 与 `curveEval.ts` 必须同步，改一处要改两处。
