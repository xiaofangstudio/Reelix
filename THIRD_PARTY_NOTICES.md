# 第三方声明 · Reelix

本文件列出 Reelix 使用、链接或随包分发的第三方组件及其许可，并说明各自的处置方式。

Reelix 本体以 **MIT** 交付，版权归小方工作室。许可白名单规则见 [docs/06-参考项目与许可边界.md](docs/06-参考项目与许可边界.md) 第四节：**GPL / AGPL 一律不进仓库**。

---

## 一、当前已随包分发 / 链接的组件

| 组件 | 许可 | 用途 | 处置 |
| --- | --- | --- | --- |
| Tauri v2 | MIT / Apache-2.0 | 桌面外壳与 IPC | 动态链接 Rust crate |
| tauri-plugin-dialog | MIT / Apache-2.0 | 系统文件选择 / 保存对话框 | Rust crate |
| React 18 | MIT | 界面渲染 | 编译进前端产物 |
| React DOM | MIT | 界面渲染 | 编译进前端产物 |
| Zustand | MIT | 前端状态管理 | 编译进前端产物 |
| serde / serde_json | MIT / Apache-2.0 | 项目文件序列化 | Rust crate |
| Vite 5 | MIT | 前端构建工具（**仅构建期，不进包**） | devDependency |
| TypeScript | Apache-2.0 | 类型检查（**仅构建期，不进包**） | devDependency |

以上组件均属白名单内许可，保留各自版权声明即可。

---

## 二、计划随包分发、当前尚未就绪的组件

以下组件按设计需要随包提供，但**本仓库当前尚未放入对应文件**，因此尚未被链接或分发。就绪后须重新核对本节内容。

| 组件 | 许可 | 用途与处置 |
| --- | --- | --- |
| **FFmpeg** | **LGPL-2.1** | 解码 / 编码。**只能动态链接**，绝不做静态链接。将放在 `src-tauri/ffmpeg/` 以独立动态库形式随包分发 |

### FFmpeg 的 LGPL 合规声明

FFmpeg 以 **LGPL-2.1** 授权。Reelix 的处理方式：

1. **仅动态链接**。Reelix 不静态链接 FFmpeg，用户可以用自己编译的 FFmpeg 动态库替换随包的版本。
2. **保留许可证文本**。FFmpeg 的 `COPYING.LGPLv2.1` 与其依赖的许可证文本随包提供。
3. **提供源码获取途径**。对应的 FFmpeg 源码（含小方工作室使用的准确版本号与全部编译期配置）可从 FFmpeg 官方站点获取：<https://ffmpeg.org/download.html>。若做过任何修改，修改后的源码同样公开提供。
4. FFmpeg 的许可证文本将与本文件同目录分发。

### 内置字体（SIL OFL 1.1）

Reelix 的**内容层**内置字体（文字层 / 字幕 / 三维文字）全部采用 **SIL Open Font License 1.1**。
逐款许可原文放在 `scaffold/src-tauri/assets/fonts/<字体名>/LICENSE.txt`，清单与状态见该目录下的 `MANIFEST.md`。

| 字体 | 上游仓库 | 许可 | 当前状态 |
| --- | --- | --- | --- |
| 霞鹜文楷 LXGW WenKai | `lxgw/LxgwWenKai` | SIL OFL 1.1（**含 Reserved Font Name**） | 许可原文已就位 |
| 得意黑 Smiley Sans | `atelier-anchor/smiley-sans` | SIL OFL 1.1（**含 Reserved Font Name**） | 许可原文已就位 |
| Inter | `rsms/inter` | SIL OFL 1.1 | 许可原文已就位 |
| JetBrains Mono | `JetBrains/JetBrainsMono` | SIL OFL 1.1 | 许可原文已就位 |
| 霞鹜新晰黑 | `lxgw/LxgwNeoXiHei` | SIL OFL 1.1（**含 Reserved Font Name**） | **待补许可原文** |
| 思源黑体 / 思源宋体 | `notofonts/noto-cjk` | SIL OFL 1.1 | **待补许可原文** |
| 朱雀仿宋 | `TrionesType/zhuque` | SIL OFL 1.1（**含 Reserved Font Name**） | **待补许可原文** |
| Montserrat / Poppins | Google Fonts | SIL OFL 1.1 | **待补许可原文** |

处置要点：

1. **逐款随包附带许可原文**，一个字体一份，不得省略或节选。
2. **子集化属于修改版**。含 Reserved Font Name 的字体（霞鹜文楷、霞鹜新晰黑、得意黑、朱雀仿宋）**必须改内部字体名**，界面以「基于 XXX（OFL）」标注来源与许可。
3. **界面字体不打包**，界面文字走系统字体栈；本节只涉及内容层字体。

---

## 三、以独立进程调用的组件（sidecar）

| 组件 | 许可 | 用途与处置 |
| --- | --- | --- |
| **COLMAP** | **BSD** | 空间识别 / 相机解算。**作为独立进程调用，源码不并入本仓库**，崩溃不传染主程序。不作为主包必装项，走可选组件 |

COLMAP 以 BSD 授权，可随包分发二进制。Reelix 只通过命令行调用其可执行文件，不链接其代码。

---

## 四、参考项目（代码不并入）

| 项目 | 许可 | 与 Reelix 的关系 |
| --- | --- | --- |
| **Clypra** | MIT | 剪辑侧与求值引擎的参考实现。**其代码若被改造并入，须在此逐文件登记来源与修改内容**（见第五节）。当前尚未移植任何文件 |
| **Gaffer** | BSD-3-Clause | 只借鉴概念与结构（延迟求值、节点与插槽、旁路、复合片段），**C++ / Python 代码不并入** |

---

## 五、移植登记

每次从参考项目移植一块代码，按 [docs/06](docs/06-参考项目与许可边界.md) 第五节的流程登记：来源、许可证、修改了什么。

| 日期 | 来源 | 文件 / 模块 | 许可证 | 修改内容 |
| --- | --- | --- | --- | --- |
| — | — | （当前尚无移植记录） | — | — |

---

## 六、明确不使用的组件

| 项目 | 许可 | 原因 |
| --- | --- | --- |
| Natron | GPL-2.0 | 传染性，只能读思路 |
| Shotcut | GPL-3.0 | 传染性 |
| Olive | GPL-3.0 | 传染性 |
| Blender 核心 | GPL | 传染性（核心部分） |
| Kdenlive | GPL-2.0+ | 传染性 |
| MLT | LGPL-2.1 | 仅作备选时间线内核，**若引入只能动态链接** |
| OpenTimelineIO | Apache-2.0 | 仅作备选 XML 交换方案，当前不引入 |
| OpenColorIO | BSD-3-Clause | 仅作完整色彩管理备选，当前不引入 |

---

*小方工作室 · Reelix · 第三方声明*
