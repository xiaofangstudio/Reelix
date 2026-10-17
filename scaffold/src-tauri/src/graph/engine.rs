//! 图引擎：拓扑排序、脏标记向下游传播、逐节点输出缓存与增量求值。
//!
//! 这是 M2「合成基础」的地基。界面拖动一个参数后，引擎要能立刻算出
//! 「哪些节点需要重算、按什么顺序算、哪些可以直接吃缓存」——这是
//! `docs/11-硬指标与优化手感建议.md` 里「参数响应 ≤ 100ms」的前提。
//!
//! 骨架阶段先不产出像素：wgpu 合成管线在后续接入（见 `docs/03-技术架构.md` 第三节）。
//! 引擎现在为每个节点算出一枚**输出指纹**——指纹由节点类型、参数、旁路状态
//! 与各上游输入的指纹共同决定。指纹不变，说明这一版输出与上一版逐位相同，
//! 于是缓存可以整段复用，连下游都不必碰。

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};

use serde::Serialize;

use crate::graph::evaluator::DirtyTracker;
use crate::graph::node::{Graph, GraphNode, ParamValue};

/// 求值过程中可能出现的错误。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum GraphError {
    /// 图里出现了环，违反有向无环图约定。
    Cycle { nodes: Vec<String> },
}

impl std::fmt::Display for GraphError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GraphError::Cycle { nodes } => {
                write!(f, "图里存在环路，无法求值：{}", nodes.join("、"))
            }
        }
    }
}

impl std::error::Error for GraphError {}

/// 一条输入来自哪里。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRef {
    /// 落到本节点的哪个输入插槽
    pub plug: String,
    /// 上游节点
    pub from_node: String,
    /// 上游节点的哪个输出插槽
    pub from_plug: String,
}

/// 一个节点的求值产物。
///
/// 骨架阶段不含像素，只描述「这一版输出是什么」。等 wgpu 管线接入后，
/// 这里会再挂上纹理句柄与尺寸，而指纹字段保持不变。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeOutput {
    pub node_id: String,
    pub node_type: String,
    /// 输出指纹：由类型、参数、旁路状态与各上游输入指纹共同决定。
    /// 指纹相同即表示输出逐位相同，可整段复用缓存。
    pub fingerprint: u64,
    /// 本节点各输入来自哪个上游节点
    pub inputs: Vec<InputRef>,
}

/// 一次求值的统计报告。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalReport {
    /// 本次真正重算的节点（拓扑序）
    pub evaluated: Vec<String>,
    /// 直接吃缓存的节点（拓扑序）
    pub reused: Vec<String>,
    /// 本次遍历的完整拓扑顺序
    pub order: Vec<String>,
}

impl EvalReport {
    /// 命中缓存的节点数。
    pub fn reused_count(&self) -> usize {
        self.reused.len()
    }

    /// 真正重算的节点数。
    pub fn evaluated_count(&self) -> usize {
        self.evaluated.len()
    }
}

/// 逐节点输出缓存 + 增量求值器。
#[derive(Debug, Default)]
pub struct GraphEngine {
    outputs: HashMap<String, NodeOutput>,
}

