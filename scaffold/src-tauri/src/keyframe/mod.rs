//! 关键帧领域：一套引擎同时服务剪辑层与合成层。
//!
//! 片段的透明度能打关键帧，节点的模糊半径也能打关键帧，用的是同一个结构、
//! 同一个曲线引擎（见 `docs/04-剪辑与特效融合设计.md` 第三节）。
//! 曲线算法必须与前端 `src/core/curveEval.ts` 完全一致，否则预览会和渲染对不上。

pub mod curve;
pub mod model;
pub mod store;

pub use model::{Curve, EasingPreset, Keyframe};
pub use store::KeyframeStore;
