//! 关键帧数据模型。字段名即契约，与 `src/types/keyframe.ts` 一致。

use serde::{Deserialize, Serialize};

/// 缓动预设，序列化名与前端 `EasingPreset` 一致（kebab-case）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EasingPreset {
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
    Bounce,
    Elastic,
    /// 表达式缓动等前端自定义值：后端烘关键帧时按线性处理（曲线预览在前端）
    #[serde(other)]
    Custom,
}

impl EasingPreset {
    /// 中文名，供历史与提示文案使用。
    pub fn label(self) -> &'static str {
        match self {
            EasingPreset::Linear => "线性",
            EasingPreset::EaseIn => "缓入",
            EasingPreset::EaseOut => "缓出",
            EasingPreset::EaseInOut => "缓入缓出",
            EasingPreset::Bounce => "回弹",
            EasingPreset::Elastic => "弹性",
            EasingPreset::Custom => "自定义",
        }
    }
}

/// 贝塞尔手柄：`x` 是归一化时间，`y` 是值。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tangent {
    pub x: f64,
    pub y: f64,
}

impl Tangent {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

/// 一个关键帧。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe {
    pub id: String,
    /// 片段 id 或节点 id，两者共用
    pub target_id: String,
    pub param: String,
    pub time_ms: f64,
    pub value: f64,
    pub easing: EasingPreset,
    pub in_tangent: Tangent,
    pub out_tangent: Tangent,
}

/// 一条曲线：某目标某参数上的全部关键帧，按 timeMs 升序。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Curve {
    pub target_id: String,
    pub param: String,
    pub keyframes: Vec<Keyframe>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_presets() -> [EasingPreset; 6] {
        [
            EasingPreset::Linear,
            EasingPreset::EaseIn,
            EasingPreset::EaseOut,
            EasingPreset::EaseInOut,
            EasingPreset::Bounce,
            EasingPreset::Elastic,
        ]
    }

    /// 六个缓动预设的序列化名必须与前端 `src/types/keyframe.ts` 的
    /// `EasingPreset` 联合类型逐字一致——这是跨端契约，改了会静默失配。
    #[test]
    fn easing_presets_match_frontend_names() {
        let expected = [
            (EasingPreset::Linear, "linear"),
            (EasingPreset::EaseIn, "ease-in"),
            (EasingPreset::EaseOut, "ease-out"),
            (EasingPreset::EaseInOut, "ease-in-out"),
            (EasingPreset::Bounce, "bounce"),
            (EasingPreset::Elastic, "elastic"),
        ];
        for (preset, name) in expected {
            let json = serde_json::to_string(&preset).unwrap();
            assert_eq!(json, format!("\"{name}\""), "缓动预设序列化名必须与前端一致");
            let back: EasingPreset = serde_json::from_str(&json).unwrap();
            assert_eq!(back, preset, "序列化往返应当还原同一个预设");
        }
    }

    /// 界面全中文：每个预设的中文名都必须非空、不含英文字母。
    #[test]
    fn easing_preset_labels_are_chinese() {
        for preset in all_presets() {
            let label = preset.label();
            assert!(!label.is_empty(), "预设中文名不能为空");
            assert!(
                !label.chars().any(|c| c.is_ascii_alphabetic()),
                "预设中文名不应含英文字母：{label}"
            );
        }
    }

    /// 关键帧字段必须按 camelCase 序列化，与前端 `Keyframe` 接口一致。
    #[test]
    fn keyframe_serializes_with_camel_case_fields() {
        let kf = Keyframe {
            id: "k1".into(),
            target_id: "n1".into(),
            param: "opacity".into(),
            time_ms: 1000.0,
            value: 50.0,
            easing: EasingPreset::Linear,
            in_tangent: Tangent::new(0.0, 0.0),
            out_tangent: Tangent::new(1.0, 1.0),
        };
        let v: serde_json::Value = serde_json::to_value(&kf).unwrap();
        for key in ["targetId", "timeMs", "inTangent", "outTangent", "easing", "value"] {
            assert!(v.get(key).is_some(), "关键帧字段 {key} 应当以 camelCase 序列化");
        }
        assert!(v.get("time_ms").is_none(), "不应出现 snake_case 字段名");
    }
}
