//! 时间线领域：轨道与片段。
//!
//! 时间线是图的另一种呈现，片段通过 `node_id` 与图节点绑定，
//! 这正是「剪辑与特效融合」的接口（见 `docs/04-剪辑与特效融合设计.md`）。

pub mod model;

pub use model::{Clip, Layer3DOrientation, Track, TrackKind, Transform3D, Vec2, Vec3};
