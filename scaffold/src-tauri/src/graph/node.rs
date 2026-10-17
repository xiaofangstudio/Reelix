//! 图数据模型。字段名即契约，与 `src/types/graph.ts` 一致，
//! 靠 `serde(rename_all = "camelCase")` 保证前后端 JSON 对得上。
//!
//! 注意几个例外：前端字段叫 `type`、`is3D`、`enable3D`、`transform3D`，
//! 而 Rust 侧用 `node_type` / `is_3d` / `enable_3d` / `transform_3d`，
//! 这些字段必须用字段级 `rename` 手写，`rename_all` 无法生成带大写的 3D。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// 参数值：与前端 `ParamValue = number | string | boolean` 一一对应。
///
/// 用 `untagged` 让 JSON 直接落成原生类型；顺序很关键，
/// 布尔要先于数字判断，避免 `true` 被误当数字。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ParamValue {
    Bool(bool),
    Number(f64),
    Text(String),
}

impl ParamValue {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            ParamValue::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            ParamValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            ParamValue::Text(s) => Some(s),
            _ => None,
        }
    }
}

impl From<f64> for ParamValue {
    fn from(v: f64) -> Self {
        ParamValue::Number(v)
    }
}

impl From<bool> for ParamValue {
    fn from(v: bool) -> Self {
        ParamValue::Bool(v)
    }
}

impl From<&str> for ParamValue {
    fn from(v: &str) -> Self {
        ParamValue::Text(v.to_string())
    }
}

impl From<String> for ParamValue {
    fn from(v: String) -> Self {
        ParamValue::Text(v)
    }
}

/// 插槽数据类型，与 `src/types/graph.ts` 的 `PlugDataType` 对齐。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlugDataType {
    Image,
    Number,
    Vector,
    Color,
    Text,
    Mask,
}

/// 插槽。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plug {
    pub key: String,
    /// 中文标签
    pub label: String,
    pub data_type: PlugDataType,
    pub connected: bool,
    /// 是否为 3D 插槽，见 docs/09 第 2.4 节
    #[serde(default, rename = "is3D")]
    pub is_3d: bool,
}

impl Plug {
    /// 造一个普通插槽。
    pub fn new(key: &str, label: &str, data_type: PlugDataType, connected: bool) -> Self {
        Self {
            key: key.to_string(),
            label: label.to_string(),
            data_type,
            connected,
            is_3d: false,
        }
    }
}

/// 造一个插槽的简写，供 `project::serialize` 预置节点使用。
pub fn plug(key: &str, label: &str, data_type: PlugDataType, connected: bool) -> Plug {
    Plug::new(key, label, data_type, connected)
}

/// 造一个 3D 插槽（图层勾选「启用 3D」后多出来的那种）。
pub fn plug_3d(key: &str, label: &str, data_type: PlugDataType) -> Plug {
    Plug {
        key: key.to_string(),
        label: label.to_string(),
        data_type,
        connected: false,
        is_3d: true,
    }
}

/// 图节点。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    /// 注册表里的类型键；前端字段名是 `type`
    #[serde(rename = "type")]
    pub node_type: String,
    /// 中文显示名，用户可改
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub params: HashMap<String, ParamValue>,
    /// 旁路：数据直通，节点保留
    pub bypassed: bool,
    /// 折叠为复合片段
    pub collapsed: bool,
    /// 是否有关键帧参数，用于标题栏画小圆点
    pub animated: bool,
    pub inputs: Vec<Plug>,
    pub outputs: Vec<Plug>,
}

impl GraphNode {
    /// 取一个参数；缺失时返回 None。
    pub fn param(&self, key: &str) -> Option<&ParamValue> {
        self.params.get(key)
    }

    /// 写一个参数。
    pub fn set_param(&mut self, key: &str, value: ParamValue) {
        self.params.insert(key.to_string(), value);
    }

    /// 是否带 3D 插槽（摄像机节点或已启用 3D 的图层节点）。
    pub fn has_3d(&self) -> bool {
        self.inputs.iter().any(|p| p.is_3d) || self.outputs.iter().any(|p| p.is_3d)
    }
}

/// 一条连接。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub from_node: String,
    pub from_plug: String,
    pub to_node: String,
    pub to_plug: String,
}

/// 一张图。根图的 `parent_node_id` 为 None，复合片段内部的图指向那个复合节点。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    pub id: String,
    pub nodes: Vec<GraphNode>,
    pub connections: Vec<Connection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_node_id: Option<String>,
}

impl Graph {
    /// 按 id 找节点。
    pub fn node(&self, node_id: &str) -> Option<&GraphNode> {
        self.nodes.iter().find(|n| n.id == node_id)
    }

    /// 按 id 找节点（可变）。
    pub fn node_mut(&mut self, node_id: &str) -> Option<&mut GraphNode> {
        self.nodes.iter_mut().find(|n| n.id == node_id)
    }