impl GraphEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前已缓存的节点数。
    pub fn len(&self) -> usize {
        self.outputs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.outputs.is_empty()
    }

    /// 取某节点的缓存输出。
    pub fn output(&self, node_id: &str) -> Option<&NodeOutput> {
        self.outputs.get(node_id)
    }

    /// 丢弃单个节点的缓存。删除节点时调用。
    pub fn invalidate(&mut self, node_id: &str) {
        self.outputs.remove(node_id);
    }

    /// 清空全部缓存。
    pub fn clear(&mut self) {
        self.outputs.clear();
    }

    /// 求值一张图。
    ///
    /// 只重算「脏节点 ∪ 脏节点的下游 ∪ 尚未算过的节点」，范围内的节点按拓扑序
    /// 逐个算指纹：指纹与缓存一致就复用，不一致才真正重算。因为上游指纹是
    /// 下游指纹的输入，所以只要某个节点指纹没变，它的整条下游都会自然复用，
    /// 不需要额外遍历。
    pub fn evaluate(
        &mut self,
        graph: &Graph,
        dirty: &mut DirtyTracker,
    ) -> Result<EvalReport, GraphError> {
        let order = topo_order(graph)?;

        // 顺手清掉已被删除节点的缓存，避免缓存无限膨胀。
        let alive: HashSet<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
        self.outputs.retain(|k, _| alive.contains(k.as_str()));

        // 本次需要检查的范围。
        let seeds = dirty.pending().to_vec();
        let mut scope: HashSet<String> = HashSet::new();
        if !seeds.is_empty() {
            scope.extend(seeds.iter().cloned());
            scope.extend(descendants(graph, &seeds));
        }
        for node in &graph.nodes {
            if !self.outputs.contains_key(&node.id) {
                scope.insert(node.id.clone());
            }
        }

        let mut report = EvalReport {
            order: order.clone(),
            ..Default::default()
        };

        for id in &order {
            if !scope.contains(id) {
                // 不在重算范围内：直接吃上一版缓存
                report.reused.push(id.clone());
                continue;
            }

            let node = graph
                .node(id)
                .expect("拓扑序里的节点必然存在于图中");

            let inputs = wired_inputs(graph, id);
            let wired: Vec<(String, u64)> = inputs
                .iter()
                .map(|r| {
                    let fp = self
                        .outputs
                        .get(&r.from_node)
                        .map(|o| o.fingerprint)
                        .unwrap_or(0);
                    (r.plug.clone(), fp)
                })
                .collect();
            let fp = fingerprint(node, &wired);

            let same = self
                .outputs
                .get(id)
                .map(|cached| cached.fingerprint == fp)
                .unwrap_or(false);

            if same {
                report.reused.push(id.clone());
            } else {
                self.outputs.insert(
                    id.clone(),
                    NodeOutput {
                        node_id: id.clone(),
                        node_type: node.node_type.clone(),
                        fingerprint: fp,
                        inputs,
                    },
                );
                report.evaluated.push(id.clone());
            }
        }

        dirty.clear();
        Ok(report)
    }
}

/// 把一个节点的全部输入连接整理成有序列表。
///
/// 按插槽键排序并去重，保证同一张图每次得到的结果一致——否则指纹会随
/// `HashMap` 的迭代顺序抖动，缓存全线失效。
fn wired_inputs(graph: &Graph, node_id: &str) -> Vec<InputRef> {
    let mut refs: Vec<InputRef> = graph
        .connections
        .iter()
        .filter(|c| c.to_node == node_id)
        .map(|c| InputRef {
            plug: c.to_plug.clone(),
            from_node: c.from_node.clone(),
            from_plug: c.from_plug.clone(),
        })
        .collect();
    refs.sort_by(|a, b| {
        a.plug
            .cmp(&b.plug)
            .then(a.from_node.cmp(&b.from_node))
            .then(a.from_plug.cmp(&b.from_plug))
    });
    refs.dedup();
    refs
}

/// 计算一个节点的输出指纹。
///
/// `wired` 是「输入插槽 → 上游输出指纹」，调用前需按插槽键排好序。
fn fingerprint(node: &GraphNode, wired: &[(String, u64)]) -> u64 {
    let mut hasher = DefaultHasher::new();
    node.node_type.hash(&mut hasher);
    node.bypassed.hash(&mut hasher);

    // 参数按 key 排序，去掉 HashMap 迭代顺序的影响。
    let mut keys: Vec<&String> = node.params.keys().collect();
    keys.sort();
    for key in keys {
        key.hash(&mut hasher);
        param_hash(&node.params[key], &mut hasher);
    }

    for (plug, upstream) in wired {
        plug.hash(&mut hasher);
        upstream.hash(&mut hasher);
    }

    hasher.finish()
}

/// 把参数值写进哈希。浮点走 `to_bits`，保证按位确定。
fn param_hash(value: &ParamValue, hasher: &mut DefaultHasher) {
    match value {
        ParamValue::Bool(b) => {
            0u8.hash(hasher);
            b.hash(hasher);
        }
        ParamValue::Number(n) => {
            1u8.hash(hasher);
            n.to_bits().hash(hasher);
        }
        ParamValue::Text(s) => {
            2u8.hash(hasher);
            s.hash(hasher);
        }
    }
}

