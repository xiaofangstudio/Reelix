//! 曲线求值。这份实现与前端 `src/core/curveEval.ts` 必须逐行对应，
//! 否则拖动播放头时前端预览的数值会和实际渲染结果对不上。

use crate::keyframe::model::{EasingPreset, Keyframe};

/// 缓动预设 → 三次贝塞尔控制点，与 CSS 的 cubic-bezier 同构。
fn easing_tangents(easing: EasingPreset) -> [f64; 4] {
    match easing {
        EasingPreset::Linear => [0.0, 0.0, 1.0, 1.0],
        EasingPreset::EaseIn => [0.42, 0.0, 1.0, 1.0],
        EasingPreset::EaseOut => [0.0, 0.0, 0.58, 1.0],
        EasingPreset::EaseInOut => [0.42, 0.0, 0.58, 1.0],
        EasingPreset::Bounce => [0.34, 1.56, 0.64, 1.0],
        EasingPreset::Elastic => [0.22, 1.4, 0.36, 1.0],
    }
}

/// 求某时刻的参数值。`keyframes` 必须按 time_ms 升序。
/// 没有关键帧返回 None；只有一帧返回该值；两端之外保持端点值，不外推。
pub fn evaluate_curve(keyframes: &[Keyframe], time_ms: f64) -> Option<f64> {
    if keyframes.is_empty() {
        return None;
    }
    if keyframes.len() == 1 {
        return Some(keyframes[0].value);
    }

    let first = &keyframes[0];
    let last = &keyframes[keyframes.len() - 1];

    if time_ms <= first.time_ms {
        return Some(first.value);
    }
    if time_ms >= last.time_ms {
        return Some(last.value);
    }

    let i = find_segment(keyframes, time_ms);
    let a = &keyframes[i];
    let b = &keyframes[i + 1];

    let span = b.time_ms - a.time_ms;
    if span <= 0.0 {
        return Some(b.value);
    }

    let t = (time_ms - a.time_ms) / span;
    let eased = apply_easing(t, a.easing);
    Some(a.value + (b.value - a.value) * eased)
}

