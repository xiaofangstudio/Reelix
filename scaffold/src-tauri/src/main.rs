// 发布构建不弹控制台窗口（Windows 专属）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 入口只做一件事：把控制权交给库里注册好的运行时。
fn main() {
    reelix_lib::run();
}
