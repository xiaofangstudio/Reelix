//! 项目领域：数据模型与 .reelix 读写。

pub mod model;
pub mod serialize;

pub use model::{Asset, AssetKind, Id, Project, Sequence};
pub use serialize::{new_id, now_ms};
