//! 求值调度：脏标记。
//!
//! 本模块只负责一件事——记录「哪些节点脏了」，并按标脏先后保序。
//! 真正的拓扑排序、逐节点求值与输出缓存由 `graph::engine::GraphEngine`
//! 消费这里的脏集合来推进（见 `docs/03-技术架构.md` 第三节）。

use std::collections::HashSet;

/// 脏标记集合。记录哪些节点需要重算，并按标脏先后保序，
/// 下游重算时按这个顺序推进，尽量复用上游缓存。
#[derive(Debug, Default)]
pub struct DirtyTracker {
    /// 需要重算的节点
    dirty: HashSet<String>,
    /// 标脏顺序，去重后按时间先后排列
    order: Vec<String>,
}

impl DirtyTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// 标脏一个节点。重复标脏不会打乱已有顺序。
    pub fn mark(&mut self, node_id: &str) {
        if self.dirty.insert(node_id.to_string()) {
            self.order.push(node_id.to_string());
        }
    }

    /// 批量标脏。
    pub fn mark_many<I, S>(&mut self, node_ids: I)
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        for id in node_ids {
            self.mark(id.as_ref());
        }
    }

    pub fn is_dirty(&self, node_id: &str) -> bool {
        self.dirty.contains(node_id)
    }

    pub fn is_empty(&self) -> bool {
        self.dirty.is_empty()
    }

    pub fn len(&self) -> usize {
        self.dirty.len()
    }

    /// 取出全部脏节点并按标脏顺序清空。
    pub fn take(&mut self) -> Vec<String> {
        let out = self.order.clone();
        self.dirty.clear();
        self.order.clear();
        out
    }

    /// 当前脏节点（标脏顺序），不清空。
    pub fn pending(&self) -> &[String] {
        &self.order
    }

    /// 清空所有标记。
    pub fn clear(&mut self) {
        self.dirty.clear();
        self.order.clear();
    }
}