/// 拓扑排序（Kahn 算法）。上游在前，下游在后；发现环时返回错误。
pub fn topo_order(graph: &Graph) -> Result<Vec<String>, GraphError> {
    let mut indegree: HashMap<&str, usize> =
        graph.nodes.iter().map(|n| (n.id.as_str(), 0usize)).collect();
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();

    for conn in &graph.connections {
        let (Some(_), Some(_)) = (
            indegree.get(conn.from_node.as_str()),
            indegree.get(conn.to_node.as_str()),
        ) else {
            // 连接的一端不在图里（悬空引用），忽略，不让它把整张图卡死。
            continue;
        };
        adjacency
            .entry(conn.from_node.as_str())
            .or_default()
            .push(conn.to_node.as_str());
        if let Some(deg) = indegree.get_mut(conn.to_node.as_str()) {
            *deg += 1;
        }
    }

    let mut queue: VecDeque<&str> = VecDeque::new();
    // 入度为 0 的节点按原顺序入队，保证结果稳定。
    for node in &graph.nodes {
        if indegree.get(node.id.as_str()).copied().unwrap_or(0) == 0 {
            queue.push_back(node.id.as_str());
        }
    }

    let mut order: Vec<String> = Vec::with_capacity(graph.nodes.len());
    let mut visited: HashSet<&str> = HashSet::new();
    while let Some(id) = queue.pop_front() {
        order.push(id.to_string());
        visited.insert(id);
        if let Some(nexts) = adjacency.get(id) {
            for next in nexts {
                if let Some(deg) = indegree.get_mut(next) {
                    *deg = deg.saturating_sub(1);
                    if *deg == 0 && !visited.contains(next) {
                        queue.push_back(next);
                    }
                }
            }
        }
    }

    if order.len() != graph.nodes.len() {
        let stuck: Vec<String> = graph
            .nodes
            .iter()
            .filter(|n| !visited.contains(n.id.as_str()))
            .map(|n| n.id.clone())
            .collect();
        return Err(GraphError::Cycle { nodes: stuck });
    }

    Ok(order)
}

