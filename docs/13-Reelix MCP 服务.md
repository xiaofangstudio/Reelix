# Reelix MCP 服务

Reelix 带一个自己的 **MCP（Model Context Protocol）服务**：`reelix-mcp`。它让外面的 MCP 客户端（编辑器、Agent、命令行工具）能够**读和改一份 Reelix 工程**——建项目、铺片段、往效果栈里加效果、连线、打关键帧、求某一帧的取值。

一句话定位：**它是 Reelix 纯逻辑的一个命令行外壳，不是 Reelix 本体的一部分，也不随 MSI 打包。**

---

## 一、边界（先看这个）

`reelix-mcp` 是**独立进程**，与 Reelix 主程序没有运行时关系。它复用 `reelix` 库里的**纯逻辑模块**（工程读写 / 时间线模型 / 效果图 / 关键帧曲线 / 素材探测），但**不含任何 tauri 依赖**，也不会拉起窗口。

| 它做 | 它绝不做 |
| --- | --- |
| 从标准输入读 JSON-RPC、往标准输出写 JSON-RPC | 不开监听端口，不联网 |
| 读写**调用方明确给出的路径**上的 `.reelix` 工程 | 不自动落盘、不扫描磁盘、不读用户没给的文件 |
| 复用 `default-features = false` 的那批纯逻辑 | 不接大模型，不做任何 AI 功能 |
| 每次启动是一份空会话 | 不与正在运行的 Reelix 主程序通信 |
| MIT 许可，源码在仓库里 | 不进 MSI、不改自动更新、不建账号 |

**关键前提：关键帧不落盘。** `KeyframeStore` 只存在于内存与撤销快照里，`.reelix` 工程文件里**没有关键帧字段**。所以 MCP 会话里的关键帧，只对**这个进程内的这份工程副本**生效；`save_project` 存出来的工程，在 Reelix 里打开时看不到这些曲线。要持久化关键帧，得等主程序那条线做完。

---

## 二、传输与协议

**传输**：stdio。**一行一个 JSON-RPC 2.0 消息**，读到 EOF 就退出。

**协议版本**：`2024-11-05`（`initialize` 会按客户端请求的版本协商，客户端没给就用这个）。

**实现方式**：协议**手写**。除 `serde` / `serde_json` 外**不引任何 MCP 第三方 crate**——协议只有四个方法，手写比引依赖更可控，也符合仓库的依赖纪律。

支持的方法：

| 方法 | 作用 |
| --- | --- |
| `initialize` | 握手，返回 `capabilities.tools` 与 `serverInfo` |
| `ping` | 探活，回空对象 |
| `tools/list` | 返回全部工具的 `name` / `description` / `inputSchema` |
| `tools/call` | 调用一个工具，返回 `content` 数组 |

**通知（没有 `id` 的消息）不回话**——例如 `notifications/initialized`，服务只处理、不回复。

**两层错误，别混：**

- **协议层出错** → 回 JSON-RPC 错误。解析失败 `-32700`，方法不存在 `-32601`，`tools/call` 没给工具名 `-32602`。
- **工具本身失败** → 回**成功响应**，但 `content` 里带 `isError: true`，原因是一句中文。这样客户端仍能读到「为什么失败」，而不是只看到一个错误码。

顺带一处健壮性处理：有些 Windows 管道会在头一行前面塞一个 BOM，服务会先 `trim` 掉再解析。

---

## 三、会话模型

一个会话里同时活着三样东西，缺一不可：

```
Session {
    project   : Option<Project>   // 工程副本（序列 / 轨道 / 片段 / 素材 / 图）
    keyframes : KeyframeStore     // 关键帧曲线
    engine    : GraphEngine       // 图求值 + 指纹缓存
}
```

原因是**关键帧与图求值之间有一道烘入**：`evaluate_frame` 会先调 `KeyframeStore::bake_graph(graph, time_ms)`，把每条曲线在该时刻的取值写回图上节点的 `params`，**然后**才算拓扑序、才走指纹缓存。顺序反了，关键帧就落不到画面上。三者拆开放在不同地方，这条链就断了。

工具**默认操作主序列的根图**；需要指定别的图时，传可选参数 `graphId`。

---

## 四、工具清单

16 个工具，分四组。

### 读

| 工具 | 入参 | 说明 |
| --- | --- | --- |
| `get_project` | — | 读当前工程的完整快照：项目 / 序列 / 轨道 / 片段 / 素材 / 图，外加全部关键帧曲线 |
| `list_assets` | — | 列出工程里的素材（磁盘源文件的登记表） |
| `get_timeline` | — | 列出全部序列，含轨道与轨道上的片段 |
| `get_graph` | `graphId?` | 读一张合成图：节点、参数、连线 |
| `list_node_types` | — | 列出内置节点类型（效果清单）：类型键、中文名、分类、插槽、默认参数 |

### 建图与调参

