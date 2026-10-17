//! JSON-RPC 2.0 的消息形状。
//!
//! 协议全部手写，**不引任何 MCP 第三方 crate**——MCP 的 stdio 传输就是
//! 「一行一个 JSON-RPC 消息」，用 serde_json 编解码足够，也少一层供应链。
//!
//! 支持的方法只有四个：`initialize`、`ping`、`tools/list`、`tools/call`。
//! 通知（没有 id 的消息）一律不回话。

use serde::Deserialize;
use serde_json::{json, Value};

/// 我们实现的 MCP 协议版本。客户端报的版本若是字符串，回话时原样回显。
pub const PROTOCOL_VERSION: &str = "2024-11-05";

/// 一条进站消息。通知没有 `id`，不需要回复。
#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

impl RpcRequest {
    /// 没有 id 的是通知，按 JSON-RPC 约定不必回话。
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }
}

/// JSON-RPC 标准错误码，只取用得上的几个。
pub mod code {
    /// 消息不是合法 JSON。
    pub const PARSE_ERROR: i64 = -32700;
    /// 方法不存在。
    pub const METHOD_NOT_FOUND: i64 = -32601;
    /// 参数不合法。
    pub const INVALID_PARAMS: i64 = -32602;
}

/// 成功回复。
pub fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// 失败回复。
pub fn err(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

/// `initialize` 的回话：声明只会用 tools 这一种能力。
pub fn initialize_result(requested_version: Option<&str>) -> Value {
    json!({
        "protocolVersion": requested_version.unwrap_or(PROTOCOL_VERSION),
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "reelix-mcp", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Reelix 是特效合成软件（不是剪辑软件）。这里的工具让你读改一份内存里的工程：\
新建 / 打开 / 保存工程、导入素材、加效果节点、连线、改参数、打关键帧、求值一帧。\
所有改动只作用于本进程，不写盘除非你调 save_project。"
    })
}

/// 把工具返回值包成 MCP 的 content 结构。
///
/// 工具自身的失败走 `isError`，不是 JSON-RPC 错误——这样客户端仍能读到中文原因。
pub fn tool_content(value: Value, is_error: bool) -> Value {
    let text = match &value {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
    };
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error
    })
}
