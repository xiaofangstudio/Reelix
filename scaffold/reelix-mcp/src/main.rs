//! Reelix MCP 服务本体。
//!
//! 传输是 stdio：**一行一个 JSON-RPC 2.0 消息**，读到 EOF 就退出。
//! 不联网、不开端口、不起子进程——它只是把一份内存里的工程副本
//! 暴露成一组工具，让外面的 MCP 客户端来读、来改。
//!
//! 层次：`protocol.rs` 管消息形状，`tools.rs` 管工具实现，本文件只管
//! 「读一行 → 分派 → 回一行」这个循环。协议方法一共四个：
//! `initialize`、`ping`、`tools/list`、`tools/call`。
//! 通知（没有 id）按 JSON-RPC 约定不回话。

mod protocol;
mod tools;

use std::io::{self, BufRead, Write};

use serde_json::{json, Value};

use protocol::RpcRequest;
use tools::Session;

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut session = Session::default();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            // stdin 断了就收工，不当成错误。
            Err(_) => break,
        };
        // 有些 Windows 管道会在头一行前面塞个 BOM，直接 trim 掉免得整条消息解析失败。
        let line = line.trim_start_matches('\u{feff}').trim();
        if line.is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<RpcRequest>(line) {
            Ok(req) => handle(&mut session, req),
            Err(_) => Some(protocol::err(
                Value::Null,
                protocol::code::PARSE_ERROR,
                "消息不是合法 JSON",
            )),
        };

        let Some(message) = response else {
            // 通知：不回话，接着读下一行。
            continue;
        };
        let text = serde_json::to_string(&message).unwrap_or_else(|_| "{}".to_string());
        if writeln!(out, "{text}").is_err() || out.flush().is_err() {
            break;
        }
    }
}

/// 分派一条进站消息。返回 `None` 表示这是通知，不必回话。
fn handle(session: &mut Session, req: RpcRequest) -> Option<Value> {
    if req.is_notification() {
        return None;
    }
    let id = req.id.clone().unwrap_or(Value::Null);

    match req.method.as_str() {
        "initialize" => {
            let want = req.params.get("protocolVersion").and_then(Value::as_str);
            Some(protocol::ok(id, protocol::initialize_result(want)))
        }
        "ping" => Some(protocol::ok(id, json!({}))),
        "tools/list" => Some(protocol::ok(id, json!({ "tools": tool_list() }))),
        "tools/call" => {
            // 连工具名都没给，是协议层的参数问题，走 JSON-RPC 错误码。
            let Some(name) = req.params.get("name").and_then(Value::as_str) else {
                return Some(protocol::err(
                    id,
                    protocol::code::INVALID_PARAMS,
                    "tools/call 缺少参数 name",
                ));
            };
            let args = req
                .params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));

            let content = match tools::call(session, name, &args) {
                Ok(value) => protocol::tool_content(value, false),
                // 工具失败走 isError，不是 JSON-RPC 错误——客户端仍读得到中文原因。
                Err(reason) => protocol::tool_content(Value::String(reason), true),
            };
            Some(protocol::ok(id, content))
        }
        other => Some(protocol::err(
            id,
            protocol::code::METHOD_NOT_FOUND,
            &format!("不认识的方法：{other}"),
        )),
    }
}

/// 把工具目录翻译成 `tools/list` 要的形状（注意字段名是 `inputSchema`）。
fn tool_list() -> Vec<Value> {
    tools::catalog()
        .into_iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": tool.schema,
            })
        })
        .collect()
}
