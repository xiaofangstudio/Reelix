//! 图命令：节点增删、连线、参数、复合片段、注册表。
//!
//! 这些命令既是「节点图的操作」也是「时间线的操作」——因为时间线与节点图共用同一张图。

use std::collections::HashMap;

use serde::Serialize;
use tauri::State;

use crate::graph::catalog::{create_node, node_catalog, NodeTypeInfo};
use crate::graph::engine::EvalReport;
use crate::graph::node::{plug, Connection, Graph, GraphNode, ParamValue, PlugDataType};
use crate::history::record;
use crate::project::model::Project;
use crate::project::serialize::new_id;
use crate::state::{lock, AppState};

/// 复合片段节点：对外是一个普通节点，内部是一张图。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompoundNode {
    pub node: GraphNode,
    pub graph_id: String,
}

/// 进入复合片段的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnterResult {
    pub graph_id: String,
}

fn require_project<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, Option<Project>>, String> {
    let guard = lock(&state.project)?;
    if guard.is_none() {
        return Err("还没有打开项目".to_string());
    }
    Ok(guard)
}

fn find_graph_mut<'a>(project: &'a mut Project, graph_id: &str) -> Option<&'a mut Graph> {
    project.graphs.get_mut(graph_id)
}

fn find_graph_of_node_mut<'a>(project: &'a mut Project, node_id: &str) -> Option<&'a mut Graph> {
    project.graphs.values_mut().find(|g| g.node(node_id).is_some())
}