/// 收集一组种子节点的全部下游（不含种子自身）。
pub fn descendants(graph: &Graph, seeds: &[String]) -> HashSet<String> {
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    for conn in &graph.connections {
        adjacency
            .entry(conn.from_node.as_str())
            .or_default()
            .push(conn.to_node.as_str());
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut stack: Vec<&str> = seeds.iter().map(|s| s.as_str()).collect();
    while let Some(id) = stack.pop() {
        if let Some(nexts) = adjacency.get(id) {
            for next in nexts {
                if seen.insert((*next).to_string()) {
                    stack.push(next);
                }
            }
        }
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::node::{plug, Connection, PlugDataType};

    fn node(id: &str, ty: &str) -> GraphNode {
        GraphNode {
            id: id.to_string(),
            node_type: ty.to_string(),
            name: ty.to_string(),
            x: 0.0,
            y: 0.0,
            params: HashMap::new(),
            bypassed: false,
            collapsed: false,
            animated: false,
            inputs: vec![plug("in", "输入", PlugDataType::Image, false)],
            outputs: vec![plug("out", "输出", PlugDataType::Image, false)],
        }
    }

    fn conn(id: &str, from: &str, to: &str) -> Connection {
        Connection {
            id: id.to_string(),
            from_node: from.to_string(),
            from_plug: "out".to_string(),
            to_node: to.to_string(),
            to_plug: "in".to_string(),
        }
    }

    /// a -> b -> c 的三节点链。
    fn chain() -> Graph {
        Graph {
            id: "g".to_string(),
            nodes: vec![node("a", "clip"), node("b", "blur"), node("c", "output")],
            connections: vec![conn("c1", "a", "b"), conn("c2", "b", "c")],
            parent_node_id: None,
        }
    }

    #[test]
    fn topo_puts_upstream_first() {
        let order = topo_order(&chain()).unwrap();
        let pos = |id: &str| order.iter().position(|x| x == id).unwrap();
        assert!(pos("a") < pos("b"));
        assert!(pos("b") < pos("c"));
    }

    #[test]
    fn reports_cycle_with_offending_nodes() {
        let mut graph = chain();
        graph.connections.push(conn("c3", "c", "a"));
        let err = topo_order(&graph).unwrap_err();
        match err {
            GraphError::Cycle { nodes } => assert_eq!(nodes.len(), 3),
        }
    }

    #[test]
    fn first_eval_computes_all_nodes() {
        let mut engine = GraphEngine::new();
        let mut dirty = DirtyTracker::new();
        let report = engine.evaluate(&chain(), &mut dirty).unwrap();
        assert_eq!(report.evaluated_count(), 3);
        assert_eq!(report.reused_count(), 0);
        assert_eq!(engine.len(), 3);
    }

    #[test]
    fn no_change_reuses_every_cache() {
        let graph = chain();
        let mut engine = GraphEngine::new();
        let mut dirty = DirtyTracker::new();
        engine.evaluate(&graph, &mut dirty).unwrap();

        let report = engine.evaluate(&graph, &mut dirty).unwrap();
        assert_eq!(report.evaluated_count(), 0);
        assert_eq!(report.reused_count(), 3);
        // 标脏集合被清空，不会重复重算
        assert!(dirty.is_empty());
    }

    #[test]
    fn dirty_mark_recomputes_downstream() {
        let mut graph = chain();
        let mut engine = GraphEngine::new();
        let mut dirty = DirtyTracker::new();
        engine.evaluate(&graph, &mut dirty).unwrap();

        // 标脏 b 并真的改一个值：b 与它的下游 c 重算，a 碰都不碰。
        graph
            .node_mut("b")
            .unwrap()
            .set_param("radius", ParamValue::Number(8.0));
        dirty.mark("b");
        let report = engine.evaluate(&graph, &mut dirty).unwrap();
        assert_eq!(report.evaluated, vec!["b".to_string(), "c".to_string()]);
        assert_eq!(report.reused, vec!["a".to_string()]);
    }

    #[test]
    fn upstream_param_change_recomputes_all() {
        let mut graph = chain();
        let mut engine = GraphEngine::new();
        let mut dirty = DirtyTracker::new();
        engine.evaluate(&graph, &mut dirty).unwrap();

        graph
            .node_mut("a")
            .unwrap()
            .set_param("opacity", ParamValue::Number(50.0));
        dirty.mark("a");

        let report = engine.evaluate(&graph, &mut dirty).unwrap();
        assert_eq!(report.evaluated_count(), 3);
    }

    #[test]
    fn bypass_changes_fingerprint() {
        let graph = chain();
        let mut engine = GraphEngine::new();
        let mut dirty = DirtyTracker::new();
        engine.evaluate(&graph, &mut dirty).unwrap();
        let before = engine.output("b").unwrap().fingerprint;

        let mut graph2 = graph.clone();
        graph2.node_mut("b").unwrap().bypassed = true;
        dirty.mark("b");
        engine.evaluate(&graph2, &mut dirty).unwrap();

        assert_ne!(before, engine.output("b").unwrap().fingerprint);
    }

    #[test]
    fn same_value_reuses_then_real_change_recomputes() {
        let mut graph = chain();
        let mut engine = GraphEngine::new();
        let mut dirty = DirtyTracker::new();
        engine.evaluate(&graph, &mut dirty).unwrap();

        // 标脏 a，但参数其实没变：指纹一致，下游应当全部复用
        dirty.mark("a");
        let report = engine.evaluate(&graph, &mut dirty).unwrap();
        assert_eq!(report.evaluated_count(), 0);

        // 真正改一个值，才触发重算
        graph
            .node_mut("b")
            .unwrap()
            .set_param("radius", ParamValue::Number(24.0));
        dirty.mark("b");
        let report = engine.evaluate(&graph, &mut dirty).unwrap();
        assert_eq!(report.evaluated, vec!["b".to_string(), "c".to_string()]);
    }

    #[test]
    fn descendants_excludes_seeds() {
        let graph = chain();
        let seed = vec!["a".to_string()];
        let down = descendants(&graph, &seed);
        assert!(down.contains("b"));
        assert!(down.contains("c"));
        assert!(!down.contains("a"));
    }

    #[test]
    fn removed_node_cache_is_reclaimed() {
        let graph = chain();
        let mut engine = GraphEngine::new();
        let mut dirty = DirtyTracker::new();
        engine.evaluate(&graph, &mut dirty).unwrap();
        assert_eq!(engine.len(), 3);

        let mut trimmed = graph.clone();
        trimmed.remove_node("c");
        engine.evaluate(&trimmed, &mut dirty).unwrap();
        assert_eq!(engine.len(), 2);
        assert!(engine.output("c").is_none());
    }
}
