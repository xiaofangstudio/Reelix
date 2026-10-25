//! 时间线数据模型。字段名即契约，与 `src/types/project.ts` 一致。
//!
//! 例外：前端字段叫 `enable3D` / `transform3D`，serde 的 `rename_all = "camelCase"`
//! 生成不了带大写 3D 的名字，必须用字段级 `rename` 手写。

use serde::{Deserialize, Serialize};

/// 轨道类型。摄像机轨道承载摄像机节点，见 docs/09 第 2.4 节。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Video,
    Audio,
    Camera,
    /// 字幕轨：片段不带素材，文字存在 `Clip.text` 里
    Subtitle,
}

/// 三维向量：位置 / 旋转共用。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    pub fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    pub const ZERO: Vec3 = Vec3 {
        x: 0.0,
        y: 0.0,
        z: 0.0,
    };
}

/// 二维向量：锚点用，0~1 归一化。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

/// 图层方向：朝向相机自动转向 / 自由朝向（docs/09 第 2.3 节）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Layer3DOrientation {
    Camera,
    Free,
}

/// 图层 3D 变换；仅当 `Clip.enable_3d` 为真时生效。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transform3D {
    pub position: Vec3,
    pub rotation: Vec3,
    pub scale: f64,
    pub orientation: Layer3DOrientation,
    pub anchor: Vec2,
    pub receive_light: bool,
}

impl Default for Transform3D {
    /// 勾选「启用 3D」时的默认变换：老实待在 Z=0 平面。
    fn default() -> Self {
        Self {
            position: Vec3::ZERO,
            rotation: Vec3::ZERO,
            scale: 1.0,
            orientation: Layer3DOrientation::Camera,
            anchor: Vec2::new(0.5, 0.5),
            receive_light: false,
        }
    }
}

/// 曲线变速关键点：片段内时刻 → 速度（剪映式折线，两点之间线性插值）。
///
/// `t_ms` 相对片段起点（0 = 片段头），`speed` 为该点的倍速；
/// 曲线两个端点之外保持端点值，不外推。空曲线 = 恒定 `Clip.speed`。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedKey {
    pub t_ms: f64,
    pub speed: f64,
}

/// 衔接处转场：右片段（incoming）头部与左片段（outgoing）尾部的重叠画法。
///
/// `kind` 取 `"crossDissolve"`（叠化）或 `"dipToBlack"`（黑场过渡）；
/// `duration_ms` 是实际生效的重叠时长——设置时若媒体手柄不足会被收窄，
/// 这里存的是收窄后的值，清除转场时按它精确恢复邻接。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub kind: String,
    pub duration_ms: f64,
}

/// 一个片段。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub asset_id: String,
    pub track_id: String,
    /// 在序列上的起点
    pub start_ms: f64,
    pub duration_ms: f64,
    /// 素材内的入点
    pub in_ms: f64,
    /// 素材内的出点
    pub out_ms: f64,
    pub speed: f64,
    pub reversed: bool,
    /// 曲线变速关键点（片段内时刻 → 速度）；None/空 = 恒定 `speed`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_curve: Option<Vec<SpeedKey>>,
    /// 声音变调（剪映同款开关）：true = 变速时音随速变；false = 保调（默认）
    #[serde(default)]
    pub audio_pitch_shift: bool,
    /// 对应的图节点；剪辑与特效融合的接口
    pub node_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compound_id: Option<String>,
    /// 勾选「启用 3D」后为真
    #[serde(default, rename = "enable3D")]
    pub enable_3d: bool,
    /// 3D 变换属性，未启用 3D 时缺省
    #[serde(default, rename = "transform3D", skip_serializing_if = "Option::is_none")]
    pub transform_3d: Option<Transform3D>,
    /// 字幕文字。只有字幕轨上的片段会用到，普通片段缺省。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 右键「启用」勾选状态；禁用的片段不参与预览与导出（渲染时跳过）
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 右键「标签」颜色名（PR 的低饱和标签色，界面用高饱和渲染），未设置缺省
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// 头部衔接转场；与左片段的重叠窗口内做画面混合（合成器里生效）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_in: Option<Transition>,
    /// 尾部淡出：片段末尾向黑/白渐隐（剪映的「淡出」挂在这里，不是效果栈）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_out: Option<Transition>,
    /// 音频慢入时长（毫秒）；区间内音量从 0 线性升到满，混音时生效
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_fade_in_ms: Option<f64>,
    /// 高通截止频率（Hz）；混音时二阶 biquad 滤掉低频
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_highpass_hz: Option<f64>,
    /// 低通截止频率（Hz）；混音时二阶 biquad 滤掉高频
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_lowpass_hz: Option<f64>,
    /// 延迟回声（毫秒）；混音时叠加一次 0.35 衰减的延迟声
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_delay_ms: Option<f64>,
    /// 音频慢出时长（毫秒）；区间内音量从满线性降到 0，混音时生效
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_fade_out_ms: Option<f64>,
}

