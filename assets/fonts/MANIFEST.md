# 内置字体库清单

本目录是 Reelix **内容层字体库**（文字层、字幕、三维文字用）的唯一权威来源。
对应规格：[docs/09-3D摄像机与素材库.md](../../../../docs/09-3D摄像机与素材库.md) 第三节。

> **注意区分界面层与内容层。** 界面文字一律走系统字体栈（`--rl-font-ui`），**不打包任何界面字体**。
> 这里放的字体只服务内容层，随包内置，计入 150MB 体积红线的 40MB 预算。

---

## 一、目录约定

```
assets/fonts/
├── MANIFEST.md            ← 本文件
├── <字体目录>/
│   ├── LICENSE.txt        ← 许可原文（必须逐字来自上游，不得改写）
│   ├── <子集字体>.ttf     ← 子集化产物（构建期生成，入库）
│   └── <子集字体>.woff2   ← 同上的界面预览副本
```

**源字体（未子集化的整包）不入库**，只入库子集产物。子集规格见 docs/09 第 3.5 节：
**GB2312 全集 6763 字 + ASCII + 常用符号**，中文每款 1–2 个字重。

---

## 二、内置清单与到位状态

| 目录 | 字体 | 上游仓库 | 许可 | RFN | 许可文件状态 | 子集产物 |
| --- | --- | --- | --- | --- | --- | --- |
| `LXGWWenKai/` | 霞鹜文楷 | `lxgw/LxgwWenKai` | SIL OFL 1.1 | **有** | ✅ 原文已就位 | ✅ 2 档（Regular/Medium） |
| `Inter/` | Inter | `rsms/inter` | SIL OFL 1.1 | 无 | ✅ 原文已就位 | ✅ 3 档（Light/Regular/Bold） |
| `JetBrainsMono/` | JetBrains Mono | `JetBrains/JetBrainsMono` | SIL OFL 1.1 | 无 | ✅ 原文已就位 | ✅ 3 档（Light/Regular/Bold） |
| `SmileySans/` | 得意黑 | `atelier-anchor/smiley-sans` | SIL OFL 1.1 | **有** | ✅ 原文已就位 | ⬜ 源只有源码，待构建 |
| `LXGWNeoXiHei/` | 霞鹜新晰黑 | `lxgw/LxgwNeoXiHei` | SIL OFL 1.1 | **有** | ⬜ 待补（上游原文） | ⬜ 源字体未就位 |
| `NotoSansSC/` | 思源黑体 | `notofonts/noto-cjk` | SIL OFL 1.1 | 无 | ⬜ 待补（上游原文） | ⬜ 源字体未就位 |
| `NotoSerifSC/` | 思源宋体 | `notofonts/noto-cjk` | SIL OFL 1.1 | 无 | ⬜ 待补（上游原文） | ⬜ 源字体未就位 |
| `ZhuqueFangsong/` | 朱雀仿宋 | `TrionesType/zhuque` | SIL OFL 1.1 | **有** | ⬜ 待补（上游原文） | ⬜ 源字体未就位 |
| `Montserrat/` | Montserrat | Google Fonts | SIL OFL 1.1 | 无 | ⬜ 待补（上游原文） | ⬜ 源字体未就位 |
| `Poppins/` | Poppins | Google Fonts | SIL OFL 1.1 | 无 | ⬜ 待补（上游原文） | ⬜ 源字体未就位 |

**「⬜ 待补」的文件里写的是占位说明，不是许可证正文。** 补法只有一种：从上游仓库**逐字复制**该字体的 OFL 原文覆盖它。
**发布前必须全部变成 ✅**——许可证原文随包附带是红线（docs/09 第七节）。

> **源字体就位情况（2026-10-07 实测）**：`reference/fonts/` 下只有 `inter`、`JetBrainsMono`、`LxgwWenKai`、`smiley-sans` 四个来源。
> 其中 Inter（可变字体 InterVariable.ttf）、JetBrains Mono（static ttf）、霞鹜文楷（`fonts/TTF/` 的 Light/Regular/Medium）**有可直接子集化的字体二进制**；
> 得意黑**只有源码**（`src/SmileySans.ttx` + glyphspackage，需 `fontmake` 构建）；
> 其余 6 款（霞鹜新晰黑、思源黑体、思源宋体、朱雀仿宋、Montserrat、Poppins）**来源目录都没有，需另行获取**。