/// 二分找到 time_ms 落在哪一段，返回左端下标。
fn find_segment(keyframes: &[Keyframe], time_ms: f64) -> usize {
    let mut lo = 0usize;
    let mut hi = keyframes.len() - 2;
    while lo < hi {
        let mid = (lo + hi + 1) >> 1;
        if keyframes[mid].time_ms <= time_ms {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo
}

/// 把归一化时间 t 按缓动预设映射成缓动后的进度。
fn apply_easing(t: f64, easing: EasingPreset) -> f64 {
    let c = easing_tangents(easing);
    cubic_bezier_y(c[0], c[1], c[2], c[3], t)
}

/// 给定 x 求三次贝塞尔的 y。牛顿迭代 + 二分兜底，容差 1e-6。
fn cubic_bezier_y(x1: f64, y1: f64, x2: f64, y2: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }

    let sample_x = |t: f64| bezier(t, 0.0, x1, x2, 1.0);
    let sample_y = |t: f64| bezier(t, 0.0, y1, y2, 1.0);
    let sample_dx =
        |t: f64| 3.0 * (1.0 - t) * (1.0 - t) * x1 + 6.0 * (1.0 - t) * t * (x2 - x1) + 3.0 * t * t * (1.0 - x2);

    let mut t = x;
    for _ in 0..8 {
        let dx = sample_x(t) - x;
        if dx.abs() < 1e-6 {
            return sample_y(t);
        }
        let d = sample_dx(t);
        if d.abs() < 1e-6 {
            break;
        }
        t -= dx / d;
    }

    let mut lo = 0.0;
    let mut hi = 1.0;
    t = x;
    for _ in 0..20 {
        let cur = sample_x(t);
        if (cur - x).abs() < 1e-6 {
            break;
        }
        if cur < x {
            lo = t;
        } else {
            hi = t;
        }
        t = (lo + hi) / 2.0;
    }
    sample_y(t)
}

/// 三次贝塞尔单轴采样。
fn bezier(t: f64, p0: f64, p1: f64, p2: f64, p3: f64) -> f64 {
    let mt = 1.0 - t;
    mt * mt * mt * p0 + 3.0 * mt * mt * t * p1 + 3.0 * mt * t * t * p2 + t * t * t * p3
}

/// 在某时刻插入或更新关键帧，返回新的升序数组。
/// 命中同参数且时间差在 `tolerance_ms` 内的旧帧时覆盖它的值，但保留旧 id。
pub fn upsert_keyframe(keyframes: Vec<Keyframe>, next: Keyframe, tolerance_ms: f64) -> Vec<Keyframe> {
    let mut out = keyframes;
    if let Some(pos) = out
        .iter()
        .position(|k| k.param == next.param && (k.time_ms - next.time_ms).abs() <= tolerance_ms)
    {
        let keep_id = out[pos].id.clone();
        out[pos] = Keyframe {
            id: keep_id,
            ..next
        };
    } else {
        out.push(next);
    }
    out.sort_by(|a, b| a.time_ms.partial_cmp(&b.time_ms).unwrap_or(std::cmp::Ordering::Equal));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keyframe::model::Tangent;

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-4
    }

    fn kf(id: &str, param: &str, time_ms: f64, value: f64) -> Keyframe {
        Keyframe {
            id: id.into(),
            target_id: "n1".into(),
            param: param.into(),
            time_ms,
            value,
            easing: EasingPreset::Linear,
            in_tangent: Tangent::new(0.0, 0.0),
            out_tangent: Tangent::new(1.0, 1.0),
        }
    }

    /// 没有关键帧时求值为 None——上层据此判断参数是否处于「动画」状态。
    #[test]
    fn empty_curve_evaluates_to_none() {
        assert_eq!(evaluate_curve(&[], 0.0), None);
        assert_eq!(evaluate_curve(&[], 12345.0), None);
    }

    /// 只有一个关键帧时，任何时刻都返回它——相当于常数值。
    #[test]
    fn single_keyframe_holds_its_value() {
        let curve = vec![kf("a", "opacity", 500.0, 42.0)];
        assert_eq!(evaluate_curve(&curve, 0.0), Some(42.0));
        assert_eq!(evaluate_curve(&curve, 500.0), Some(42.0));
        assert_eq!(evaluate_curve(&curve, 99999.0), Some(42.0));
    }

    /// 曲线两端之外保持端点值，绝不外推。
    #[test]
    fn curve_does_not_extrapolate_past_endpoints() {
        let mut a = kf("a", "opacity", 0.0, 0.0);
        a.easing = EasingPreset::Linear;
        let mut b = kf("b", "opacity", 1000.0, 10.0);
        b.easing = EasingPreset::Linear;
        let curve = vec![a, b];

        assert_eq!(evaluate_curve(&curve, -500.0), Some(0.0), "首帧之前应当保持首值");
        assert_eq!(evaluate_curve(&curve, 0.0), Some(0.0));
        assert_eq!(evaluate_curve(&curve, 2000.0), Some(10.0), "末帧之后应当保持末值");
        assert_eq!(evaluate_curve(&curve, 1000.0), Some(10.0));
    }

    /// 线性缓动在段中点应当精确取到值域中点。
    #[test]
    fn linear_easing_interpolates_linearly() {
        let curve = vec![
            kf("a", "opacity", 0.0, 0.0),
            kf("b", "opacity", 1000.0, 10.0),
        ];
        assert!(approx(evaluate_curve(&curve, 250.0).unwrap(), 2.5));
        assert!(approx(evaluate_curve(&curve, 500.0).unwrap(), 5.0));
        assert!(approx(evaluate_curve(&curve, 750.0).unwrap(), 7.5));
    }

    /// 多段曲线应当落在正确的那一段里取值。
    #[test]
    fn multi_segment_curve_picks_right_segment() {
        let curve = vec![
            kf("a", "opacity", 0.0, 0.0),
            kf("b", "opacity", 1000.0, 10.0),
            kf("c", "opacity", 2000.0, 0.0),
        ];
        assert!(approx(evaluate_curve(&curve, 500.0).unwrap(), 5.0), "第一段中点");
        assert!(approx(evaluate_curve(&curve, 1500.0).unwrap(), 5.0), "第二段中点是 10 → 0 的中点");
        assert!(approx(evaluate_curve(&curve, 1000.0).unwrap(), 10.0), "段边界应当取到该帧的值");
    }

    /// 曲线两端之外不外推：段内 easing 用左端帧的缓动。
    #[test]
    fn segment_uses_left_keyframe_easing() {
        let mut a = kf("a", "opacity", 0.0, 0.0);
        a.easing = EasingPreset::EaseIn; // 慢起，段中点应当偏小
        let curve = vec![a, kf("b", "opacity", 1000.0, 10.0)];
        let mid = evaluate_curve(&curve, 500.0).unwrap();
        assert!(mid < 5.0, "缓入的段中点应当小于线性中点：{mid}");
    }

    /// 六个缓动预设的控制点必须与前端 `curveEval.ts` 的 EASING_TANGENTS 逐字一致。
    #[test]
    fn easing_tangents_match_frontend_table() {
        let expected = [
            (EasingPreset::Linear, [0.0, 0.0, 1.0, 1.0]),
            (EasingPreset::EaseIn, [0.42, 0.0, 1.0, 1.0]),
            (EasingPreset::EaseOut, [0.0, 0.0, 0.58, 1.0]),
            (EasingPreset::EaseInOut, [0.42, 0.0, 0.58, 1.0]),
            (EasingPreset::Bounce, [0.34, 1.56, 0.64, 1.0]),
            (EasingPreset::Elastic, [0.22, 1.4, 0.36, 1.0]),
        ];
        for (preset, expected) in expected {
            let got = easing_tangents(preset);
            for i in 0..4 {
                assert!(
                    approx(got[i], expected[i]),
                    "预设 {preset:?} 的第 {i} 个控制点应逐字对齐前端：{got:?}"
                );
            }
        }
    }

    /// 所有缓动预设的两端都是 0 与 1，保证关键帧边界值不被扭曲。
    #[test]
    fn every_easing_is_anchored_at_both_ends() {
        for preset in [
            EasingPreset::Linear,
            EasingPreset::EaseIn,
            EasingPreset::EaseOut,
            EasingPreset::EaseInOut,
            EasingPreset::Bounce,
            EasingPreset::Elastic,
        ] {
            assert!(approx(apply_easing(0.0, preset), 0.0), "{preset:?} 起点应为 0");
            assert!(approx(apply_easing(1.0, preset), 1.0), "{preset:?} 终点应为 1");
        }
    }

    /// 缓入慢起、缓出快起、缓入缓出对称——这三条是最常用的手感基准。
    #[test]
    fn easing_presets_have_expected_shape() {
        assert!(approx(apply_easing(0.5, EasingPreset::Linear), 0.5), "线性中点是 0.5");
        let ease_in = apply_easing(0.25, EasingPreset::EaseIn);
        assert!(ease_in < 0.25, "缓入起步应当慢于线性：{ease_in}");
        let ease_out = apply_easing(0.25, EasingPreset::EaseOut);
        assert!(ease_out > 0.25, "缓出起步应当快于线性：{ease_out}");
        assert!(
            approx(apply_easing(0.5, EasingPreset::EaseInOut), 0.5),
            "缓入缓出应当关于中点对称"
        );
    }

    /// 回弹与弹性是「过冲」类缓动，中途必须越过 1.0，说明没有被误夹取。
    #[test]
    fn overshoot_presets_pass_above_one() {
        for preset in [EasingPreset::Bounce, EasingPreset::Elastic] {
            let mut peak: f64 = 0.0;
            let mut step = 1;
            while step < 100 {
                let x = step as f64 / 100.0;
                peak = peak.max(apply_easing(x, preset));
                step += 1;
            }
            assert!(peak > 1.0, "{preset:?} 应当存在过冲：峰值 {peak}");
        }
    }

    /// 归一化时间 t 的贝塞尔求值在 x=0/1 处短路返回，保证端点精确。
    #[test]
    fn bezier_short_circuits_at_bounds() {
        assert!(approx(cubic_bezier_y(0.42, 0.0, 0.58, 1.0, 0.0), 0.0));
        assert!(approx(cubic_bezier_y(0.42, 0.0, 0.58, 1.0, 1.0), 1.0));
        assert!(approx(cubic_bezier_y(0.42, 0.0, 0.58, 1.0, -1.0), 0.0));
        assert!(approx(cubic_bezier_y(0.42, 0.0, 0.58, 1.0, 2.0), 1.0));
    }

    /// 插入新帧后必须保持 time_ms 升序。
    #[test]
    fn upsert_inserts_in_sorted_order() {
        let out = upsert_keyframe(
            vec![kf("a", "opacity", 1000.0, 1.0)],
            kf("b", "opacity", 0.0, 0.0),
            1.0,
        );
        assert_eq!(out.len(), 2, "时间不冲突应当插入而不是覆盖");
        assert!(approx(out[0].time_ms, 0.0), "结果应当升序排列");
        assert!(approx(out[1].time_ms, 1000.0));
    }

    /// 同参数且时间差在容差内时覆盖旧帧的值，但保留旧 id（否则会打断关键帧选中态）。
    #[test]
    fn upsert_overwrites_within_tolerance_and_keeps_id() {
        let out = upsert_keyframe(
            vec![kf("old", "opacity", 1000.0, 1.0)],
            kf("new", "opacity", 1000.5, 0.25),
            1.0,
        );
        assert_eq!(out.len(), 1, "容差内应当覆盖而不是新增");
        assert_eq!(out[0].id, "old", "覆盖时应当保留旧 id");
        assert!(approx(out[0].value, 0.25), "覆盖后应当取新值");
    }

    /// 不同参数不算命中，必须各自保留。
    #[test]
    fn upsert_keeps_other_params_intact() {
        let out = upsert_keyframe(
            vec![kf("a", "opacity", 1000.0, 1.0)],
            kf("b", "scale", 1000.0, 2.0),
            1.0,
        );
        assert_eq!(out.len(), 2, "不同参数不应互相覆盖");
    }

    /// 超出容差时应当新增一帧，而不是覆盖。
    #[test]
    fn upsert_inserts_outside_tolerance() {
        let out = upsert_keyframe(
            vec![kf("a", "opacity", 1000.0, 1.0)],
            kf("b", "opacity", 1005.0, 0.5),
            1.0,
        );
        assert_eq!(out.len(), 2, "容差之外应当新增一帧");
    }
}