fn default_true() -> bool {
    true
}

/// 新序列的默认时长（毫秒）。
///
/// 空工程也给足可用的标尺与播放空间：时长 0 会把播放头夹死在 0、
/// 标尺没有刻度、监视器停在第一帧——用户原话「压根没有办法剪」。
/// 有片段时以最靠后的片段出点为准（见 `recompute_sequence_duration`）。
pub const DEFAULT_SEQUENCE_MS: f64 = 60_000.0;

impl Clip {
    /// 片段的结束时刻。
    pub fn end_ms(&self) -> f64 {
        self.start_ms + self.duration_ms
    }

    /// 片段是否覆盖某一时刻。
    pub fn covers(&self, time_ms: f64) -> bool {
        time_ms >= self.start_ms && time_ms < self.end_ms()
    }

    /// 是否挂了曲线变速（至少两个点才算）。
    pub fn has_speed_curve(&self) -> bool {
        self.speed_curve
            .as_ref()
            .is_some_and(|k| k.len() >= 2)
    }

    /// 生效速度（防 0 / 负）：曲线求值或恒定 speed。
    pub fn base_speed(&self) -> f64 {
        let s = self.speed;
        if s.is_finite() && s.abs() > f64::EPSILON {
            s
        } else {
            1.0
        }
    }

