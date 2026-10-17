//! 节点类型注册表（后端侧）。
//!
//! 与前端 `src/core/nodeCatalog.ts` 保持同一份内容：前端在没接后端时也留了一份，
//! 接上后端后按 `type` 合并。范围严格照 `docs/02-功能规格.md` 第 D3 节的首版效果
//! 清单——输入 / 变换 / 颜色 / 滤镜 / 抠像 / 蒙版 / 粒子 / 合成 / 输出 九类，共 27 个效果
//! （含不透明度与输出），再补上三个非效果节点：3D 合成、摄像机、复合片段。
//!
//! **没有液态 / 流体这一回事**——那是早期把一次语音识别错误当成需求，现已彻底删除，
//! 见 docs/10 第〇节。这里不得再出现液态相关节点。
//!
//! 前端 `effectCatalog.ts` 里记着每个参数的取值范围（min / max / step），那只用于
//! 界面数值框；后端这里只保留「参数名 → 默认值」，两边键名与默认值一一对应。
//!
//! 摄像机单独成类，参数照 `docs/09-3D摄像机与素材库.md` 第 2.3 节的表格。

use std::collections::HashMap;

use serde::Serialize;

use crate::graph::node::{plug, plug_3d, GraphNode, ParamValue, Plug, PlugDataType};
use crate::project::serialize::new_id;

/// 注册表里的一条。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeTypeInfo {
    /// 类型键
    #[serde(rename = "type")]
    pub node_type: String,
    /// 中文名
    pub label: String,
    /// 中文分类
    pub category: String,
    pub inputs: Vec<Plug>,
    pub outputs: Vec<Plug>,
    /// 参数默认值
    pub defaults: HashMap<String, ParamValue>,
}

fn defaults(pairs: &[(&str, ParamValue)]) -> HashMap<String, ParamValue> {
    let mut map = HashMap::new();
    for (k, v) in pairs {
        map.insert((*k).to_string(), v.clone());
    }
    map
}

/// 常用插槽简写。
fn in_plug() -> Plug {
    plug("in", "输入", PlugDataType::Image, false)
}

fn out_plug() -> Plug {
    plug("out", "输出", PlugDataType::Image, false)
}

/// 生成器类节点的「画面」输出。
fn out_frame() -> Plug {
    plug("out", "画面", PlugDataType::Image, false)
}

/// 造一条效果节点：一进一出（图里用，效果栈界面不显示连线）。
fn filter_node(
    node_type: &str,
    label: &str,
    category: &str,
    pairs: &[(&str, ParamValue)],
) -> NodeTypeInfo {
    NodeTypeInfo {
        node_type: node_type.into(),
        label: label.into(),
        category: category.into(),
        inputs: vec![in_plug()],
        outputs: vec![out_plug()],
        defaults: defaults(pairs),
    }
}

/// 摄像机参数默认值，严格照抄 docs/09 第 2.3 节。
fn camera_defaults() -> HashMap<String, ParamValue> {
    defaults(&[
        ("posX", ParamValue::Number(0.0)),
        ("posY", ParamValue::Number(0.0)),
        ("posZ", ParamValue::Number(-1000.0)),
        ("targetX", ParamValue::Number(0.0)),
        ("targetY", ParamValue::Number(0.0)),
        ("targetZ", ParamValue::Number(0.0)),
        ("focalLength", ParamValue::Number(50.0)),
        ("orientationMode", ParamValue::from("twoNode")),
        ("depthOfField", ParamValue::Bool(false)),
        ("aperture", ParamValue::Number(5.6)),
        ("focusDistance", ParamValue::Number(1000.0)),
        ("blurLevel", ParamValue::Number(1.0)),
        ("motionBlur", ParamValue::Bool(false)),
        ("shutterAngle", ParamValue::Number(180.0)),
        ("viewPreset", ParamValue::from("active")),
    ])
}

