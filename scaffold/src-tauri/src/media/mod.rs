//! 素材领域：与界面、与全局状态都无关的纯逻辑。
//!
//! 目前只有探测一种能力。放在命令层之外，是为了让 `reelix-mcp`
//! 在 `default-features = false` 下也能复用同一份探测实现，
//! 不必把整个 tauri 外壳拖进命令行进程。

pub mod audio;
pub mod probe;