/// 往图里加一个节点。
#[tauri::command]
pub fn add_node(
    graph_id: String,
    node_type: String,
    x: f64,
    y: f64,
    state: State<'_, AppState>,
) -> Result<GraphNode, String> {
    let node = create_node(&node_type, x, y)
        .ok_or_else(|| format!("未知的节点类型：{node_type}"))?;

    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let graph = find_graph_mut(project, &graph_id).ok_or_else(|| "找不到该图".to_string())?;
    graph.nodes.push(node.clone());

    record(&state, "添加节点", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(node)
}

/// 删节点，同时断开它的所有连接。
#[tauri::command]
pub fn remove_node(node_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;

    let mut removed = false;
    for graph in project.graphs.values_mut() {
        if graph.remove_node(&node_id) {
            removed = true;
            break;
        }
    }
    if !removed {
        return Err("找不到该节点".to_string());
    }
    // 节点没了，它的输出缓存也一并丢掉。
    lock(&state.engine)?.invalidate(&node_id);
    record(&state, "删除节点", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 连接两个插槽。
#[tauri::command]
pub fn connect(
    from_node: String,
    from_plug: String,
    to_node: String,
    to_plug: String,
    state: State<'_, AppState>,
) -> Result<Connection, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let graph = find_graph_of_node_mut(project, &from_node)
        .ok_or_else(|| "找不到起点节点".to_string())?;

    if graph.node(&to_node).is_none() {
        return Err("找不到终点节点".to_string());
    }

    if let Some(node) = graph.node_mut(&from_node) {
        if let Some(p) = node.outputs.iter_mut().find(|p| p.key == from_plug) {
            p.connected = true;
        }
    }
    if let Some(node) = graph.node_mut(&to_node) {
        if let Some(p) = node.inputs.iter_mut().find(|p| p.key == to_plug) {
            p.connected = true;
        }
    }

    let connection = Connection {
        id: new_id("conn"),
        from_node,
        from_plug,
        to_node,
        to_plug,
    };
    // 拓扑变了，被连上的下游要重算。
    lock(&state.dirty)?.mark(&connection.to_node);
    graph.connections.push(connection.clone());

    record(&state, "连接节点", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(connection)
}

/// 断开一条连接。
#[tauri::command]
pub fn disconnect(connection_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;

    let mut dropped_to: Option<String> = None;
    for graph in project.graphs.values_mut() {
        let before = graph.connections.len();
        let to_node = graph
            .connections
            .iter()
            .find(|c| c.id == connection_id)
            .map(|c| c.to_node.clone());
        graph.connections.retain(|c| c.id != connection_id);
        if graph.connections.len() != before {
            dropped_to = to_node;
            break;
        }
    }
    let Some(to_node) = dropped_to else {
        return Err("找不到该连接".to_string());
    };
    // 拓扑变了，原来的下游要按新的输入重算。
    lock(&state.dirty)?.mark(&to_node);
    record(&state, "断开连接", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 修改节点参数。改完上游标脏，下游会重算。
#[tauri::command]
pub fn set_node_param(
    node_id: String,
    param: String,
    value: ParamValue,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let graph =
        find_graph_of_node_mut(project, &node_id).ok_or_else(|| "找不到该节点".to_string())?;
    let node = graph.node_mut(&node_id).ok_or_else(|| "找不到该节点".to_string())?;
    node.set_param(&param, value);

    lock(&state.dirty)?.mark(&node_id);
    record(&state, "修改节点参数", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}

/// 把一组节点折叠成复合片段（预合成）。
#[tauri::command]
pub fn collapse_compound(
    node_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<CompoundNode, String> {
    if node_ids.is_empty() {
        return Err("没有选中任何节点".to_string());
    }
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;

    // 找到包含第一个被选中节点的图
    let source_graph_id = project
        .graphs
        .iter()
        .find(|(_, g)| node_ids.iter().any(|id| g.node(id).is_some()))
        .map(|(id, _)| id.clone())
        .ok_or_else(|| "找不到要折叠的节点".to_string())?;

    let (inner_nodes, internal, cx, cy) = {
        let source = project
            .graphs
            .get_mut(&source_graph_id)
            .ok_or_else(|| "找不到该图".to_string())?;

        let mut inner_nodes = Vec::new();
        for id in &node_ids {
            if let Some(idx) = source.nodes.iter().position(|n| &n.id == id) {
                inner_nodes.push(source.nodes.remove(idx));
            }
        }
        if inner_nodes.is_empty() {
            return Err("找不到要折叠的节点".to_string());
        }

        let internal: Vec<Connection> = source
            .connections
            .iter()
            .filter(|c| node_ids.contains(&c.from_node) && node_ids.contains(&c.to_node))
            .cloned()
            .collect();
        source
            .connections
            .retain(|c| !(node_ids.contains(&c.from_node) || node_ids.contains(&c.to_node)));

        let cx = inner_nodes.iter().map(|n| n.x).sum::<f64>() / inner_nodes.len() as f64;
        let cy = inner_nodes.iter().map(|n| n.y).sum::<f64>() / inner_nodes.len() as f64;
        (inner_nodes, internal, cx, cy)
    };

    let compound_node_id = new_id("node");
    let inner_graph_id = new_id("graph");

    project.graphs.insert(
        inner_graph_id.clone(),
        Graph {
            id: inner_graph_id.clone(),
            nodes: inner_nodes,
            connections: internal,
            parent_node_id: Some(compound_node_id.clone()),
        },
    );

    let compound_node = GraphNode {
        id: compound_node_id,
        node_type: "compound".into(),
        name: "复合片段".into(),
        x: cx,
        y: cy,
        params: HashMap::new(),
        bypassed: false,
        collapsed: true,
        animated: false,
        inputs: vec![plug("in", "输入", PlugDataType::Image, false)],
        outputs: vec![plug("out", "输出", PlugDataType::Image, false)],
    };

    let source = project
        .graphs
        .get_mut(&source_graph_id)
        .ok_or_else(|| "找不到该图".to_string())?;
    source.nodes.push(compound_node.clone());

    record(&state, "折叠为复合片段", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(CompoundNode {
        node: compound_node,
        graph_id: inner_graph_id,
    })
}

/// 进入复合片段内部编辑，返回内部图的 id。
#[tauri::command]
pub fn enter_compound(node_id: String, state: State<'_, AppState>) -> Result<EnterResult, String> {
    let guard = lock(&state.project)?;
    let project = guard.as_ref().ok_or_else(|| "还没有打开项目".to_string())?;
    let graph_id = project
        .graphs
        .iter()
        .find(|(_, g)| g.parent_node_id.as_deref() == Some(node_id.as_str()))
        .map(|(id, _)| id.clone())
        .ok_or_else(|| "该节点不是复合片段".to_string())?;
    Ok(EnterResult { graph_id })
}

/// 取节点类型注册表，用于节点搜索面板。
#[tauri::command]
pub fn get_node_catalog() -> Result<Vec<NodeTypeInfo>, String> {
    Ok(node_catalog())
}

/// 跑一遍图求值：按拓扑序重算脏节点，其余直接用缓存。
///
/// 返回本次求值报告——谁被重算了、谁被复用、按什么顺序走的。
/// 前端靠这份报告知道哪些节点是真的变了，从而只刷新那几路的预览。
#[tauri::command]
pub fn evaluate_graph(
    graph_id: String,
    state: State<'_, AppState>,
) -> Result<EvalReport, String> {
    let guard = require_project(&state)?;
    let project = guard.as_ref().ok_or_else(|| "还没有打开项目".to_string())?;
    let graph = project
        .graphs
        .get(&graph_id)
        .ok_or_else(|| "找不到该图".to_string())?;

    let mut engine = lock(&state.engine)?;
    let mut dirty = lock(&state.dirty)?;
    engine.evaluate(graph, &mut dirty).map_err(|e| e.to_string())
}
