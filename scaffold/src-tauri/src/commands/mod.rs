//! 命令层：前端唯一能碰到的入口。
//!
//! 每个子模块对应一类操作，命令名与 `src/services/*.ts` 一一对应，
//! 参数用 camelCase 传进来，靠内部的数据模型反序列化。

pub mod audio;
pub mod dialog;
pub mod export;
pub mod graph;
pub mod history;
pub mod keyframe;
pub mod media;
pub mod project;
pub mod reconstruct;
pub mod render;
pub mod settings;
pub mod subtitle;
pub mod timeline;
