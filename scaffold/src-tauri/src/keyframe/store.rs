//! 关键帧仓库。按「目标 + 参数」分组保存曲线，剪辑层与合成层共用。

use std::collections::HashMap;

use crate::graph::node::{Graph, ParamValue};
use crate::keyframe::curve::{evaluate_curve, upsert_keyframe};
use crate::keyframe::model::{Curve, EasingPreset, Keyframe, Tangent};
use crate::project::serialize::new_id;

/// 默认关键帧合并容差，与前端 `upsertKeyframe` 的 1ms 对齐。
const TOLERANCE_MS: f64 = 1.0;

type CurveKey = (String, String);

/// 关键帧仓库。
#[derive(Debug, Default, Clone)]
pub struct KeyframeStore {
    /// (target_id, param) -> 升序关键帧
    curves: HashMap<CurveKey, Vec<Keyframe>>,
}

impl KeyframeStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 清空全部曲线。
    pub fn clear(&mut self) {
        self.curves.clear();
    }

    /// 用一批曲线整体替换当前内容（撤销 / 重做回填用）。
    pub fn load_curves(&mut self, curves: Vec<Curve>) {
        self.curves.clear();
        for curve in curves {
            if curve.keyframes.is_empty() {
                continue;
            }
            self.curves
                .insert((curve.target_id, curve.param), curve.keyframes);
        }
    }

    /// 取某条曲线。
    pub fn keyframes(&self, target_id: &str, param: &str) -> Option<&[Keyframe]> {
        self.curves
            .get(&(target_id.to_string(), param.to_string()))
            .map(|v| v.as_slice())
    }

    /// 求某时刻的参数值。
    pub fn evaluate(&self, target_id: &str, param: &str, time_ms: f64) -> Option<f64> {
        self.keyframes(target_id, param)
            .and_then(|kfs| evaluate_curve(kfs, time_ms))
    }

    /// 在某时刻打一个关键帧；已存在则覆盖。返回落定的那一帧。
    pub fn set_keyframe(
        &mut self,
        target_id: &str,
        param: &str,
        time_ms: f64,
        value: f64,
        easing: EasingPreset,
    ) -> Keyframe {
        let next = Keyframe {
            id: new_id("kf"),
            target_id: target_id.to_string(),
            param: param.to_string(),
            time_ms,
            value,
            easing,
            in_tangent: Tangent::new(0.0, 0.0),
            out_tangent: Tangent::new(0.0, 0.0),
        };
        let entry = self
            .curves
            .entry((target_id.to_string(), param.to_string()))
            .or_default();
        let merged = upsert_keyframe(std::mem::take(entry), next.clone(), TOLERANCE_MS);
        // 返回真正落定的那一帧（覆盖时 id 是旧帧的）
        let settled = merged
            .iter()
            .find(|k| (k.time_ms - time_ms).abs() <= TOLERANCE_MS && k.param == param)
            .cloned()
            .unwrap_or(next);
        *entry = merged;
        settled
    }

    /// 按 id 删除关键帧。
    pub fn remove(&mut self, keyframe_id: &str) -> bool {
        if let Some((key, idx)) = self.locate(keyframe_id) {
            if let Some(list) = self.curves.get_mut(&key) {
                list.remove(idx);
                if list.is_empty() {
                    self.curves.remove(&key);
                }
            }
            return true;
        }
        false
    }

    /// 移动关键帧的时间与值。
    pub fn move_keyframe(&mut self, keyframe_id: &str, time_ms: f64, value: f64) -> bool {
        let Some((key, idx)) = self.locate(keyframe_id) else {
            return false;
        };
        let Some(list) = self.curves.get_mut(&key) else {
            return false;
        };
        list[idx].time_ms = time_ms;
        list[idx].value = value;
        list.sort_by(|a, b| a.time_ms.partial_cmp(&b.time_ms).unwrap_or(std::cmp::Ordering::Equal));
        true
    }

    /// 调整某一侧贝塞尔手柄。`side_in` 为真表示入切线。
    pub fn set_tangent(&mut self, keyframe_id: &str, side_in: bool, x: f64, y: f64) -> bool {
        let Some((key, idx)) = self.locate(keyframe_id) else {
            return false;
        };
        let Some(list) = self.curves.get_mut(&key) else {
            return false;
        };
        let tangent = Tangent::new(x, y);
        if side_in {
            list[idx].in_tangent = tangent;
        } else {
            list[idx].out_tangent = tangent;
        }
        true
    }

    /// 套用缓动预设。
    pub fn set_easing(&mut self, keyframe_id: &str, preset: EasingPreset) -> bool {
        let Some((key, idx)) = self.locate(keyframe_id) else {
            return false;
        };
        let Some(list) = self.curves.get_mut(&key) else {
            return false;
        };
        list[idx].easing = preset;
        true
    }

    /// 某目标上是否有任何关键帧，用于节点标题栏的小圆点。
    pub fn is_animated(&self, target_id: &str) -> bool {
        self.curves.keys().any(|(t, _)| t == target_id)
    }

    /// 某目标的全部曲线。
    pub fn curves_for(&self, target_id: &str) -> Vec<Curve> {
        self.curves
            .iter()
            .filter(|((t, _), _)| t == target_id)
            .map(|((target_id, param), keyframes)| Curve {
                target_id: target_id.clone(),
                param: param.clone(),
                keyframes: keyframes.clone(),
            })
            .collect()
    }

    /// 导出全部曲线。
    pub fn curves(&self) -> Vec<Curve> {
        self.curves
            .iter()
            .map(|((target_id, param), keyframes)| Curve {
                target_id: target_id.clone(),
                param: param.clone(),
                keyframes: keyframes.clone(),
            })
            .collect()
    }

    /// 把一张图上各节点的参数，按 `time_ms` 的关键帧取值覆盖上去。
    ///
    /// 库里存的是曲线，合成要的是某一帧确定的取值，中间靠这一步把曲线「烘」成参数。
    /// 渲染链路在算缓存指纹之前调它，参数一动指纹就变，旧画面不会被误命中。
    /// 返回被覆盖的参数条数（0 表示这张图上没有任何动画）。
    ///
    /// 目标 id 不是这张图里的节点时自动跳过——片段与节点共用一套曲线，各认领各的。
    pub fn bake_graph(&self, graph: &mut Graph, time_ms: f64) -> usize {
        // 先求值再改图，避免「边遍历仓库边借图」的借用冲突。
        let resolved: Vec<(String, String, f64)> = self
            .curves
            .iter()
            .filter_map(|((target_id, param), keyframes)| {
                evaluate_curve(keyframes, time_ms).map(|v| (target_id.clone(), param.clone(), v))
            })
            .collect();

        let mut baked = 0;
        for (target_id, param, value) in resolved {
            if let Some(node) = graph.node_mut(&target_id) {
                node.set_param(&param, ParamValue::Number(value));
                baked += 1;
            }
        }
        baked
    }

    /// 按关键帧 id 定位到 (曲线键, 下标)。
    fn locate(&self, keyframe_id: &str) -> Option<(CurveKey, usize)> {
        for (key, list) in self.curves.iter() {
            if let Some(idx) = list.iter().position(|k| k.id == keyframe_id) {
                return Some((key.clone(), idx));
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-4
    }

    /// 打过关键帧之后就能按时刻求值。
    #[test]
    fn set_then_evaluate_interpolates() {
        let mut store = KeyframeStore::new();
        store.set_keyframe("n1", "opacity", 0.0, 0.0, EasingPreset::Linear);
        store.set_keyframe("n1", "opacity", 1000.0, 10.0, EasingPreset::Linear);

        assert!(approx(store.evaluate("n1", "opacity", 500.0).unwrap(), 5.0));
        assert_eq!(store.evaluate("n1", "scale", 500.0), None, "没打过的参数应当返回 None");
        assert_eq!(store.evaluate("n2", "opacity", 500.0), None, "没打过的目标应当返回 None");
    }

    /// 容差内重复打帧应当覆盖，且返回的 id 还是旧帧的（前端靠它保持选中态）。
    #[test]
    fn set_within_tolerance_overwrites_and_keeps_id() {
        let mut store = KeyframeStore::new();
        let first = store.set_keyframe("n1", "opacity", 1000.0, 1.0, EasingPreset::Linear);
        let again = store.set_keyframe("n1", "opacity", 1000.5, 0.25, EasingPreset::Linear);

        assert_eq!(again.id, first.id, "容差内覆盖应当保留旧 id");
        assert_eq!(store.keyframes("n1", "opacity").map(|k| k.len()), Some(1), "不应当新增帧");
        assert!(approx(store.evaluate("n1", "opacity", 1000.0).unwrap(), 0.25));
    }

    /// 不同参数各自成一条曲线，互不干扰。
    #[test]
    fn different_params_are_separate_curves() {
        let mut store = KeyframeStore::new();
        store.set_keyframe("n1", "opacity", 0.0, 0.0, EasingPreset::Linear);
        store.set_keyframe("n1", "scale", 0.0, 1.0, EasingPreset::Linear);

        assert_eq!(store.keyframes("n1", "opacity").map(|k| k.len()), Some(1));
        assert_eq!(store.keyframes("n1", "scale").map(|k| k.len()), Some(1));
        assert!(approx(store.evaluate("n1", "scale", 0.0).unwrap(), 1.0));
    }

    /// is_animated 用于节点标题栏小圆点：有帧为真，删空后为假。
    #[test]
    fn is_animated_reflects_presence() {
        let mut store = KeyframeStore::new();
        assert!(!store.is_animated("n1"), "空仓库不应显示为有动画");

        let kf = store.set_keyframe("n1", "opacity", 0.0, 0.0, EasingPreset::Linear);
        assert!(store.is_animated("n1"));

        assert!(store.remove(&kf.id), "应当能按 id 删除");
        assert!(!store.is_animated("n1"), "删空之后不应再显示为有动画");
        assert!(store.keyframes("n1", "opacity").is_none(), "空曲线应当被整条移除");
    }

    /// 删除不存在的 id 应当返回 false，而不是 panic。
    #[test]
    fn remove_unknown_id_returns_false() {
        let mut store = KeyframeStore::new();
        assert!(!store.remove("kf_does_not_exist"));
    }

    /// 移动关键帧后曲线必须重新保持升序。
    #[test]
    fn move_keyframe_reorders_curve() {
        let mut store = KeyframeStore::new();
        let early = store.set_keyframe("n1", "opacity", 0.0, 0.0, EasingPreset::Linear);
        store.set_keyframe("n1", "opacity", 1000.0, 10.0, EasingPreset::Linear);

        assert!(store.move_keyframe(&early.id, 3000.0, 7.0), "移动应当成功");
        let kfs = store.keyframes("n1", "opacity").unwrap();
        assert!(approx(kfs[0].time_ms, 1000.0), "移动后应当升序：{kfs:?}");
        assert!(approx(kfs[1].time_ms, 3000.0));
        assert!(approx(kfs[1].value, 7.0), "移动时应当同时更新值");
        assert!(!store.move_keyframe("kf_missing", 0.0, 0.0), "未知 id 应当返回 false");
    }

    /// 调整某一侧贝塞尔手柄只改对应那一侧。
    #[test]
    fn set_tangent_updates_only_requested_side() {
        let mut store = KeyframeStore::new();
        let kf = store.set_keyframe("n1", "opacity", 0.0, 0.0, EasingPreset::Linear);

        assert!(store.set_tangent(&kf.id, true, 0.25, 0.75));
        let stored = &store.keyframes("n1", "opacity").unwrap()[0];
        assert!(approx(stored.in_tangent.x, 0.25) && approx(stored.in_tangent.y, 0.75));
        assert!(approx(stored.out_tangent.x, 0.0) && approx(stored.out_tangent.y, 0.0),
                "没改的一侧应当保持原样");
        assert!(!store.set_tangent("kf_missing", false, 1.0, 1.0), "未知 id 应当返回 false");
    }

    /// 套用缓动预设应当真的改变求值手感。
    #[test]
    fn set_easing_changes_interpolation() {
        let mut store = KeyframeStore::new();
        let a = store.set_keyframe("n1", "opacity", 0.0, 0.0, EasingPreset::Linear);
        store.set_keyframe("n1", "opacity", 1000.0, 10.0, EasingPreset::Linear);
        let linear_mid = store.evaluate("n1", "opacity", 500.0).unwrap();

        assert!(store.set_easing(&a.id, EasingPreset::EaseIn), "套用缓动应当成功");
        let eased_mid = store.evaluate("n1", "opacity", 500.0).unwrap();
        assert!(eased_mid < linear_mid, "缓入的段中点应当小于线性中点：{eased_mid} vs {linear_mid}");
        assert!(!store.set_easing("kf_missing", EasingPreset::EaseOut), "未知 id 应当返回 false");
    }

    /// curves_for 只返回该目标的曲线。
    #[test]
    fn curves_for_filters_by_target() {
        let mut store = KeyframeStore::new();
        store.set_keyframe("n1", "opacity", 0.0, 0.0, EasingPreset::Linear);
        store.set_keyframe("n1", "scale", 0.0, 1.0, EasingPreset::Linear);
        store.set_keyframe("n2", "opacity", 0.0, 0.0, EasingPreset::Linear);

        let n1 = store.curves_for("n1");
        assert_eq!(n1.len(), 2, "n1 应当有两条曲线");
        assert!(n1.iter().all(|c| c.target_id == "n1"), "不应混入其他目标的曲线");
        assert_eq!(store.curves().len(), 3, "导出全部曲线应当覆盖三个目标参数组合");
    }

    /// 清空之后一切都回到初始状态。
    #[test]
    fn clear_empties_everything() {
        let mut store = KeyframeStore::new();
        store.set_keyframe("n1", "opacity", 0.0, 0.0, EasingPreset::Linear);
        store.clear();
        assert!(!store.is_animated("n1"));
        assert!(store.curves().is_empty());
    }

    /// load_curves 用快照整体替换，且跳过空曲线。
    #[test]
    fn load_curves_replaces_and_skips_empty() {
        let mut store = KeyframeStore::new();
        store.set_keyframe("old", "opacity", 0.0, 0.0, EasingPreset::Linear);

        let snapshot = vec![
            Curve {
                target_id: "n1".into(),
                param: "opacity".into(),
                keyframes: vec![Keyframe {
                    id: "k1".into(),
                    target_id: "n1".into(),
                    param: "opacity".into(),
                    time_ms: 0.0,
                    value: 1.0,
                    easing: EasingPreset::Linear,
                    in_tangent: Tangent::new(0.0, 0.0),
                    out_tangent: Tangent::new(0.0, 0.0),
                }],
            },
            Curve {
                target_id: "n2".into(),
                param: "scale".into(),
                keyframes: Vec::new(),
            },
        ];
        store.load_curves(snapshot);

        assert!(!store.is_animated("old"), "替换后旧曲线应当消失");
        assert_eq!(store.keyframes("n1", "opacity").map(|k| k.len()), Some(1));
        assert!(store.keyframes("n2", "scale").is_none(), "空曲线不应被装入");
    }

    /// 烘入：图上被打了关键帧的节点参数，按时刻取到应得的中间值。
    #[test]
    fn bake_graph_writes_interpolated_values() {
        let mut store = KeyframeStore::new();
        let mut graph = Graph {
            id: "g".into(),
            nodes: vec![graph_node("n1", "grade")],
            connections: Vec::new(),
            parent_node_id: None,
        };
        store.set_keyframe("n1", "contrast", 0.0, 0.0, EasingPreset::Linear);
        store.set_keyframe("n1", "contrast", 1000.0, 100.0, EasingPreset::Linear);

        let baked = store.bake_graph(&mut graph, 500.0);
        assert_eq!(baked, 1, "只有一条曲线落在图上");
        match graph.node("n1").unwrap().param("contrast") {
            Some(ParamValue::Number(v)) => assert!(approx(*v, 50.0), "中点应当是 50：{v}"),
            other => panic!("应当是数值参数，实际为 {other:?}"),
        }
    }

    /// 目标不在图上时跳过，返回 0，绝不能凭空造节点。
    #[test]
    fn bake_graph_ignores_foreign_targets() {
        let mut store = KeyframeStore::new();
        store.set_keyframe("clip-1", "opacity", 0.0, 0.0, EasingPreset::Linear);

        let mut graph = Graph {
            id: "g".into(),
            nodes: vec![graph_node("n1", "grade")],
            connections: Vec::new(),
            parent_node_id: None,
        };
        assert_eq!(store.bake_graph(&mut graph, 0.0), 0);
        assert_eq!(graph.nodes.len(), 1, "不应新增节点");
        assert!(graph.node("n1").unwrap().param("opacity").is_none());
    }

    /// 空仓库烘入是空操作，不会污染参数。
    #[test]
    fn bake_graph_without_curves_is_noop() {
        let store = KeyframeStore::new();
        let mut graph = Graph {
            id: "g".into(),
            nodes: vec![graph_node("n1", "grade")],
            connections: Vec::new(),
            parent_node_id: None,
        };
        assert_eq!(store.bake_graph(&mut graph, 123.0), 0);
        assert!(graph.nodes[0].params.is_empty());
    }

    /// 测试用最小节点。
    fn graph_node(id: &str, node_type: &str) -> crate::graph::node::GraphNode {
        crate::graph::node::GraphNode {
            id: id.to_string(),
            node_type: node_type.to_string(),
            name: node_type.to_string(),
            x: 0.0,
            y: 0.0,
            params: HashMap::new(),
            bypassed: false,
            collapsed: false,
            animated: false,
            inputs: Vec::new(),
            outputs: Vec::new(),
        }
    }
}