    /// 片段内 `local_ms` 处的瞬时速度（曲线折线插值；无曲线取 base_speed）。
    pub fn speed_at(&self, local_ms: f64) -> f64 {
        let Some(keys) = self.speed_curve.as_ref() else {
            return self.base_speed();
        };
        if keys.is_empty() {
            return self.base_speed();
        }
        // 端头之外保持端点值，不外推
        if local_ms <= keys[0].t_ms {
            return sanitize_speed(keys[0].speed);
        }
        let last = keys[keys.len() - 1];
        if local_ms >= last.t_ms {
            return sanitize_speed(last.speed);
        }
        for pair in keys.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if local_ms >= a.t_ms && local_ms <= b.t_ms {
                let span = b.t_ms - a.t_ms;
                if span <= f64::EPSILON {
                    return sanitize_speed(b.speed);
                }
                let t = (local_ms - a.t_ms) / span;
                return sanitize_speed(a.speed + (b.speed - a.speed) * t);
            }
        }
        self.base_speed()
    }

    /// 片段内 `[0, local_ms]` 在素材里走过的毫秒数（曲线下是速度的积分）。
    ///
    /// 折线速度的积分是分段二次函数，这里按段精确累加，不做数值近似。
    pub fn source_offset(&self, local_ms: f64) -> f64 {
        let local = local_ms.max(0.0);
        let Some(keys) = self.speed_curve.as_ref() else {
            return local * self.base_speed();
        };
        if keys.len() < 2 {
            return local * self.base_speed();
        }
        let mut acc = 0.0;
        for pair in keys.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let sa = sanitize_speed(a.speed);
            let sb = sanitize_speed(b.speed);
            let span = (b.t_ms - a.t_ms).max(0.0);
            if span <= f64::EPSILON {
                continue;
            }
            // 本段里走过的片段内时长（线性速度 → 梯形面积）
            let walked = (local - a.t_ms).clamp(0.0, span);
            let t = walked / span;
            acc += span * t * (sa + (sb - sa) * t * 0.5);
        }
        acc
    }

    /// 曲线下的平均速度（给 EDL / 估算用）：总源长 ÷ 总时长。
    pub fn average_speed(&self) -> f64 {
        if !self.has_speed_curve() {
            return self.base_speed();
        }
        let total = self.source_offset(self.duration_ms);
        if self.duration_ms <= f64::EPSILON {
            return self.base_speed();
        }
        sanitize_speed(total / self.duration_ms)
    }

    /// `source_offset` 的逆函数：走完 `src_ms` 毫秒素材需要多少片段内时长。
    ///
    /// 按段累加，段内解一元二次方程；曲线退化成直线时就是除法和一致。
    pub fn local_for_source(&self, src_ms: f64) -> f64 {
        let target = src_ms.max(0.0);
        let Some(keys) = self.speed_curve.as_ref() else {
            return target / self.base_speed();
        };
        if keys.len() < 2 {
            return target / self.base_speed();
        }
        let mut remaining = target;
        for pair in keys.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let sa = sanitize_speed(a.speed);
            let sb = sanitize_speed(b.speed);
            let span = (b.t_ms - a.t_ms).max(0.0);
            if span <= f64::EPSILON {
                continue;
            }
            let seg_total = span * 0.5 * (sa + sb);
            if remaining <= seg_total || pair[1].t_ms >= keys[keys.len() - 1].t_ms {
                // 段内解 span*t*(sa+(sb-sa)*t/2) = remaining
                let slope = (sb - sa) * 0.5;
                let t = if slope.abs() < 1e-12 {
                    (remaining / (span * sa)).clamp(0.0, 1.0)
                } else {
                    // slope*span*t² + sa*span*t - remaining = 0
                    let c = span * sa;
                    let disc = (c * c + 4.0 * slope * span * remaining).max(0.0);
                    ((-c + disc.sqrt()) / (2.0 * slope * span)).clamp(0.0, 1.0)
                };
                return a.t_ms + span * t;
            }
            remaining -= seg_total;
        }
        self.duration_ms
    }
}

/// 把速度夹到安全范围：必须有限、为正，落在 0.01 ~ 100 之间。
fn sanitize_speed(speed: f64) -> f64 {
    if !speed.is_finite() || speed <= 0.0 {
        return 1.0;
    }
    speed.clamp(0.01, 100.0)
}

/// 一条轨道。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub kind: TrackKind,
    pub index: i32,
    pub muted: bool,
    pub solo: bool,
    pub locked: bool,
    pub hidden: bool,
    pub height: f64,
    pub clips: Vec<Clip>,
}

impl Track {
    /// 按 id 找片段。
    pub fn clip(&self, clip_id: &str) -> Option<&Clip> {
        self.clips.iter().find(|c| c.id == clip_id)
    }