    /// 删除一个节点，同时清掉它两端的所有连接。
    pub fn remove_node(&mut self, node_id: &str) -> bool {
        let before = self.nodes.len();
        self.nodes.retain(|n| n.id != node_id);
        if self.nodes.len() == before {
            return false;
        }
        self.connections
            .retain(|c| c.from_node != node_id && c.to_node != node_id);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, node_type: &str) -> GraphNode {
        GraphNode {
            id: id.to_string(),
            node_type: node_type.to_string(),
            name: "节点".into(),
            x: 0.0,
            y: 0.0,
            params: HashMap::new(),
            bypassed: false,
            collapsed: false,
            animated: false,
            inputs: vec![],
            outputs: vec![],
        }
    }

    fn conn(id: &str, from: &str, to: &str) -> Connection {
        Connection {
            id: id.to_string(),
            from_node: from.to_string(),
            from_plug: "out".into(),
            to_node: to.to_string(),
            to_plug: "in".into(),
        }
    }

    /// 布尔必须先于数字判定，否则 `true` 会被当成数字解析。
    #[test]
    fn param_value_prefers_bool_over_number() {
        let b: ParamValue = serde_json::from_str("true").unwrap();
        assert_eq!(b, ParamValue::Bool(true));
        let n: ParamValue = serde_json::from_str("3").unwrap();
        assert_eq!(n, ParamValue::Number(3.0));
        let s: ParamValue = serde_json::from_str("\"播放\"").unwrap();
        assert_eq!(s, ParamValue::Text("播放".into()));
    }

    /// 取值函数要按类型安全地返回，不要串味。
    #[test]
    fn param_value_accessors_are_type_safe() {
        let b = ParamValue::Bool(false);
        assert_eq!(b.as_bool(), Some(false));
        assert!(b.as_f64().is_none());
        assert!(b.as_str().is_none());

        let n = ParamValue::Number(2.5);
        assert_eq!(n.as_f64(), Some(2.5));
        assert!(n.as_bool().is_none());
    }

    /// 前端读的是 `type`，Rust 侧叫 `node_type`，靠字段级 rename 对上。
    #[test]
    fn graph_node_serializes_type_field_name_for_frontend() {
        let value = serde_json::to_value(node("n1", "blur")).unwrap();
        assert_eq!(value["type"], serde_json::json!("blur"));
        assert!(value.get("nodeType").is_none(), "不该出现 nodeType 这种名字");
        assert_eq!(value["bypassed"], serde_json::json!(false));
        assert_eq!(value["animated"], serde_json::json!(false));
    }

    /// 3D 插槽必须落成 `is3D`（大写 D），且 has_3d 能识别到。
    #[test]
    fn plug_3d_serializes_is3d_and_is_detected() {
        let p = plug_3d("cam", "摄像机", PlugDataType::Vector);
        assert!(p.is_3d);
        let value = serde_json::to_value(&p).unwrap();
        assert_eq!(value["is3D"], serde_json::json!(true));
        assert_eq!(value["dataType"], serde_json::json!("vector"));

        let mut n = node("n1", "layer3d");
        n.inputs.push(p);
        assert!(n.has_3d(), "带 3D 插槽的节点应当被识别");
        assert!(!node("n2", "blur").has_3d(), "普通节点不该有 3D 插槽");
    }

    /// 根图不写 parentNodeId，复合片段内部的图才写。
    #[test]
    fn graph_omits_parent_when_root() {
        let root = Graph {
            id: "g1".into(),
            nodes: vec![],
            connections: vec![],
            parent_node_id: None,
        };
        let value = serde_json::to_value(&root).unwrap();
        assert!(value.get("parentNodeId").is_none(), "根图不该写 parentNodeId");

        let inner = Graph {
            id: "g2".into(),
            nodes: vec![],
            connections: vec![],
            parent_node_id: Some("n9".into()),
        };
        let value = serde_json::to_value(&inner).unwrap();
        assert_eq!(value["parentNodeId"], serde_json::json!("n9"));
    }

    /// 删节点要顺手清掉它两端所有连线，重复删返回 false。
    #[test]
    fn remove_node_also_drops_its_connections() {
        let mut g = Graph {
            id: "g1".into(),
            nodes: vec![node("a", "sequence"), node("b", "output"), node("c", "blur")],
            connections: vec![conn("c1", "a", "b"), conn("c2", "b", "c")],
            parent_node_id: None,
        };

        assert!(g.remove_node("b"), "删除已存在的节点应当返回 true");
        assert_eq!(g.nodes.len(), 2);
        assert!(g.connections.is_empty(), "两端连线都应当被清掉");
        assert!(!g.remove_node("b"), "重复删除应当返回 false");
    }

    /// 按 id 查节点、写参数、参数覆盖。
    #[test]
    fn graph_lookup_and_param_write() {
        let mut g = Graph {
            id: "g1".into(),
            nodes: vec![node("a", "blur")],
            connections: vec![],
            parent_node_id: None,
        };
        assert!(g.node("a").is_some());
        assert!(g.node("missing").is_none());

        let n = g.node_mut("a").unwrap();
        n.set_param("半径", 8.0.into());
        assert_eq!(n.param("半径"), Some(&ParamValue::Number(8.0)));
        assert!(n.param("不存在").is_none());

        n.set_param("半径", 20.0.into());
        assert_eq!(n.param("半径"), Some(&ParamValue::Number(20.0)), "重复写应当覆盖");
    }
}
