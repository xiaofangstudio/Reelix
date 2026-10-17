//! 合成支撑层：把一帧从「磁盘素材」变成「监视器上能看的图」。
//!
//! 只做三件基础事，且都是零依赖 / 不并入第三方：
//! - [`decode`]：起 ffmpeg 独立进程解一帧原始 RGBA（LGPL 只动态调用）；
//! - [`png`]：把合成结果编码成 PNG（自研最小编码器，不引 `png`/`image`）；
//! - [`cache`]：内存 + 磁盘两级帧缓存，回拖时不必重算。
//!
//! 真正的重活仍在 Rust 侧的求值链路：解帧拿到 [`crate::graph::Frame`] 后，
//! 交给 [`crate::graph::apply`] 过一遍效果栈，再编码落盘。
//! 前端永远只拿到算好的结果，不做解码、不做逐帧合成。

pub mod cache;
pub mod decode;
pub mod png;

pub use cache::{frame_file, frames_root, FrameCache};
pub use decode::{decode_frame, locate_ffmpeg};
pub use png::encode_rgba8;