/// 全部内置节点类型。
pub fn node_catalog() -> Vec<NodeTypeInfo> {
    vec![
        // ---- 输入 / 生成 ----
        NodeTypeInfo {
            node_type: "sequence".into(),
            label: "序列".into(),
            category: "输入".into(),
            inputs: vec![in_plug()],
            outputs: vec![out_plug()],
            defaults: HashMap::new(),
        },
        NodeTypeInfo {
            node_type: "clip".into(),
            label: "片段".into(),
            category: "输入".into(),
            inputs: vec![],
            outputs: vec![out_frame()],
            defaults: defaults(&[("opacity", ParamValue::Number(100.0))]),
        },
        NodeTypeInfo {
            node_type: "color".into(),
            label: "颜色".into(),
            category: "输入".into(),
            inputs: vec![],
            outputs: vec![out_frame()],
            defaults: defaults(&[
                ("color", ParamValue::from("#FFFFFF")),
                ("opacity", ParamValue::Number(100.0)),
            ]),
        },
        NodeTypeInfo {
            node_type: "text".into(),
            label: "文字".into(),
            category: "输入".into(),
            inputs: vec![],
            outputs: vec![out_frame()],
            defaults: defaults(&[
                ("text", ParamValue::from("文字")),
                ("fontSize", ParamValue::Number(72.0)),
                ("color", ParamValue::from("#FFFFFF")),
                ("align", ParamValue::from("center")),
                ("opacity", ParamValue::Number(100.0)),
            ]),
        },
        NodeTypeInfo {
            node_type: "image".into(),
            label: "图片".into(),
            category: "输入".into(),
            inputs: vec![],
            outputs: vec![out_frame()],
            defaults: defaults(&[
                ("source", ParamValue::from("")),
                ("opacity", ParamValue::Number(100.0)),
            ]),
        },
        // ---- 变换 ----
        filter_node(
            "transform",
            "变换",
            "变换",
            &[
                ("posX", ParamValue::Number(0.0)),
                ("posY", ParamValue::Number(0.0)),
                ("scale", ParamValue::Number(100.0)),
                ("rotation", ParamValue::Number(0.0)),
                ("anchorX", ParamValue::Number(0.0)),
                ("anchorY", ParamValue::Number(0.0)),
                ("skew", ParamValue::Number(0.0)),
            ],
        ),
        filter_node(
            "crop",
            "裁剪",
            "变换",
            &[
                ("top", ParamValue::Number(0.0)),
                ("bottom", ParamValue::Number(0.0)),
                ("left", ParamValue::Number(0.0)),
                ("right", ParamValue::Number(0.0)),
            ],
        ),
        filter_node("mirror", "镜像", "变换", &[("mode", ParamValue::from("horizontal"))]),
        // ---- 颜色 ----
        filter_node(
            "grade",
            "调色",
            "颜色",
            &[
                ("exposure", ParamValue::Number(0.0)),
                ("contrast", ParamValue::Number(0.0)),
                ("saturation", ParamValue::Number(0.0)),
                ("temperature", ParamValue::Number(0.0)),
                ("tint", ParamValue::Number(0.0)),
                ("highlights", ParamValue::Number(0.0)),
                ("shadows", ParamValue::Number(0.0)),
            ],
        ),
        filter_node(
            "curves",
            "曲线",
            "颜色",
            &[
                ("channel", ParamValue::from("rgb")),
                ("strength", ParamValue::Number(100.0)),
            ],
        ),
        filter_node(
            "lut",
            "LUT",
            "颜色",
            &[
                ("file", ParamValue::from("")),
                ("strength", ParamValue::Number(100.0)),
            ],
        ),
        filter_node(
            "keyer",
            "色度抠图",
            "抠像",
            &[
                ("keyColor", ParamValue::from("#00FF00")),
                ("tolerance", ParamValue::Number(20.0)),
                ("feather", ParamValue::Number(4.0)),
                ("spill", ParamValue::Number(30.0)),
                ("edge", ParamValue::Number(0.0)),
                ("view", ParamValue::from("result")),
            ],
        ),
        filter_node(
            "mono",
            "单色",
            "颜色",
            &[
                ("grayscale", ParamValue::Bool(true)),
                ("hue", ParamValue::Number(0.0)),
                ("strength", ParamValue::Number(100.0)),
            ],
        ),
        // ---- 滤镜 ----
        filter_node(
            "blur",
            "模糊",
            "滤镜",
            &[
                ("radius", ParamValue::Number(12.0)),
                ("type", ParamValue::from("gaussian")),
            ],
        ),
        filter_node(
            "sharpen",
            "锐化",
            "滤镜",
            &[
                ("strength", ParamValue::Number(50.0)),
                ("radius", ParamValue::Number(3.0)),
            ],
        ),
        filter_node(
            "glow",
            "发光",
            "滤镜",
            &[
                ("threshold", ParamValue::Number(70.0)),
                ("radius", ParamValue::Number(24.0)),
                ("strength", ParamValue::Number(60.0)),
            ],
        ),
        filter_node(
            "noise",
            "噪点",
            "滤镜",
            &[
                ("strength", ParamValue::Number(20.0)),
                ("scale", ParamValue::Number(1.0)),
                ("speed", ParamValue::Number(0.0)),
            ],
        ),
        filter_node("mosaic", "马赛克", "滤镜", &[("blockSize", ParamValue::Number(16.0))]),
        // ---- 合成 / 图层 ----
        NodeTypeInfo {
            node_type: "blend".into(),
            label: "混合".into(),
            category: "合成".into(),
            inputs: vec![
                plug("base", "下层", PlugDataType::Image, false),
                plug("top", "上层", PlugDataType::Image, false),
            ],
            outputs: vec![out_plug()],
            defaults: defaults(&[
                ("mode", ParamValue::from("normal")),
                ("opacity", ParamValue::Number(100.0)),
            ]),
        },
        NodeTypeInfo {
            node_type: "mask".into(),
            label: "遮罩".into(),
            category: "合成".into(),
            inputs: vec![in_plug(), plug("mask", "遮罩", PlugDataType::Mask, false)],
            outputs: vec![out_plug()],
            defaults: defaults(&[
                ("invert", ParamValue::Bool(false)),
                ("feather", ParamValue::Number(0.0)),
            ]),
        },
        NodeTypeInfo {
            node_type: "merge".into(),
            label: "合并".into(),
            category: "合成".into(),
            inputs: vec![
                plug("in1", "输入 1", PlugDataType::Image, false),
                plug("in2", "输入 2", PlugDataType::Image, false),
            ],
            outputs: vec![out_plug()],
            defaults: defaults(&[("mode", ParamValue::from("add"))]),
        },
        filter_node(
            "opacity",
            "不透明度",
            "合成",
            &[("opacity", ParamValue::Number(100.0))],
        ),
        NodeTypeInfo {
            node_type: "composite3d".into(),
            label: "3D 合成".into(),
            category: "合成".into(),
            // 输入来自勾选了「启用 3D」的图层节点，插槽带 is3D 标记
            inputs: vec![
                plug_3d("layer1", "3D 图层 1", PlugDataType::Image),
                plug_3d("layer2", "3D 图层 2", PlugDataType::Image),
                plug_3d("layer3", "3D 图层 3", PlugDataType::Image),
            ],
            outputs: vec![plug("out", "3D 场景", PlugDataType::Image, false)],
            defaults: defaults(&[("zSort", ParamValue::Bool(true))]),
        },
        NodeTypeInfo {
            node_type: "compound".into(),
            label: "复合片段".into(),
            category: "合成".into(),
            inputs: vec![in_plug()],
            outputs: vec![out_plug()],
            defaults: HashMap::new(),
        },
        // ---- 蒙版 / 形状遮罩（用户点名要，不准少）----
        filter_node(
            "maskShape",
            "形状蒙版",
            "蒙版",
            &[
                ("shape", ParamValue::from("rect")),
                ("centerX", ParamValue::Number(50.0)),
                ("centerY", ParamValue::Number(50.0)),
                ("width", ParamValue::Number(60.0)),
                ("height", ParamValue::Number(60.0)),
                ("roundness", ParamValue::Number(0.0)),
                ("rotation", ParamValue::Number(0.0)),
                ("feather", ParamValue::Number(0.0)),
                ("invert", ParamValue::Bool(false)),
            ],
        ),
        filter_node(
            "maskPen",
            "钢笔蒙版",
            "蒙版",
            &[
                ("shape", ParamValue::from("pen")),
                ("points", ParamValue::Number(6.0)),
                ("centerX", ParamValue::Number(50.0)),
                ("centerY", ParamValue::Number(50.0)),
                ("width", ParamValue::Number(60.0)),
                ("height", ParamValue::Number(60.0)),
                ("roundness", ParamValue::Number(0.0)),
                ("rotation", ParamValue::Number(0.0)),
                ("feather", ParamValue::Number(0.0)),
                ("invert", ParamValue::Bool(false)),
            ],
        ),
        filter_node(
            "maskTrack",
            "蒙版跟踪",
            "蒙版",
            &[
                ("shape", ParamValue::from("track")),
                ("trackId", ParamValue::from("")),
                ("centerX", ParamValue::Number(50.0)),
                ("centerY", ParamValue::Number(50.0)),
                ("width", ParamValue::Number(60.0)),
                ("height", ParamValue::Number(60.0)),
                ("roundness", ParamValue::Number(0.0)),
                ("rotation", ParamValue::Number(0.0)),
                ("feather", ParamValue::Number(0.0)),
                ("invert", ParamValue::Bool(false)),
            ],
        ),
        // ---- 粒子系统（用户点名要，不准少）----
        filter_node(
            "particles",
            "粒子系统",
            "粒子",
            &[
                ("emitter", ParamValue::from("point")),
                ("rate", ParamValue::Number(60.0)),
                ("lifetime", ParamValue::Number(2.0)),
                ("speed", ParamValue::Number(120.0)),
                ("direction", ParamValue::Number(90.0)),
                ("spread", ParamValue::Number(30.0)),
                ("gravity", ParamValue::Number(200.0)),
                ("drag", ParamValue::Number(0.0)),
                ("turbulence", ParamValue::Number(0.0)),
                ("sizeStart", ParamValue::Number(20.0)),
                ("sizeEnd", ParamValue::Number(0.0)),
                ("opacityEnd", ParamValue::Number(0.0)),
                ("color", ParamValue::from("#57c08f")),
                ("blendMode", ParamValue::from("normal")),
                ("maxParticles", ParamValue::Number(1000.0)),
                ("texture", ParamValue::from("")),
            ],
        ),
        // ---- 3D ----
        NodeTypeInfo {
            node_type: "camera".into(),
            label: "摄像机".into(),
            category: "摄像机".into(),
            inputs: vec![plug("scene", "3D 场景", PlugDataType::Image, false)],
            outputs: vec![out_frame()],
            defaults: camera_defaults(),
        },
        // ---- 输出 ----
        NodeTypeInfo {
            node_type: "output".into(),
            label: "输出".into(),
            category: "输出".into(),
            inputs: vec![in_plug()],
            outputs: vec![],
            defaults: HashMap::new(),
        },
    ]
}

