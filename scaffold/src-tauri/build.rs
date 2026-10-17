// 构建脚本：生成 Tauri 需要的上下文与权限清单。
//
// 只有桌面外壳（默认 feature `desktop`）才需要这一步。
// reelix-mcp 以 `default-features = false` 依赖本库、只取纯逻辑，
// 此时不生成任何 Tauri 产物，也就不牵扯 tauri 的链接参数。
fn main() {
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
