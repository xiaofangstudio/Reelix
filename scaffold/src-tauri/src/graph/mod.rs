//! 图领域：整个项目就是一张有向无环图，时间线是图上的一个节点。
//!
//! 剪辑与特效共用这一张图，见 `docs/04-剪辑与特效融合设计.md`。

pub mod catalog;
pub mod effects;
pub mod engine;
pub mod evaluator;
pub mod node;

pub use effects::{apply, Frame};
pub use engine::{EvalReport, GraphEngine, GraphError};
pub use node::{Connection, Graph, GraphNode, ParamValue, Plug, PlugDataType};