/// 按类型取注册信息。
pub fn node_type_info(node_type: &str) -> Option<NodeTypeInfo> {
    node_catalog().into_iter().find(|info| info.node_type == node_type)
}

/// 按类型造一个新节点；类型不认识时返回 None。
pub fn create_node(node_type: &str, x: f64, y: f64) -> Option<GraphNode> {
    let info = node_type_info(node_type)?;
    Some(GraphNode {
        id: new_id("node"),
        node_type: info.node_type.clone(),
        name: info.label.clone(),
        x,
        y,
        params: info.defaults.clone(),
        bypassed: false,
        collapsed: false,
        animated: false,
        inputs: info.inputs.clone(),
        outputs: info.outputs.clone(),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn catalog_types_are_unique_with_chinese_labels() {
        let catalog = node_catalog();
        let mut seen: HashSet<String> = HashSet::new();
        for info in &catalog {
            assert!(
                seen.insert(info.node_type.clone()),
                "节点类型重复：{}",
                info.node_type
            );
            assert!(!info.label.is_empty(), "「{}」缺中文名", info.node_type);
            assert!(!info.category.is_empty(), "「{}」缺中文分类", info.node_type);
            assert!(
                !info.label.chars().any(|c| c.is_ascii_lowercase()),
                "「{}」的名字不该含英文小写（漏翻？）：{}",
                info.node_type,
                info.label
            );
            assert!(
                !info.category.chars().any(|c| c.is_ascii_lowercase()),
                "「{}」的分类不该含英文小写（漏翻？）：{}",
                info.node_type,
                info.category
            );
        }
    }

    #[test]
    fn catalog_covers_the_first_batch_effect_list() {
        let types: HashSet<String> = node_catalog().into_iter().map(|i| i.node_type).collect();
        // docs/02 第 D3 节的首版清单：输入 / 变换 / 颜色 / 滤镜 / 抠像 / 蒙版 /
        // 粒子 / 合成 / 输出 九类，共 27 个（含不透明度与输出）。
        for t in [
            "sequence", "clip", "color", "text", "image", "transform", "crop", "mirror",
            "grade", "curves", "lut", "mono", "blur", "sharpen", "glow", "noise", "mosaic",
            "keyer", "mask", "maskShape", "maskPen", "maskTrack", "particles", "blend",
            "merge", "opacity", "output",
        ] {
            assert!(types.contains(t), "首版效果清单里的「{t}」不在节点目录里");
        }
    }

    #[test]
    fn every_plug_has_unique_key_and_chinese_label() {
        for info in node_catalog() {
            // 输出节点是终点，允许没有输出插槽；其余节点必须有出口。
            if info.node_type != "output" {
                assert!(
                    !info.outputs.is_empty(),
                    "「{}」不是输出节点却没有任何输出插槽",
                    info.node_type
                );
            }
            let mut keys: HashSet<String> = HashSet::new();
            for p in info.inputs.iter().chain(info.outputs.iter()) {
                assert!(
                    keys.insert(p.key.clone()),
                    "「{}」有重名插槽 {}",
                    info.node_type,
                    p.key
                );
                assert!(
                    !p.label.is_empty(),
                    "「{}」的插槽 {} 缺中文名",
                    info.node_type,
                    p.key
                );
            }
        }
    }

    #[test]
    fn create_node_copies_defaults_and_rejects_unknown() {
        let node = create_node("blur", 10.0, 20.0).expect("blur 是已知类型");
        assert_eq!(node.node_type, "blur");
        assert_eq!(
            node.params.get("radius").and_then(|v| v.as_f64()),
            Some(12.0),
            "新节点应当带上注册表里的默认参数"
        );
        assert!(node.inputs.len() == 1 && node.outputs.len() == 1, "效果节点一进一出");
        assert!(
            create_node("no_such_effect", 0.0, 0.0).is_none(),
            "未知类型应当返回 None"
        );
    }

    #[test]
    fn catalog_has_no_liquid_or_fluid_nodes() {
        for info in node_catalog() {
            let t = info.node_type.to_ascii_lowercase();
            assert!(
                !t.contains("liquid") && !t.contains("fluid"),
                "不得出现液态 / 流体节点：{t}"
            );
            assert!(
                !info.label.contains("液态") && !info.label.contains("流体"),
                "不得出现液态 / 流体中文名：{}",
                info.label
            );
        }
    }
}