| 工具 | 入参 | 说明 |
| --- | --- | --- |
| `add_node` | `nodeType`、`x?`、`y?`、`graphId?` | 往图里加一个节点，返回它的 id。类型键见 `list_node_types` |
| `connect` | `fromNode`、`fromPlug`、`toNode`、`toPlug`、`graphId?` | 把源节点的输出插槽接到目标节点的输入插槽。**同一输入只保留一条入线** |
| `set_node_param` | `nodeId`、`param`、`value`、`graphId?` | 改节点的一个参数，值可以是数字 / 布尔 / 字符串 |

### 关键帧与求值

| 工具 | 入参 | 说明 |
| --- | --- | --- |
| `set_keyframe` | `targetId`、`param`、`timeMs`、`value`、`easing?` | 在某目标（节点 id 或片段 id）的某参数上打关键帧；同刻已存在则覆盖 |
| `evaluate_param` | `targetId`、`param`、`timeMs` | 求某参数在某时刻的值。有关键帧走曲线求值，没有则回落到节点上的静态参数 |
| `evaluate_frame` | `timeMs`、`graphId?` | 烘关键帧 → 按拓扑序求值一帧，返回求值顺序与命中缓存数。**用来确认图里没有环** |

`easing` 收：`linear` / `ease-in` / `ease-out` / `ease-in-out` / `bounce` / `elastic`，缺省 `linear`。

### 工程与素材

| 工具 | 入参 | 说明 |
| --- | --- | --- |
| `new_project` | `name?` | 新建空工程（1920×1080 / 25fps，一条视频轨、一条音频轨，根图预置序列与输出）。**会清掉当前工程** |
| `save_project` | `path` | 把当前工程写到指定路径（会创建父目录）。**唯一会写文件的工具** |
| `open_project` | `path` | 从磁盘读一份工程，替换掉当前会话里的工程 |
| `import_media` | `path`、`addToTimeline?` | 探测媒体文件并登记为素材；默认同时作为片段铺到时间线上 |
| `probe_media` | `path` | 只探测、不登记：时长、分辨率、帧率、编码、有无音轨 |

节点类型键的取值以 `list_node_types` 的返回为准，常见的例如 `blur` / `grade` / `keyer` / `sharpen` / `glow` / `transform`。传了不存在的类型，工具会回一句中文提示，让你先去看 `list_node_types`。

---

## 五、编译

```
cd scaffold/reelix-mcp
cargo build --release
```

产物在 `scaffold/reelix-mcp/target/release/reelix-mcp.exe`。

注意 `Cargo.toml` 里这行：

```toml
reelix_lib = { package = "reelix", path = "../src-tauri", default-features = false }
```

`default-features = false` 关掉的是 `reelix` 的 `desktop` feature，也就是**不拉 tauri / webview2**。这是必须的——`reelix-mcp` 是普通命令行进程，一旦带上 tauri，就会因为缺 Tauri 的链接参数而链接失败。

release profile 按仓库的体积纪律配：`opt-level = "z"`、`lto = true`、`codegen-units = 1`、`panic = "abort"`、`strip = true`。

---

## 六、接到 MCP 客户端

在客户端的 MCP 配置里，把这个进程的**绝对路径**填成 `command`，传输选 **stdio**。示意（字段名以你的客户端为准）：

```json
{
  "mcpServers": {
    "reelix": {
      "command": "D:\\20533\\Desktop\\Reelix\\scaffold\\reelix-mcp\\target\\release\\reelix-mcp.exe",
      "args": []
    }
  }
}
```

接上之后，一次典型流程是：

1. `new_project` 起一份空工程，或 `open_project` 打开已有的 `.reelix`。
2. `import_media` 把素材铺上时间线（`probe_media` 只探测、不登记）。
3. `list_node_types` 看有哪些效果，`add_node` 加一个，`connect` 接上，`set_node_param` 调参。
4. `set_keyframe` 打曲线，`evaluate_param` 验证某个时刻的取值，`evaluate_frame` 确认整张图能求值、没有环。
5. `save_project` 落盘。

---

## 七、红线对照

这份服务**没有**越过 AGENTS.md 的任何一条：

- **不带 AI**：协议是给外部客户端用的接口，服务本身不含任何模型、不做任何智能处理。
- **不联网**：只有 stdio，没有 socket、没有 HTTP、没有 DNS。
- **不做账号**：没有登录、没有校验、没有远程调用。
- **不自动更新**：不检查版本、不下载任何东西。
- **不碰 git**：仓库里的所有改动只留本地。
- **体积红线**：`reelix-mcp` 是**独立 bin**，Tauri 的打包配置只管 `reelix` 主程序，这个 crate 不进 MSI。
- **界面契约**：MCP 暴露的是**数据与图**，不是「节点图界面」。图在 Reelix 里仍然只用于内部求值，用户界面上永远只有图层 + 效果栈。

MIT 许可，与非营利交付一致。源码在 `scaffold/reelix-mcp/`：`main.rs`（stdio 主循环与分派）、`protocol.rs`（JSON-RPC 编解码）、`tools.rs`（工具目录与实现）。