---

## 三、RFN 改名规则（合规红线）

OFL 的 Reserved Font Name 条款规定：**修改版（子集化属于修改版）不得继续使用保留字名**。
所以内置子集统一用中性内部名，界面以「基于 XXX」标注来源：

| 原字体 | 内部字体名（子集后） | 界面标注 |
| --- | --- | --- |
| 霞鹜文楷 | `Reelix Serif SC` | 基于 霞鹜文楷（OFL） |
| 霞鹜新晰黑 | `Reelix Hei SC` | 基于 霞鹜新晰黑（OFL） |
| 得意黑 | `Reelix Display SC` | 基于 得意黑（OFL） |
| 朱雀仿宋 | `Reelix Fangsong SC` | 基于 朱雀仿宋（OFL） |
| 思源黑体 / 思源宋体 / Inter / JetBrains Mono / Montserrat / Poppins | 可保留原名 | 原名（OFL） |

**例外依据**：霞鹜文楷的 OFL 附加条款只对「**仅供网页字体交付**的子集」放宽命名，Reelix 是离桌面分发，**不适用**该放宽，
因此同样必须改名。

---

## 四、打包

字体产物就绪后，必须在 `scaffold/src-tauri/tauri.conf.json` 的 `bundle.resources` 里声明本目录，
否则不会进安装包。声明方式与 `ffmpeg/` 一致（对象映射形式，可自定义目标路径）。

**已声明（2026-10-07）**：`bundle.resources` 中已加入 `"assets/fonts/**/*": "assets/fonts/"`，
预设目录同批加入 `"assets/presets/**/*": "assets/presets/"`。

---

## 五、构建工具链与实测体积

子集化脚本：`scaffold/tools/fonts/subset_fonts.py`（配合 `charset.py` 生成字符集、`fonts.config.json` 定义清单）。
参数遵循 docs/09 第 3.5 节；单次运行产出 `.ttf` 与 `.woff2` 两份，并写 `scaffold/tools/fonts/subset-report.json`。

**本次全量实测（字符集 7551 字符 = GB2312 汉字 6763 + ASCII + 常用符号）：**

| 目录 | 档数 | TTF 每档 | woff2 每档 |
| --- | --- | --- | --- |
| `Inter/` | 3（Light/Regular/Bold） | ≈ 96.5–96.8 KB | ≈ 33 KB |
| `JetBrainsMono/` | 3（Light/Regular/Bold） | ≈ 114–117 KB | ≈ 41 KB |
| `LXGWWenKai/` | 2（Regular/Medium） | ≈ 3.5 MB | ≈ 1.6 MB |

**全量合计：8 个子集，TTF 7.63 MB，woff2 3.38 MB。** 中文每档 ≈ 3.5 MB，据此 6 款中文（各 1–2 档）约 **21–42 MB**，
落在 docs/09 第一节的 **40MB 字体预算**内——这印证了「中文限 1–2 字重是塞进 40MB 的前提」。

**RFN 回读校验**：霞鹜文楷两档内部字体名已成功改为 `Reelix Serif SC`（读回验证 ✓）；Inter / JetBrains Mono 无 RFN，保留原名。

---

## 六、当前进度

- [x] 目录结构与清单就位（M1）
- [x] 4 款已下载字体的许可原文入库（霞鹜文楷 / 得意黑 / Inter / JetBrains Mono）
- [ ] 其余 6 款许可原文补入
- [x] 子集化脚本（`fonttools pyftsubset`，参数见 docs/09 第 3.5 节）——`subset_fonts.py` 已跑通全量
- [x] 可构建的 3 款子集产物入库 + 体积核算（Inter / JetBrains Mono / 霞鹜文楷，共 8 档，见第五节）
- [ ] 得意黑：拿到 release 版 TTF 或本地 `fontmake` 构建后补子集
- [ ] 其余 6 款：取得源字体后补子集（霞鹜新晰黑 / 思源黑体 / 思源宋体 / 朱雀仿宋 / Montserrat / Poppins）