    /// 按 id 找片段（可变）。
    pub fn clip_mut(&mut self, clip_id: &str) -> Option<&mut Clip> {
        self.clips.iter_mut().find(|c| c.id == clip_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn clip(start_ms: f64, duration_ms: f64) -> Clip {
        Clip {
            id: "c1".into(),
            asset_id: "a1".into(),
            track_id: "t1".into(),
            start_ms,
            duration_ms,
            in_ms: 0.0,
            out_ms: duration_ms,
            speed: 1.0,
            reversed: false,
            speed_curve: None,
            audio_pitch_shift: false,
            node_id: "n1".into(),
            compound_id: None,
            enable_3d: false,
            transform_3d: None,
            text: None,
            enabled: true,
            label: None,
            transition_in: None,
            transition_out: None,
            audio_highpass_hz: None,
            audio_lowpass_hz: None,
            audio_delay_ms: None,
            audio_fade_in_ms: None,
            audio_fade_out_ms: None,
        }
    }

    /// 覆盖区间取半开：含起点、不含出点，相邻片段才不会重复计帧。
    #[test]
    fn clip_covers_half_open_range() {
        let c = clip(1000.0, 2000.0);
        assert!((c.end_ms() - 3000.0).abs() < 1e-9, "出点应当是起点加时长");
        assert!(!c.covers(999.0), "起点之前不应覆盖");
        assert!(c.covers(1000.0), "起点应当覆盖（含左端）");
        assert!(c.covers(2999.0), "区间内部应当覆盖");
        assert!(!c.covers(3000.0), "出点不应覆盖（不含右端）");
    }

    /// 勾选「启用 3D」时的默认变换：老实待在 Z=0 平面，缩放 1、锚点居中。
    #[test]
    fn transform_3d_default_is_flat_and_centered() {
        let t = Transform3D::default();
        assert_eq!(t.position, Vec3::ZERO);
        assert_eq!(t.rotation, Vec3::ZERO);
        assert!((t.scale - 1.0).abs() < 1e-9, "默认缩放应为 1");
        assert_eq!(t.orientation, Layer3DOrientation::Camera, "默认朝向相机");
        assert!((t.anchor.x - 0.5).abs() < 1e-9 && (t.anchor.y - 0.5).abs() < 1e-9, "锚点应居中");
        assert!(!t.receive_light, "默认不接收灯光");
    }

    /// 轨道类型的序列化名必须与前端 `TrackKind` 联合类型一致。
    #[test]
    fn track_kind_serializes_camel_case() {
        assert_eq!(serde_json::to_string(&TrackKind::Video).unwrap(), "\"video\"");
        assert_eq!(serde_json::to_string(&TrackKind::Audio).unwrap(), "\"audio\"");
        assert_eq!(serde_json::to_string(&TrackKind::Camera).unwrap(), "\"camera\"");
        assert_eq!(serde_json::to_string(&TrackKind::Subtitle).unwrap(), "\"subtitle\"");
    }

    /// 字幕片段要能带上文字来回序列化，普通片段不写这个字段。
    #[test]
    fn clip_serializes_optional_text() {
        let plain: Value = serde_json::to_value(clip(0.0, 1000.0)).unwrap();
        assert!(plain.get("text").is_none(), "普通片段不应写 text");

        let mut c = clip(0.0, 1000.0);
        c.text = Some("开饭时间".into());
        let v: Value = serde_json::to_value(&c).unwrap();
        assert_eq!(v.get("text").and_then(Value::as_str), Some("开饭时间"));
    }

    /// enable3D / transform3D 带大写 3D，camelCase 生成不了，必须字段级 rename。
    /// 这是跨端契约，写成别的名字前端会静默读不到。
    #[test]
    fn clip_serializes_3d_field_names_for_frontend() {
        let mut c = clip(0.0, 1000.0);
        c.enable_3d = true;
        c.transform_3d = Some(Transform3D::default());
        let v: Value = serde_json::to_value(&c).unwrap();

        assert!(v.get("enable3D").is_some(), "字段必须叫 enable3D 才和前端对得上");
        assert!(v.get("transform3D").is_some(), "字段必须叫 transform3D 才和前端对得上");
        for wrong in ["enable3d", "enable_3d", "transform3d", "transform_3d"] {
            assert!(v.get(wrong).is_none(), "不应出现变体字段名 {wrong}");
        }
        for key in ["assetId", "trackId", "startMs", "durationMs", "inMs", "outMs", "nodeId"] {
            assert!(v.get(key).is_some(), "片段字段 {key} 应当以 camelCase 序列化");
        }
    }

    /// 未启用 3D 时不该写多余的 3D 字段；缺字段反序列化要能回落默认。
    #[test]
    fn clip_omits_optional_3d_fields_when_disabled() {
        let v: Value = serde_json::to_value(clip(0.0, 1000.0)).unwrap();
        assert!(v.get("transform3D").is_none(), "未启用 3D 时不应写 transform3D");
        assert!(v.get("compoundId").is_none(), "无复合片段时不应写 compoundId");

        let back: Clip = serde_json::from_value(v).expect("缺省字段应当能反序列化");
        assert!(!back.enable_3d, "缺 enable3D 应当回落为 false");
        assert!(back.transform_3d.is_none(), "缺 transform3D 应当回落为 None");
    }

    /// 轨道按 id 查找片段，可变版本要能真的改到数据。
    #[test]
    fn track_lookup_finds_clip_by_id() {
        let mut track = Track {
            id: "t1".into(),
            kind: TrackKind::Video,
            index: 0,
            muted: false,
            solo: false,
            locked: false,
            hidden: false,
            height: 64.0,
            clips: vec![clip(0.0, 1000.0)],
        };
        assert!(track.clip("c1").is_some());
        assert!(track.clip("missing").is_none(), "查不到应当返回 None");

        track.clip_mut("c1").expect("能取到可变片段").duration_ms = 500.0;
        assert!((track.clip("c1").unwrap().end_ms() - 500.0).abs() < 1e-9);
    }

    /// 转场与音频淡入淡出按 camelCase 来回序列化；没设置时不写多余字段。
    #[test]
    fn clip_serializes_transition_and_fades() {
        let plain: Value = serde_json::to_value(clip(0.0, 1000.0)).unwrap();
        assert!(plain.get("transitionIn").is_none(), "无转场时不应写 transitionIn");
        assert!(plain.get("audioFadeInMs").is_none(), "无淡入时不应写 audioFadeInMs");
        assert!(plain.get("audioFadeOutMs").is_none(), "无淡出时不应写 audioFadeOutMs");

        let mut c = clip(0.0, 1000.0);
        c.transition_in = Some(Transition {
            kind: "crossDissolve".into(),
            duration_ms: 500.0,
        });
        c.audio_fade_in_ms = Some(200.0);
        c.audio_fade_out_ms = Some(300.0);
        let v: Value = serde_json::to_value(&c).unwrap();
        assert_eq!(
            v.get("transitionIn").and_then(|t| t.get("kind")).and_then(Value::as_str),
            Some("crossDissolve"),
            "转场类型要原样写出"
        );
        assert_eq!(
            v.get("transitionIn").and_then(|t| t.get("durationMs")).and_then(Value::as_f64),
            Some(500.0),
            "转场时长键必须叫 durationMs"
        );
        assert_eq!(v.get("audioFadeInMs").and_then(Value::as_f64), Some(200.0));
        assert_eq!(v.get("audioFadeOutMs").and_then(Value::as_f64), Some(300.0));

        let back: Clip = serde_json::from_value(v).expect("带转场的片段应当能反序列化");
        assert_eq!(
            back.transition_in.as_ref().map(|t| t.kind.as_str()),
            Some("crossDissolve")
        );
        assert_eq!(back.audio_fade_in_ms, Some(200.0));
    }

    /// 旧工程 JSON 没有转场 / 淡入淡出字段也必须能加载，回落到无转场。
    #[test]
    fn clip_loads_legacy_json_without_transition_fields() {
        let legacy = serde_json::json!({
            "id": "c1",
            "assetId": "a1",
            "trackId": "t1",
            "startMs": 0.0,
            "durationMs": 1000.0,
            "inMs": 0.0,
            "outMs": 1000.0,
            "speed": 1.0,
            "reversed": false,
            "nodeId": "n1"
        });
        let back: Clip = serde_json::from_value(legacy).expect("旧 JSON 必须能加载");
        assert!(back.transition_in.is_none(), "缺 transitionIn 应回落 None");
        assert!(back.audio_fade_in_ms.is_none(), "缺 audioFadeInMs 应回落 None");
        assert!(back.audio_fade_out_ms.is_none(), "缺 audioFadeOutMs 应回落 None");
        assert!(back.enabled, "缺 enabled 应回落为 true");
        assert!(back.speed_curve.is_none(), "缺 speedCurve 应回落 None");
        assert!(!back.audio_pitch_shift, "缺 audioPitchShift 应回落 false（保调）");
    }

    /// 无曲线时：速度恒定、源偏移就是线性乘积（老行为不变）。
    #[test]
    fn constant_speed_math_is_linear() {
        let mut c = clip(0.0, 2000.0);
        c.speed = 2.0;
        c.out_ms = 4000.0;
        assert!(c.speed_at(0.0) - 2.0 < 1e-9 && c.speed_at(2000.0) - 2.0 < 1e-9);
        assert!((c.source_offset(1000.0) - 2000.0).abs() < 1e-9, "1 秒片段应走 2 秒素材");
        assert!((c.local_for_source(2000.0) - 1000.0).abs() < 1e-9, "逆运算要能回去");
        assert!((c.average_speed() - 2.0).abs() < 1e-9);
    }

    /// 曲线变速：折线求值 + 积分 + 逆运算三者必须自洽。
    #[test]
    fn speed_curve_integrates_and_inverts() {
        let mut c = clip(0.0, 4000.0);
        // 0ms:1× → 2000ms:3× → 4000ms:1×（先加速再减速的「子弹时间」形）
        c.speed_curve = Some(vec![
            SpeedKey { t_ms: 0.0, speed: 1.0 },
            SpeedKey { t_ms: 2000.0, speed: 3.0 },
            SpeedKey { t_ms: 4000.0, speed: 1.0 },
        ]);
        c.out_ms = 8000.0; // 源总长 = 梯形积分 8000ms，与曲线自洽

        // 折线中点：1 与 3 之间 → 2
        assert!((c.speed_at(1000.0) - 2.0).abs() < 1e-9, "段中点应取两端均值");
        // 端头之外不外推
        assert!((c.speed_at(-500.0) - 1.0).abs() < 1e-9);
        assert!((c.speed_at(99999.0) - 1.0).abs() < 1e-9);

        // 积分：前 2 秒走 (1+3)/2×2000 = 4000ms；全程 = 4000 + 4000 = 8000ms
        assert!((c.source_offset(2000.0) - 4000.0).abs() < 1e-6, "前段梯形面积 4000");
        assert!((c.source_offset(4000.0) - 8000.0).abs() < 1e-6, "全程 8000");
        assert!((c.source_offset(1000.0) - 1500.0).abs() < 1e-6, "第一秒梯形 1500");

        // 逆运算：走 4000ms 素材应对应 2000ms 片段内时刻
        assert!((c.local_for_source(4000.0) - 2000.0).abs() < 1e-6, "逆运算要回到 2000");
        assert!((c.local_for_source(8000.0) - 4000.0).abs() < 1e-6, "全程逆运算");

        // 平均速度 = 8000/4000 = 2
        assert!((c.average_speed() - 2.0).abs() < 1e-9, "均速应是总源长除总时长");
    }

    /// 速度非法（0 / 负 / NaN）时夹到 1，不让积分炸掉。
    #[test]
    fn speed_curve_sanitizes_bad_values() {
        let mut c = clip(0.0, 1000.0);
        c.speed = 0.0;
        assert!((c.base_speed() - 1.0).abs() < 1e-9, "0 速夹成 1");
        c.speed_curve = Some(vec![
            SpeedKey { t_ms: 0.0, speed: -2.0 },
            SpeedKey { t_ms: 1000.0, speed: f64::NAN },
        ]);
        assert!((c.speed_at(500.0) - 1.0).abs() < 1e-9, "负/NaN 都夹成 1");
        assert!((c.source_offset(1000.0) - 1000.0).abs() < 1e-9, "夹成 1 后积分即时长");
    }

    /// speedCurve / audioPitchShift 的 camelCase 契约。
    #[test]
    fn speed_curve_serializes_camel_case() {
        let mut c = clip(0.0, 1000.0);
        c.speed_curve = Some(vec![SpeedKey { t_ms: 0.0, speed: 1.0 }, SpeedKey { t_ms: 1000.0, speed: 2.0 }]);
        c.audio_pitch_shift = true;
        let v: Value = serde_json::to_value(&c).unwrap();
        let curve = v.get("speedCurve").expect("应写 speedCurve");
        assert_eq!(curve[0].get("tMs").and_then(Value::as_f64), Some(0.0));
        assert_eq!(curve[0].get("speed").and_then(Value::as_f64), Some(1.0));
        assert_eq!(v.get("audioPitchShift").and_then(Value::as_bool), Some(true));
    }
}
