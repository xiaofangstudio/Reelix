//! 效果内核（CPU 参考实现）。
//!
//! 每个效果都是「输入缓冲 + 参数 → 输出缓冲」的纯函数，不含任何状态。
//! 这是合成管线里**真正产出像素的那一层**：引擎按拓扑序把上一个效果的输出
//! 喂给下一个效果，串完一串效果栈就是监视器上的一帧。
//!
//! 为什么先有 CPU 参考实现（见 `docs/03-技术架构.md` 第三节、`docs/11` 第 16 条）：
//! - 效果的**公式**必须先定死，wgpu / WGSL 管线照抄这里的公式，保证
//!   「预览与导出共用同一套公式」；
//! - CPU 版让每个公式都能在无 GPU 的单测里被验证，GPU 版只负责把同样的
//!   算式搬到显卡上跑；
//! - GPU 不可用、或画面尺寸很小时，这份实现可直接兜底。
//!
//! **主力合成路径仍是 wgpu**（AGENTS.md 红线：不得退回 CPU / Canvas 2D 充当主力）。
//! 这里提供的是公式的权威定义与可测的参考实现。

use std::collections::HashMap;

use crate::graph::node::ParamValue;

/// 一帧 RGBA 浮点缓冲。
///
/// 取值 0.0 ~ 1.0，行优先，原点在左上角。`pixels` 长度为 `width * height * 4`，
/// 依次是 R、G、B、A。选浮点而非整数，是为了让效果链在中间步骤不掉精度。
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<f32>,
}

impl Frame {
    /// 新建全透明黑帧。宽高至少为 1。
    pub fn new(width: usize, height: usize) -> Self {
        let w = width.max(1);
        let h = height.max(1);
        Self {
            width: w,
            height: h,
            pixels: vec![0.0; w * h * 4],
        }
    }

    /// 新建整帧填充同一颜色。
    pub fn filled(width: usize, height: usize, rgba: [f32; 4]) -> Self {
        let mut frame = Self::new(width, height);
        for px in frame.pixels.chunks_exact_mut(4) {
            px.copy_from_slice(&rgba);
        }
        frame
    }

    /// 读一个像素。
    pub fn pixel(&self, x: usize, y: usize) -> [f32; 4] {
        let idx = (y * self.width + x) * 4;
        [
            self.pixels[idx],
            self.pixels[idx + 1],
            self.pixels[idx + 2],
            self.pixels[idx + 3],
        ]
    }

    /// 写一个像素。
    pub fn set_pixel(&mut self, x: usize, y: usize, rgba: [f32; 4]) {
        let idx = (y * self.width + x) * 4;
        self.pixels[idx..idx + 4].copy_from_slice(&rgba);
    }

    /// 双线性采样。坐标会被夹到画面内，越界不外扩也不报错。
    pub fn sample(&self, x: f32, y: f32) -> [f32; 4] {
        let max_x = (self.width - 1) as f32;
        let max_y = (self.height - 1) as f32;
        let cx = x.clamp(0.0, max_x);
        let cy = y.clamp(0.0, max_y);

        let x0 = cx.floor() as usize;
        let y0 = cy.floor() as usize;
        let x1 = (x0 + 1).min(self.width - 1);
        let y1 = (y0 + 1).min(self.height - 1);
        let fx = cx - x0 as f32;
        let fy = cy - y0 as f32;

        let p00 = self.pixel(x0, y0);
        let p10 = self.pixel(x1, y0);
        let p01 = self.pixel(x0, y1);
        let p11 = self.pixel(x1, y1);

        let mut out = [0.0f32; 4];
        for c in 0..4 {
            let top = p00[c] + (p10[c] - p00[c]) * fx;
            let bottom = p01[c] + (p11[c] - p01[c]) * fx;
            out[c] = top + (bottom - top) * fy;
        }
        out
    }
}

/// 感知亮度（Rec.709 权重）。
fn luma(r: f32, g: f32, b: f32) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// 平滑阶跃。`edge0 == edge1` 时退化成硬阈值，避免除零。
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let span = edge1 - edge0;
    if span.abs() < 1e-6 {
        return if x < edge0 { 0.0 } else { 1.0 };
    }
    let t = ((x - edge0) / span).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// 确定性伪随机，返回 0.0 ~ 1.0。同样输入永远同样输出——求值必须可复现。
fn hash01(x: usize, y: usize, seed: u64) -> f32 {
    let mut h = seed
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add((x as u64).wrapping_mul(0xBF58_476D_1CE4_E5B9))
        .wrapping_add((y as u64).wrapping_mul(0x94D0_49BB_1331_11EB));
    h ^= h >> 29;
    h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 32;
    ((h >> 11) as f64 / (1u64 << 53) as f64) as f32
}

// ---------------------------------------------------------------------------
// 基础效果
// ---------------------------------------------------------------------------

/// 高斯模糊近似：三次盒式模糊逼近高斯核。半径以像素为单位。
pub fn blur(input: &Frame, radius: f32) -> Frame {
    let r = radius.max(0.0);
    if r < 0.5 {
        return input.clone();
    }
    let mut out = box_blur(input, r);
    out = box_blur(&out, r);
    box_blur(&out, r)
}

/// 单次可分离盒式模糊。
fn box_blur(input: &Frame, radius: f32) -> Frame {
    let half = radius.round().max(1.0) as usize;
    let horizontal = box_blur_axis(input, half, true);
    box_blur_axis(&horizontal, half, false)
}

#[allow(clippy::needless_range_loop)]
fn box_blur_axis(input: &Frame, half: usize, horizontal: bool) -> Frame {
    let w = input.width;
    let h = input.height;
    let mut out = Frame::new(w, h);
    let win = (half * 2 + 1) as f32;

    for y in 0..h {
        for x in 0..w {
            let mut acc = [0.0f32; 4];
            for d in -(half as isize)..=(half as isize) {
                let (sx, sy) = if horizontal {
                    ((x as isize + d).clamp(0, w as isize - 1) as usize, y)
                } else {
                    (x, (y as isize + d).clamp(0, h as isize - 1) as usize)
                };
                let p = input.pixel(sx, sy);
                for c in 0..4 {
                    acc[c] += p[c];
                }
            }
            out.set_pixel(
                x,
                y,
                [
                    acc[0] / win,
                    acc[1] / win,
                    acc[2] / win,
                    acc[3] / win,
                ],
            );
        }
    }
    out
}

/// 调色：曝光、对比度、饱和度、色温、色调、高光、阴影。
///
/// 七个控件的中性值都是 0，与 `effectCatalog.ts` 的 `grade` 逐键一致：
/// - `exposure`：曝光，以 EV 计，增益 = 2^EV；
/// - `contrast`：对比度，围绕中灰 0.5 拉开 / 收拢，系数 = 1 + 值 / 100；
/// - `saturation`：饱和度，围绕亮度收缩 / 扩张，系数 = 1 + 值 / 100；
/// - `temperature`：色温，正为暖（加红减蓝），负为冷；
/// - `tint`：色调，正为品红（加红蓝减绿），负为绿；
/// - `highlights` / `shadows`：分别只抬压亮部 / 暗部。
#[allow(clippy::too_many_arguments)]
pub fn grade(
    input: &Frame,
    exposure: f32,
    contrast: f32,
    saturation: f32,
    temperature: f32,
    tint: f32,
    highlights: f32,
    shadows: f32,
) -> Frame {
    let gain = 2f32.powf(exposure);
    let c = 1.0 + contrast.clamp(-100.0, 100.0) / 100.0;
    let s = 1.0 + saturation.clamp(-100.0, 100.0) / 100.0;
    let temp = temperature.clamp(-100.0, 100.0) / 100.0;
    let tn = tint.clamp(-100.0, 100.0) / 100.0;
    let hi = highlights.clamp(-100.0, 100.0) / 100.0;
    let sh = shadows.clamp(-100.0, 100.0) / 100.0;

    let mut out = input.clone();
    for px in out.pixels.chunks_exact_mut(4) {
        let mut r = px[0] * gain;
        let mut g = px[1] * gain;
        let mut b = px[2] * gain;

        // 对比度：围绕中灰拉开 / 收拢。
        r = (r - 0.5) * c + 0.5;
        g = (g - 0.5) * c + 0.5;
        b = (b - 0.5) * c + 0.5;

        // 色温 / 色调：暖色加红减蓝，品红加红蓝减绿。
        r += temp * 0.12 - tn * 0.05;
        b -= temp * 0.12 - tn * 0.05;
        g += tn * 0.12;

        let l = luma(r, g, b);

        // 高光 / 阴影：按亮度权重分别抬压亮部与暗部。
        let w_hi = smoothstep(0.5, 1.0, l);
        let w_sh = 1.0 - smoothstep(0.0, 0.5, l);
        let lift = (hi * w_hi + sh * w_sh) * 0.3;
        r += lift;
        g += lift;
        b += lift;

        // 饱和度：围绕亮度收缩 / 扩张。
        r = l + (r - l) * s;
        g = l + (g - l) * s;
        b = l + (b - l) * s;

        px[0] = r.clamp(0.0, 1.0);
        px[1] = g.clamp(0.0, 1.0);
        px[2] = b.clamp(0.0, 1.0);
    }
    out
}

/// 不透明度：只缩放 alpha。
pub fn opacity(input: &Frame, amount: f32) -> Frame {
    let a = amount.clamp(0.0, 1.0);
    let mut out = input.clone();
    for px in out.pixels.chunks_exact_mut(4) {
        px[3] *= a;
    }
    out
}

/// 单色。与 `effectCatalog.ts` 的 `mono` 逐键一致：
/// - `grayscale` 为真时三通道都取亮度（纯灰）；
/// - 为假时按 `hue` 角度把亮度染成单色（色相环，0 为红）；
/// - `strength` 是与原始画面的混合比例，100 表示完全替换。
pub fn mono(input: &Frame, grayscale: bool, hue: f32, strength: f32) -> Frame {
    let tint = hue_rgb(hue);
    let k = (strength.clamp(0.0, 100.0) / 100.0).clamp(0.0, 1.0);
    let mut out = input.clone();
    for px in out.pixels.chunks_exact_mut(4) {
        let src = [px[0], px[1], px[2]];
        let l = luma(src[0], src[1], src[2]);
        let mapped = if grayscale {
            [l, l, l]
        } else {
            [tint[0] * l, tint[1] * l, tint[2] * l]
        };
        for c in 0..3 {
            px[c] = (src[c] + (mapped[c] - src[c]) * k).clamp(0.0, 1.0);
        }
    }
    out
}

/// 色相角（度）转 0.0 ~ 1.0 的 RGB。用于单色着色。
fn hue_rgb(hue: f32) -> [f32; 3] {
    let h = hue.rem_euclid(360.0) / 60.0;
    let x = 1.0 - (h % 2.0 - 1.0).abs();
    match h as i32 % 6 {
        0 => [1.0, x, 0.0],
        1 => [x, 1.0, 0.0],
        2 => [0.0, 1.0, x],
        3 => [0.0, x, 1.0],
        4 => [x, 0.0, 1.0],
        _ => [1.0, 0.0, x],
    }
}

/// 镜像。`horizontal` 为真时左右翻，否则上下翻。
#[allow(clippy::needless_range_loop)]
pub fn mirror(input: &Frame, horizontal: bool) -> Frame {
    let w = input.width;
    let h = input.height;
    let mut out = Frame::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let sx = if horizontal { w - 1 - x } else { x };
            let sy = if horizontal { y } else { h - 1 - y };
            out.set_pixel(x, y, input.pixel(sx, sy));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 变换：移动 / 缩放 / 旋转 / 锚点 / 倾斜、裁剪
// ---------------------------------------------------------------------------

/// 采样：越界一律返回全透明，不外扩。
///
/// 与 `Frame::sample` 的区别：旋转 / 缩放后画面四角会探到原图之外，
/// 那里必须取透明，若像 `sample` 那样夹到边缘，会在画面外缘拖出边条纹。
fn sample_transparent(input: &Frame, x: f32, y: f32) -> [f32; 4] {
    let max_x = input.width as f32 - 1.0;
    let max_y = input.height as f32 - 1.0;
    if x < 0.0 || y < 0.0 || x > max_x || y > max_y {
        return [0.0; 4];
    }
    input.sample(x, y)
}

/// 变换：移动 / 缩放 / 旋转 / 锚点 / 倾斜。参数与 `effectCatalog.ts` 的 `transform` 逐键一致。
///
/// - `pos_x` / `pos_y`：位移，单位像素，正值向右 / 向下；
/// - `scale`：缩放百分比，100 表示原始大小；
/// - `rotation`：旋转角度，单位度；
/// - `anchor_x` / `anchor_y`：锚点相对画面中心的偏移，单位像素，缩放与旋转都绕它进行；
/// - `skew`：沿水平方向的倾斜角，单位度。
///
/// 实现走**逆变换**：对输出每个像素反算它在输入里的位置，再双线性采样。
#[allow(clippy::too_many_arguments)]
#[allow(clippy::needless_range_loop)]
pub fn transform(
    input: &Frame,
    pos_x: f32,
    pos_y: f32,
    scale: f32,
    rotation: f32,
    anchor_x: f32,
    anchor_y: f32,
    skew: f32,
) -> Frame {
    let w = input.width as f32;
    let h = input.height as f32;
    let cx = w * 0.5 + anchor_x;
    let cy = h * 0.5 + anchor_y;
    let s = (scale / 100.0).max(1e-4);
    let (sin_r, cos_r) = rotation.to_radians().sin_cos();
    let tan_k = skew.to_radians().tan();

    let mut out = Frame::new(input.width, input.height);
    for y in 0..input.height {
        for x in 0..input.width {
            // 输出像素坐标（与 `Frame::sample` 同一套约定：整数坐标即像素中心），
            // 先扣掉位移、再相对锚点，随后做逆旋转 / 逆缩放 / 逆倾斜。
            let dx = x as f32 - cx - pos_x;
            let dy = y as f32 - cy - pos_y;
            // 逆旋转。
            let rx = dx * cos_r + dy * sin_r;
            let ry = -dx * sin_r + dy * cos_r;
            // 逆缩放。
            let ux = rx / s;
            let uy = ry / s;
            // 逆倾斜，回到输入坐标系。
            let qx = ux - uy * tan_k + cx;
            let qy = uy + cy;
            out.set_pixel(x, y, sample_transparent(input, qx, qy));
        }
    }
    out
}

/// 裁剪：四条边各吃掉多少，单位是画面宽 / 高的百分比（0 ~ 100）。
///
/// 被裁掉的部分**保留像素、alpha 归零**，这样它仍然是同样尺寸的一帧，
/// 后续效果栈不必改变缓冲大小即可继续串联。
#[allow(clippy::needless_range_loop)]
pub fn crop(input: &Frame, top: f32, bottom: f32, left: f32, right: f32) -> Frame {
    let w = input.width as f32;
    let h = input.height as f32;
    let x0 = left.clamp(0.0, 100.0) / 100.0 * w;
    let x1 = w - right.clamp(0.0, 100.0) / 100.0 * w;
    let y0 = top.clamp(0.0, 100.0) / 100.0 * h;
    let y1 = h - bottom.clamp(0.0, 100.0) / 100.0 * h;

    let mut out = input.clone();
    for y in 0..input.height {
        for x in 0..input.width {
            let pcx = x as f32 + 0.5;
            let pcy = y as f32 + 0.5;
            if pcx < x0 || pcx > x1 || pcy < y0 || pcy > y1 {
                let idx = (y * input.width + x) * 4;
                out.pixels[idx + 3] = 0.0;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 滤镜：锐化 / 发光 / 噪点 / 马赛克
// ---------------------------------------------------------------------------

/// 锐化（USM 反遮罩）：`input + 强度 × (input − 模糊)`。
///
/// `strength` 为百分比（100 表示 1.0 倍），`radius` 是模糊半径、单位像素。
/// 只作用于 RGB，alpha 保持不变。
#[allow(clippy::needless_range_loop)]
pub fn sharpen(input: &Frame, strength: f32, radius: f32) -> Frame {
    let amount = (strength.clamp(0.0, 200.0) / 100.0).max(0.0);
    if amount <= 1e-4 {
        return input.clone();
    }
    let blurred = blur(input, radius.max(1.0));
    let mut out = input.clone();
    for (i, px) in out.pixels.chunks_exact_mut(4).enumerate() {
        let j = i * 4;
        for c in 0..3 {
            let diff = px[c] - blurred.pixels[j + c];
            px[c] = (px[c] + diff * amount).clamp(0.0, 1.0);
        }
    }
    out
}

/// 发光：把亮过 `threshold` 的部分抽出来做模糊，再按 `strength` 加回原画面。
///
/// 三个参数都是百分比：`threshold` 0 ~ 100（70 表示只取亮度 0.7 以上的像素），
/// `radius` 单位像素（此处按百分比口径放宽到 0 ~ 200），`strength` 0 ~ 200。
/// 加色会让高光溢出，这正是辉光该有的样子。
#[allow(clippy::needless_range_loop)]
pub fn glow(input: &Frame, threshold: f32, radius: f32, strength: f32) -> Frame {
    let t = threshold.clamp(0.0, 100.0) / 100.0;
    let k = (strength.clamp(0.0, 200.0) / 100.0).max(0.0);

    let mut bright = input.clone();
    for px in bright.pixels.chunks_exact_mut(4) {
        let l = luma(px[0], px[1], px[2]);
        let w = smoothstep(t, (t + 0.15).min(1.0), l);
        px[0] *= w;
        px[1] *= w;
        px[2] *= w;
        px[3] *= w;
    }
    let halo = blur(&bright, radius.max(0.0));

    let mut out = input.clone();
    for (i, px) in out.pixels.chunks_exact_mut(4).enumerate() {
        let j = i * 4;
        for c in 0..3 {
            px[c] = (px[c] + halo.pixels[j + c] * k).clamp(0.0, 1.0);
        }
        px[3] = (px[3] + halo.pixels[j + 3] * k).clamp(0.0, 1.0);
    }
    out
}

/// 噪点：在 RGB 上叠加确定性伪随机噪声。
///
/// `strength` 是百分比（0 ~ 100，映射到 ±0.5 的振幅），`scale` 控制颗粒尺寸
/// （越大颗粒越大），`speed` 目前作为噪声图案的种子偏移——真正的动效要等
/// 时间线把时间喂进来后才连续播放，这里保证同一组参数永远出同一张图。
pub fn noise(input: &Frame, strength: f32, scale: f32, speed: f32) -> Frame {
    let amp = (strength.clamp(0.0, 100.0) / 100.0) * 0.5;
    if amp <= 1e-4 {
        return input.clone();
    }
    let s = scale.clamp(0.1, 10.0).max(1e-3);
    let seed = ((speed.clamp(0.0, 10.0) * 977.0) as u64) ^ 0x5EED_1234;

    let mut out = input.clone();
    for y in 0..input.height {
        for x in 0..input.width {
            let gx = (x as f32 / s).floor() as usize;
            let gy = (y as f32 / s).floor() as usize;
            let n = (hash01(gx, gy, seed) - 0.5) * 2.0 * amp;
            let idx = (y * input.width + x) * 4;
            for c in 0..3 {
                out.pixels[idx + c] = (out.pixels[idx + c] + n).clamp(0.0, 1.0);
            }
        }
    }
    out
}

/// 马赛克：按 `block_size` 见方的块取块中心像素，铺满整块。
pub fn mosaic(input: &Frame, block_size: f32) -> Frame {
    let bs = block_size.clamp(2.0, 200.0).max(1.0);
    let mut out = Frame::new(input.width, input.height);
    let half = bs * 0.5;
    for y in 0..input.height {
        for x in 0..input.width {
            let bx = (x as f32 / bs).floor() * bs;
            let by = (y as f32 / bs).floor() * bs;
            let sx = (bx + half).clamp(0.0, input.width as f32 - 1.0) as usize;
            let sy = (by + half).clamp(0.0, input.height as f32 - 1.0) as usize;
            out.set_pixel(x, y, input.pixel(sx, sy));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 生成 / 颜色补充：纯色、曲线、LUT、遮罩
// ---------------------------------------------------------------------------

/// 纯色生成：整帧填成 `color`，alpha 取 `opacity` 百分比。
///
/// 颜色解析失败时回落到纯绿（与抠像键色同一套解析）。
pub fn solid_color(input: &Frame, color: &str, opacity: f32) -> Frame {
    let rgb = parse_hex_color(color);
    let a = (opacity.clamp(0.0, 100.0) / 100.0).clamp(0.0, 1.0);
    let mut out = Frame::new(input.width, input.height);
    for px in out.pixels.chunks_exact_mut(4) {
        px[0] = rgb[0];
        px[1] = rgb[1];
        px[2] = rgb[2];
        px[3] = a;
    }
    out
}

/// 曲线：对 RGB 单独套一条平滑 S 曲线，`strength` 控制强度（0 为恒等）。
///
/// 真正的可编辑控制点曲线要等曲线编辑器的数据接进来；这条内置 S 曲线
/// 让「曲线」这个效果现在就有确定、可复现的画面含义。
#[allow(clippy::needless_range_loop)]
pub fn curves(input: &Frame, strength: f32) -> Frame {
    let k = (strength.clamp(0.0, 100.0) / 100.0).clamp(0.0, 1.0);
    let mut out = input.clone();
    for px in out.pixels.chunks_exact_mut(4) {
        for c in 0..3 {
            let x = px[c].clamp(0.0, 1.0);
            let s = x * x * (3.0 - 2.0 * x);
            px[c] = (x + (s - x) * k).clamp(0.0, 1.0);
        }
    }
    out
}

/// LUT：`file` 为空时原样返回（未载入就是恒等）。
///
/// 立方体 LUT 的解析与三线性查表要等素材管线把 `.cube` 读进来后接入，
/// 在此之前保证「没选文件不改变画面」，不会静默输出空白。
pub fn lut(input: &Frame, file: &str) -> Frame {
    let _ = file;
    input.clone()
}

/// 遮罩：用第二路画面（或输入自身的 alpha）当覆盖率，乘到输入 alpha 上。
///
/// `feather` 是羽化百分比（以画面短边为基准），`invert` 内外反转。
/// 遮罩来源优先取 `mask` 插槽喂进来的画面，没接时退化为输入自身的 alpha——
/// 这样单独拖一个遮罩节点出来不会把画面整个吃掉。
pub fn mask_apply(input: &Frame, mask: Option<&Frame>, invert: bool, feather: f32) -> Frame {
    let mut cov = Frame::new(input.width, input.height);
    for y in 0..input.height {
        for x in 0..input.width {
            let c = match mask {
                Some(m) => {
                    let p = m.pixel(x.min(m.width - 1), y.min(m.height - 1));
                    luma(p[0], p[1], p[2]) * p[3]
                }
                None => input.pixel(x, y)[3],
            };
            cov.set_pixel(x, y, [c, c, c, 1.0]);
        }
    }
    let f = feather.clamp(0.0, 100.0) / 100.0 * input.width.min(input.height) as f32 * 0.25;
    if f > 1e-4 {
        cov = blur(&cov, f);
    }

    let mut out = input.clone();
    for (i, px) in out.pixels.chunks_exact_mut(4).enumerate() {
        let mut c = cov.pixels[i * 4].clamp(0.0, 1.0);
        if invert {
            c = 1.0 - c;
        }
        px[3] *= c;
    }
    out
}

// ---------------------------------------------------------------------------
// 合成 / 图层（双输入，吃 apply 的第二路画面 source）
// ---------------------------------------------------------------------------

/// 把上层画面 `top` 按 `mode` 叠到下层 `base` 之上，`opacity` 是上层不透明度百分比。
///
/// `mode` 支持 `normal` / `add` / `multiply` / `screen`，未知取值按 `normal`。
/// 两路尺寸不一致时按左上角对齐，越界一律夹到各自画面内，不报错。
/// 结果按 source-over 合成，`add` 等模式只改 RGB，透明度仍走正常 alpha 叠加。
pub fn blend(base: &Frame, top: &Frame, mode: &str, opacity: f32) -> Frame {
    let mut out = base.clone();
    let k = (opacity / 100.0).clamp(0.0, 1.0);
    for y in 0..out.height {
        for x in 0..out.width {
            let b = base.pixel(x.min(base.width - 1), y.min(base.height - 1));
            let t = top.pixel(x.min(top.width - 1), y.min(top.height - 1));
            let mut blended = [0.0f32; 3];
            for c in 0..3 {
                blended[c] = match mode {
                    "add" => (b[c] + t[c]).min(1.0),
                    "multiply" => b[c] * t[c],
                    "screen" => 1.0 - (1.0 - b[c]) * (1.0 - t[c]),
                    _ => t[c],
                };
            }
            let ta = t[3] * k;
            let ba = b[3];
            let out_a = ta + ba * (1.0 - ta);
            let mut px = [0.0f32; 4];
            if out_a > 0.0 {
                for c in 0..3 {
                    px[c] = (blended[c] * ta + b[c] * ba * (1.0 - ta)) / out_a;
                }
            }
            px[3] = out_a;
            out.set_pixel(x, y, px);
        }
    }
    out
}

/// 合并两路画面：`base` 在下、`source` 在上，按 `mode` 逐通道叠加，不做 alpha 加权。
///
/// `mode` 支持 `add`（加法）/ `max`（取大）/ `difference`（差值），未知取值按 `add`。
/// 与 `blend` 的区别：合并只管把两路像素加起来，用于辉光、光效这类叠加式合成。
pub fn merge(base: &Frame, source: &Frame, mode: &str) -> Frame {
    let mut out = base.clone();
    for y in 0..out.height {
        for x in 0..out.width {
            let b = base.pixel(x.min(base.width - 1), y.min(base.height - 1));
            let s = source.pixel(x.min(source.width - 1), y.min(source.height - 1));
            let mut px = [0.0f32; 4];
            for c in 0..3 {
                px[c] = match mode {
                    "max" => b[c].max(s[c]),
                    "difference" => (b[c] - s[c]).abs(),
                    _ => (b[c] + s[c]).min(1.0),
                };
            }
            px[3] = (b[3] + s[3]).min(1.0);
            out.set_pixel(x, y, px);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 色度抠图
// ---------------------------------------------------------------------------

/// 十六进制半字节。
fn hex_nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// 解析 `#rrggbb` / `#rgb` 为 0.0 ~ 1.0 的 RGB。
/// 解析失败时回落到纯绿——绿幕是抠像最常见的场景。
fn parse_hex_color(s: &str) -> [f32; 3] {
    let bytes = s.trim().trim_start_matches('#').as_bytes();
    let fallback = [0.0, 1.0, 0.0];
    match bytes.len() {
        3 => {
            let mut out = [0.0f32; 3];
            for (i, slot) in out.iter_mut().enumerate() {
                match hex_nibble(bytes[i]) {
                    Some(v) => *slot = v as f32 / 15.0,
                    None => return fallback,
                }
            }
            out
        }
        6 => {
            let mut out = [0.0f32; 3];
            for (i, slot) in out.iter_mut().enumerate() {
                match (hex_nibble(bytes[i * 2]), hex_nibble(bytes[i * 2 + 1])) {
                    (Some(hi), Some(lo)) => *slot = (hi * 16 + lo) as f32 / 255.0,
                    _ => return fallback,
                }
            }
            out
        }
        _ => fallback,
    }
}

/// 键色里最占优的通道（溢色抑制要往这个通道下手）。
fn dominant_channel(key: [f32; 3]) -> usize {
    if key[1] >= key[0] && key[1] >= key[2] {
        1
    } else if key[0] >= key[2] {
        0
    } else {
        2
    }
}

/// 色度抠图（简单的色度键，用户点名要的基础能力）。
///
/// 以 `key_color` 为键色，算像素与键色的 RGB 距离：距离越小越像背景，透明度越低。
/// `tolerance` 是判定为背景的范围，`feather` 是过渡带宽度（避免锯齿硬边），
/// `edge` 正数收缩、负数扩张边缘，`spill` 压低键色主通道的溢出（绿幕的「绿边」）。
/// `matte` 为真时直接输出黑白遮罩（便于检查键控结果）。
pub fn keyer(
    input: &Frame,
    key_color: &str,
    tolerance: f32,
    feather: f32,
    spill: f32,
    edge: f32,
    matte: bool,
) -> Frame {
    const MAX_DIST: f32 = 1.732_050_8; // √3：RGB 立方体的体对角线长度。
    let key = parse_hex_color(key_color);
    let tol = (tolerance.max(0.0) / 100.0 * MAX_DIST).max(0.0);
    let feather = (feather.max(0.0) / 100.0 * MAX_DIST).max(1e-4);
    // edge 正数收缩：把阈值往外推，更少像素被判成背景。
    let bias = edge / 100.0 * 0.5;
    let lo = tol + bias;
    let hi = lo + feather;
    let spill_k = (spill / 100.0).clamp(0.0, 1.0);
    let dominant = dominant_channel(key);

    let mut out = input.clone();
    for idx in (0..input.pixels.len()).step_by(4) {
        let r = input.pixels[idx];
        let g = input.pixels[idx + 1];
        let b = input.pixels[idx + 2];
        let dist = ((r - key[0]).powi(2) + (g - key[1]).powi(2) + (b - key[2]).powi(2)).sqrt();
        // 距离小于 lo 全归背景，大于 hi 全保留，中间是过渡。
        let keep = smoothstep(lo, hi, dist);

        if matte {
            out.pixels[idx] = keep;
            out.pixels[idx + 1] = keep;
            out.pixels[idx + 2] = keep;
            out.pixels[idx + 3] = 1.0;
            continue;
        }

        out.pixels[idx + 3] = input.pixels[idx + 3] * keep;

        // 溢色抑制：把键色占优的那个通道压到另外两个通道的上限附近。
        if spill_k > 0.0 {
            let (o1, o2) = match dominant {
                0 => (1, 2),
                1 => (0, 2),
                _ => (0, 1),
            };
            let ceiling = out.pixels[idx + o1].max(out.pixels[idx + o2]);
            let v = out.pixels[idx + dominant];
            if v > ceiling {
                out.pixels[idx + dominant] = ceiling + (v - ceiling) * (1.0 - spill_k);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 蒙版 / 形状遮罩
// ---------------------------------------------------------------------------

/// 圆角矩形的有符号距离：负值在内部，正值在外部。
fn sd_rounded_rect(px: f32, py: f32, half_w: f32, half_h: f32, radius: f32) -> f32 {
    let r = radius.min(half_w).min(half_h).max(0.0);
    let qx = px.abs() - (half_w - r);
    let qy = py.abs() - (half_h - r);
    let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
    outside + qx.max(qy).min(0.0) - r
}

/// 正 n 边形的有符号距离：顶点均匀铺在长短半轴为 `half_w` / `half_h` 的椭圆上。
/// 用凸多边形的半平面表示——取各边带符号距离的最大值。负值在内部。
fn sd_regular_polygon(px: f32, py: f32, half_w: f32, half_h: f32, n: usize) -> f32 {
    use std::f32::consts::PI;
    let n = n.max(3);
    if half_w <= 0.0 || half_h <= 0.0 {
        return f32::INFINITY;
    }
    let mut dist = f32::NEG_INFINITY;
    for i in 0..n {
        let a0 = 2.0 * PI * i as f32 / n as f32;
        let a1 = 2.0 * PI * (i + 1) as f32 / n as f32;
        let v0 = (half_w * a0.cos(), half_h * a0.sin());
        let v1 = (half_w * a1.cos(), half_h * a1.sin());
        let mx = v0.0 + v1.0;
        let my = v0.1 + v1.1;
        let len = (mx * mx + my * my).sqrt().max(1e-6);
        let (nx, ny) = (mx / len, my / len);
        let apothem = v0.0 * nx + v0.1 * ny;
        dist = dist.max(px * nx + py * ny - apothem);
    }
    dist
}

/// 形状蒙版（形状 / 钢笔 / 跟踪共用一套求解器）。
///
/// `shape` 取 `rect` / `pen` / `track`：`rect` 是带圆角的矩形，
/// `pen` 是把 `points` 个顶点均匀铺在椭圆上的正多边形（钢笔路径在参考实现里的近似，
/// 真正的贝塞尔路径由上游解析后逐点传入），`track` 与 `rect` 同形、中心点将来由
/// 跟踪数据驱动。结果乘到输入的透明度上：`feather` 给出羽化宽度，`invert` 内外反转。
#[allow(clippy::too_many_arguments)]
pub fn mask_shape(
    input: &Frame,
    shape: &str,
    points: usize,
    center_x: f32,
    center_y: f32,
    width: f32,
    height: f32,
    roundness: f32,
    rotation: f32,
    feather: f32,
    invert: bool,
) -> Frame {
    let w = input.width as f32;
    let h = input.height as f32;
    let cx = center_x / 100.0 * w;
    let cy = center_y / 100.0 * h;
    // 宽高按画面尺寸的百分比算：100 表示铺满整幅。
    let half_w = (width / 100.0 * w * 0.5).max(0.0);
    let half_h = (height / 100.0 * h * 0.5).max(0.0);
    let r = roundness.clamp(0.0, 100.0) / 100.0 * half_w.min(half_h);
    let (sin_r, cos_r) = (-rotation.to_radians()).sin_cos();
    // 羽化以画面短边为基准，0 表示硬边。
    let f = feather.clamp(0.0, 100.0) / 100.0 * w.min(h) * 0.5;
    let is_pen = shape == "pen";

    let mut out = input.clone();
    for y in 0..input.height {
        for x in 0..input.width {
            // 转到「以蒙版中心为原点、已旋转」的坐标系。
            let dx0 = x as f32 + 0.5 - cx;
            let dy0 = y as f32 + 0.5 - cy;
            let dx = dx0 * cos_r - dy0 * sin_r;
            let dy = dx0 * sin_r + dy0 * cos_r;
            let signed = if is_pen {
                sd_regular_polygon(dx, dy, half_w, half_h, points)
            } else {
                sd_rounded_rect(dx, dy, half_w, half_h, r)
            };
            let mut coverage = if f <= 1e-4 {
                if signed <= 0.0 {
                    1.0
                } else {
                    0.0
                }
            } else {
                1.0 - smoothstep(-f, f, signed)
            };
            if invert {
                coverage = 1.0 - coverage;
            }
            let idx = (y * input.width + x) * 4;
            out.pixels[idx + 3] = input.pixels[idx + 3] * coverage;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 粒子系统
// ---------------------------------------------------------------------------

/// 在帧上叠一个软边圆点。`additive` 为真时用加色混合，否则按正常遮挡混合。
fn paint_disc(
    frame: &mut Frame,
    cx: f32,
    cy: f32,
    radius: f32,
    rgb: [f32; 3],
    alpha: f32,
    additive: bool,
) {
    let r = radius.max(0.0);
    if r < 0.01 || alpha <= 0.0 {
        return;
    }
    let x0 = (cx - r).floor().max(0.0) as usize;
    let y0 = (cy - r).floor().max(0.0) as usize;
    let x1 = (cx + r).ceil().clamp(0.0, frame.width as f32 - 1.0) as usize;
    let y1 = (cy + r).ceil().clamp(0.0, frame.height as f32 - 1.0) as usize;
    if x1 < x0 || y1 < y0 || cx + r < 0.0 || cy + r < 0.0 {
        return;
    }
    let soft = (r * 0.5).max(0.5);
    for y in y0..=y1 {
        for x in x0..=x1 {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let d = (dx * dx + dy * dy).sqrt();
            if d > r + soft {
                continue;
            }
            let a = ((1.0 - smoothstep(r - soft, r, d)) * alpha).clamp(0.0, 1.0);
            if a <= 0.0 {
                continue;
            }
            let idx = (y * frame.width + x) * 4;
            if additive {
                frame.pixels[idx] = (frame.pixels[idx] + rgb[0] * a).min(1.0);
                frame.pixels[idx + 1] = (frame.pixels[idx + 1] + rgb[1] * a).min(1.0);
                frame.pixels[idx + 2] = (frame.pixels[idx + 2] + rgb[2] * a).min(1.0);
                frame.pixels[idx + 3] = (frame.pixels[idx + 3] + a).min(1.0);
            } else {
                let inv = 1.0 - a;
                frame.pixels[idx] = frame.pixels[idx] * inv + rgb[0] * a;
                frame.pixels[idx + 1] = frame.pixels[idx + 1] * inv + rgb[1] * a;
                frame.pixels[idx + 2] = frame.pixels[idx + 2] * inv + rgb[2] * a;
                frame.pixels[idx + 3] = (frame.pixels[idx + 3] * inv + a).min(1.0);
            }
        }
    }
}

/// 粒子系统（CPU 参考实现，单帧快照）。
///
/// 稳态在场上约有 `rate × lifetime` 个粒子（上限 `maxParticles`）。每个粒子的年龄
/// 用确定性伪随机铺在 `0 ~ lifetime` 上，于是**同一组参数永远得到同一张快照**——
/// 这是求值可复现的前提。真正的动画由时间线把「年龄随时钟推进」喂进来，
/// GPU 版照抄这套运动公式（初速度 + 扩散角 + 重力 + 阻力 + 湍流）。
#[allow(clippy::too_many_arguments)]
pub fn particles(
    input: &Frame,
    emitter: &str,
    rate: f32,
    lifetime: f32,
    speed: f32,
    direction: f32,
    spread: f32,
    gravity: f32,
    drag: f32,
    turbulence: f32,
    size_start: f32,
    size_end: f32,
    opacity_end: f32,
    color: &str,
    blend_mode: &str,
    max_particles: f32,
) -> Frame {
    let w = input.width as f32;
    let h = input.height as f32;
    let rgb = parse_hex_color(color);
    let life = lifetime.max(1e-3);
    let cap = max_particles.max(1.0) as usize;
    let count = ((rate.max(0.0) * life).round() as usize).min(cap);
    let additive = matches!(blend_mode, "add" | "screen" | "加" | "叠加");
    // 发射器位置：点发射在画面中心，边发射在底边中点。
    let (ox, oy) = match emitter {
        "edge" | "line" | "边" => (w * 0.5, h),
        _ => (w * 0.5, h * 0.5),
    };
    let seed = 0x51ED_1E55;

    let mut out = input.clone();
    for i in 0..count {
        let age = hash01(i, 0, seed) * life;
        let jitter = (hash01(i, 1, seed) - 0.5) * spread;
        let ang = (direction + jitter).to_radians();
        let sp = speed.max(0.0) * (0.6 + 0.4 * hash01(i, 2, seed));
        let vx = ang.cos() * sp;
        let vy = -ang.sin() * sp; // 画面 y 轴朝下，向上为负。
        // 有阻力时速度指数衰减，位移取积分；无阻力就是匀速。
        let (travel_x, travel_y) = if drag > 1e-4 {
            let f = (1.0 - (-drag * age).exp()) / drag;
            (vx * f, vy * f)
        } else {
            (vx * age, vy * age)
        };
        let mut x = ox + travel_x;
        let mut y = oy + travel_y + 0.5 * gravity * age * age;
        if turbulence > 0.0 {
            x += turbulence * (age * 3.0 + i as f32).sin() * 0.5;
            y += turbulence * (age * 2.3 + i as f32).cos() * 0.5;
        }

        let t = (age / life).clamp(0.0, 1.0);
        let size = size_start + (size_end - size_start) * t;
        let alpha = 1.0 + (opacity_end / 100.0 - 1.0) * t;
        paint_disc(&mut out, x, y, size * 0.5, rgb, alpha, additive);
    }
    out
}

// ---------------------------------------------------------------------------
// 分派
// ---------------------------------------------------------------------------

/// 从参数字典里取一个数值，缺省或类型不符时用 `default`。
fn num(params: &HashMap<String, ParamValue>, key: &str, default: f32) -> f32 {
    params
        .get(key)
        .and_then(ParamValue::as_f64)
        .map(|v| v as f32)
        .unwrap_or(default)
}

/// 从参数字典里取一个文本，缺省时用 `default`。
fn text<'a>(params: &'a HashMap<String, ParamValue>, key: &str, default: &'a str) -> &'a str {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or(default)
}

/// 从参数字典里取一个布尔，缺省或类型不符时用 `default`。
fn flag(params: &HashMap<String, ParamValue>, key: &str, default: bool) -> bool {
    params
        .get(key)
        .and_then(ParamValue::as_bool)
        .unwrap_or(default)
}

/// 按效果类型分派到对应内核。
///
/// `source` 是第二路画面，只有「混合 / 合并」这类双输入合成效果才用得到；
/// 单输入效果直接忽略它。
/// 未知类型返回 `None`——上层据此报中文错误，而不是静默出一张空帧。
pub fn apply(
    effect_type: &str,
    params: &HashMap<String, ParamValue>,
    input: &Frame,
    source: Option<&Frame>,
) -> Option<Frame> {
    let out = match effect_type {
        // 结构性节点：序列 / 片段 / 输出只做直通，画面由上游喂入。
        "sequence" | "clip" | "output" => input.clone(),
        // 变换。
        "transform" => transform(
            input,
            num(params, "posX", 0.0),
            num(params, "posY", 0.0),
            num(params, "scale", 100.0),
            num(params, "rotation", 0.0),
            num(params, "anchorX", 0.0),
            num(params, "anchorY", 0.0),
            num(params, "skew", 0.0),
        ),
        "crop" => crop(
            input,
            num(params, "top", 0.0),
            num(params, "bottom", 0.0),
            num(params, "left", 0.0),
            num(params, "right", 0.0),
        ),
        "mirror" => mirror(input, text(params, "mode", "horizontal") != "vertical"),
        // 输入 / 生成。
        "color" => solid_color(
            input,
            text(params, "color", "#FFFFFF"),
            num(params, "opacity", 100.0),
        ),
        // 颜色。
        "grade" => grade(
            input,
            num(params, "exposure", 0.0),
            num(params, "contrast", 0.0),
            num(params, "saturation", 0.0),
            num(params, "temperature", 0.0),
            num(params, "tint", 0.0),
            num(params, "highlights", 0.0),
            num(params, "shadows", 0.0),
        ),
        "curves" => curves(input, num(params, "strength", 100.0)),
        "lut" => lut(input, text(params, "file", "")),
        "mono" => mono(
            input,
            flag(params, "grayscale", true),
            num(params, "hue", 0.0),
            num(params, "strength", 100.0),
        ),
        // 滤镜。
        "blur" => blur(input, num(params, "radius", 12.0)),
        "sharpen" => sharpen(
            input,
            num(params, "strength", 50.0),
            num(params, "radius", 3.0),
        ),
        "glow" => glow(
            input,
            num(params, "threshold", 70.0),
            num(params, "radius", 24.0),
            num(params, "strength", 60.0),
        ),
        "noise" => noise(
            input,
            num(params, "strength", 20.0),
            num(params, "scale", 1.0),
            num(params, "speed", 0.0),
        ),
        "mosaic" => mosaic(input, num(params, "blockSize", 16.0)),
        // 合成类：不透明度按百分比换算成 0 ~ 1 的系数。
        "opacity" => opacity(input, num(params, "opacity", 100.0) / 100.0),
        "mask" => mask_apply(
            input,
            source,
            flag(params, "invert", false),
            num(params, "feather", 0.0),
        ),
        "blend" => blend(
            input,
            source?,
            text(params, "mode", "normal"),
            num(params, "opacity", 100.0),
        ),
        "merge" => merge(input, source?, text(params, "mode", "add")),
        "keyer" => keyer(
            input,
            text(params, "keyColor", "#00FF00"),
            num(params, "tolerance", 20.0),
            num(params, "feather", 4.0),
            num(params, "spill", 30.0),
            num(params, "edge", 0.0),
            text(params, "view", "result") == "matte",
        ),
        "maskShape" | "maskPen" | "maskTrack" => mask_shape(
            input,
            text(params, "shape", "rect"),
            num(params, "points", 6.0).max(3.0) as usize,
            num(params, "centerX", 50.0),
            num(params, "centerY", 50.0),
            num(params, "width", 60.0),
            num(params, "height", 60.0),
            num(params, "roundness", 0.0),
            num(params, "rotation", 0.0),
            num(params, "feather", 0.0),
            flag(params, "invert", false),
        ),
        "particles" => particles(
            input,
            text(params, "emitter", "point"),
            num(params, "rate", 60.0),
            num(params, "lifetime", 2.0),
            num(params, "speed", 120.0),
            num(params, "direction", 90.0),
            num(params, "spread", 30.0),
            num(params, "gravity", 200.0),
            num(params, "drag", 0.0),
            num(params, "turbulence", 0.0),
            num(params, "sizeStart", 20.0),
            num(params, "sizeEnd", 0.0),
            num(params, "opacityEnd", 0.0),
            text(params, "color", "#57c08f"),
            text(params, "blendMode", "normal"),
            num(params, "maxParticles", 1000.0),
        ),
        _ => return None,
    };
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(pairs: &[(&str, ParamValue)]) -> HashMap<String, ParamValue> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect()
    }

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-3
    }

    #[test]
    fn frame_constructor_keeps_minimum_size() {
        let f = Frame::new(0, 0);
        assert_eq!(f.width, 1);
        assert_eq!(f.height, 1);
        assert_eq!(f.pixels.len(), 4);
    }

    #[test]
    fn sample_at_integer_coords_returns_pixel() {
        let mut f = Frame::new(4, 4);
        f.set_pixel(2, 3, [0.1, 0.2, 0.3, 0.4]);
        let p = f.sample(2.0, 3.0);
        assert!(approx(p[0], 0.1));
        assert!(approx(p[1], 0.2));
        assert!(approx(p[2], 0.3));
        assert!(approx(p[3], 0.4));
    }

    #[test]
    fn blur_leaves_flat_field_unchanged() {
        let f = Frame::filled(16, 16, [0.4, 0.5, 0.6, 1.0]);
        let out = blur(&f, 3.0);
        for px in out.pixels.chunks_exact(4) {
            assert!(approx(px[0], 0.4));
            assert!(approx(px[1], 0.5));
            assert!(approx(px[2], 0.6));
            assert!(approx(px[3], 1.0));
        }
    }

    #[test]
    fn blur_spreads_a_single_bright_pixel() {
        let mut f = Frame::new(9, 9);
        f.set_pixel(4, 4, [1.0, 1.0, 1.0, 1.0]);
        let out = blur(&f, 2.0);
        // 中心变暗、邻居变亮：能量被摊开了。
        assert!(out.pixel(4, 4)[0] < 1.0);
        assert!(out.pixel(5, 4)[0] > 0.0);
    }

    #[test]
    fn grade_exposure_doubles_at_plus_one_ev() {
        let f = Frame::filled(2, 2, [0.25, 0.25, 0.25, 1.0]);
        let out = grade(&f, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        assert!(approx(out.pixel(0, 0)[0], 0.5));
    }

    #[test]
    fn grade_zero_exposure_is_identity() {
        let f = Frame::filled(2, 2, [0.3, 0.6, 0.9, 1.0]);
        let out = grade(&f, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        for (a, b) in out.pixels.iter().zip(f.pixels.iter()) {
            assert!(approx(*a, *b), "中性参数应当恒等：{a} 与 {b}");
        }
    }

    #[test]
    fn opacity_scales_alpha_only() {
        let f = Frame::filled(2, 2, [0.2, 0.4, 0.6, 1.0]);
        let out = opacity(&f, 0.5);
        let p = out.pixel(0, 0);
        assert!(approx(p[3], 0.5));
        assert!(approx(p[0], 0.2));
        assert!(approx(p[2], 0.6));
    }

    #[test]
    fn mono_equalizes_rgb_channels() {
        let f = Frame::filled(2, 2, [1.0, 0.0, 0.0, 1.0]);
        let p = mono(&f, true, 0.0, 100.0).pixel(0, 0);
        assert!(approx(p[0], p[1]));
        assert!(approx(p[1], p[2]));
        assert!(approx(p[0], 0.2126));
    }

    #[test]
    fn mirror_horizontal_flips_columns() {
        let mut f = Frame::new(3, 1);
        f.set_pixel(0, 0, [1.0, 0.0, 0.0, 1.0]);
        let out = mirror(&f, true);
        assert!(approx(out.pixel(2, 0)[0], 1.0));
        assert!(approx(out.pixel(0, 0)[0], 0.0));
    }

    #[test]
    fn keyer_removes_key_color() {
        let f = Frame::filled(4, 4, [0.0, 1.0, 0.0, 1.0]);
        let out = keyer(&f, "#00FF00", 20.0, 4.0, 0.0, 0.0, false);
        for px in out.pixels.chunks_exact(4) {
            assert!(px[3] < 1e-3, "键色应当被抠掉：{}", px[3]);
        }
    }

    #[test]
    fn keyer_keeps_unrelated_colors() {
        let f = Frame::filled(4, 4, [1.0, 0.0, 0.0, 1.0]);
        let out = keyer(&f, "#00FF00", 20.0, 4.0, 0.0, 0.0, false);
        for px in out.pixels.chunks_exact(4) {
            assert!(approx(px[3], 1.0), "非键色应当保留：{}", px[3]);
        }
    }

    #[test]
    fn keyer_matte_renders_grayscale() {
        let mut f = Frame::filled(2, 2, [0.0, 1.0, 0.0, 1.0]);
        f.set_pixel(0, 0, [1.0, 0.0, 0.0, 1.0]);
        let out = keyer(&f, "#00FF00", 20.0, 4.0, 0.0, 0.0, true);
        assert!(approx(out.pixel(0, 0)[3], 1.0), "遮罩视图应当不透明");
        assert!(out.pixel(0, 0)[0] > 0.9, "非键色在遮罩里是白");
        assert!(out.pixel(1, 0)[0] < 0.1, "键色在遮罩里是黑");
    }

    #[test]
    fn mask_shape_center_opaque_corners_transparent() {
        let f = Frame::filled(32, 32, [1.0, 1.0, 1.0, 1.0]);
        let out = mask_shape(&f, "rect", 6, 50.0, 50.0, 40.0, 40.0, 0.0, 0.0, 0.0, false);
        assert!(approx(out.pixel(16, 16)[3], 1.0), "蒙版中心应当保留");
        assert!(out.pixel(0, 0)[3] < 1e-3, "蒙版外应当透明");
    }

    #[test]
    fn mask_shape_invert_flips_coverage() {
        let f = Frame::filled(32, 32, [1.0, 1.0, 1.0, 1.0]);
        let out = mask_shape(&f, "rect", 6, 50.0, 50.0, 40.0, 40.0, 0.0, 0.0, 0.0, true);
        assert!(out.pixel(16, 16)[3] < 1e-3, "反转后中心应当透明");
        assert!(approx(out.pixel(0, 0)[3], 1.0), "反转后外部应当保留");
    }

    #[test]
    fn mask_pen_keeps_center_and_clips_corner() {
        let f = Frame::filled(32, 32, [1.0, 1.0, 1.0, 1.0]);
        let out = mask_shape(&f, "pen", 6, 50.0, 50.0, 40.0, 40.0, 0.0, 0.0, 0.0, false);
        assert!(approx(out.pixel(16, 16)[3], 1.0), "钢笔蒙版中心应当保留");
        assert!(out.pixel(0, 0)[3] < 1e-3, "多边形角落应当透明");
    }

    #[test]
    fn particles_paints_something_and_is_deterministic() {
        let base = Frame::filled(64, 64, [0.0, 0.0, 0.0, 1.0]);
        let render = || {
            particles(
                &base, "point", 60.0, 2.0, 120.0, 90.0, 30.0, 200.0, 0.0, 0.0, 20.0, 0.0,
                0.0, "#57c08f", "normal", 1000.0,
            )
        };
        let out = render();
        assert_eq!(out, render(), "同参数必须得到同一张快照");
        let lit = out.pixels.chunks_exact(4).filter(|px| px[1] > 0.05).count();
        assert!(lit > 0, "粒子系统应当画出可见的粒子");
    }

    #[test]
    fn blend_normal_opaque_returns_top() {
        let base = Frame::filled(2, 2, [1.0, 0.0, 0.0, 1.0]);
        let top = Frame::filled(2, 2, [0.0, 0.0, 1.0, 1.0]);
        let p = blend(&base, &top, "normal", 100.0).pixel(0, 0);
        assert!(approx(p[0], 0.0) && approx(p[2], 1.0), "整层不透明应盖住下层");
        assert!(approx(p[3], 1.0));
    }

    #[test]
    fn blend_half_opacity_mixes_channels() {
        let base = Frame::filled(1, 1, [0.0, 0.0, 0.0, 1.0]);
        let top = Frame::filled(1, 1, [1.0, 1.0, 1.0, 1.0]);
        let p = blend(&base, &top, "normal", 50.0).pixel(0, 0);
        assert!(approx(p[0], 0.5), "半透明应得到中值：{}", p[0]);
    }

    #[test]
    fn merge_add_saturates_and_max_picks_brighter() {
        let base = Frame::filled(1, 1, [0.6, 0.0, 0.0, 1.0]);
        let src = Frame::filled(1, 1, [0.6, 0.0, 0.0, 1.0]);
        assert!(approx(merge(&base, &src, "add").pixel(0, 0)[0], 1.0), "加法应夹到 1.0");
        assert!(approx(merge(&base, &src, "max").pixel(0, 0)[0], 0.6));
    }

    #[test]
    fn dispatcher_requires_second_input_for_composite() {
        let f = Frame::filled(2, 2, [0.0, 0.0, 0.0, 1.0]);
        assert!(apply("blend", &params(&[]), &f, None).is_none(), "缺第二路画面应返回 None");
        assert!(apply("merge", &params(&[]), &f, None).is_none());
        assert!(apply("blend", &params(&[]), &f, Some(&f)).is_some());
        assert!(apply("merge", &params(&[]), &f, Some(&f)).is_some());
    }

    #[test]
    fn dispatcher_covers_mandated_effects() {
        let f = Frame::filled(16, 16, [0.5, 0.5, 0.5, 1.0]);
        // 27 个首版效果里，`text` / `image` 依赖字体与素材文件加载，暂未接入；
        // 其余可求值的效果都必须有内核实现，绝不能落进 `_ => None`。
        let kinds = [
            "sequence", "clip", "output", "transform", "crop", "mirror", "color", "grade",
            "curves", "lut", "mono", "blur", "sharpen", "glow", "noise", "mosaic", "opacity",
            "mask", "blend", "merge", "keyer", "maskShape", "maskPen", "maskTrack", "particles",
        ];
        for kind in kinds {
            let out = apply(kind, &params(&[]), &f, Some(&f));
            assert!(out.is_some(), "效果 {kind} 应当有内核实现");
        }
    }

    #[test]
    fn transform_translation_shifts_frame_without_blur() {
        let mut f = Frame::new(8, 8);
        f.set_pixel(1, 1, [1.0, 0.0, 0.0, 1.0]);
        let out = transform(&f, 2.0, 0.0, 100.0, 0.0, 0.0, 0.0, 0.0);
        assert!(approx(out.pixel(3, 1)[0], 1.0), "纯平移应当整数像素搬移，不糊边");
        assert!(approx(out.pixel(1, 1)[0], 0.0), "原位置应当空出来");
    }

    #[test]
    fn transform_scale_leaves_outside_transparent() {
        let f = Frame::filled(8, 8, [1.0, 1.0, 1.0, 1.0]);
        let out = transform(&f, 0.0, 0.0, 50.0, 0.0, 0.0, 0.0, 0.0);
        assert!(out.pixel(0, 0)[3] < 1e-3, "缩小后画布角落应当透明");
        assert!(approx(out.pixel(4, 4)[3], 1.0), "中心应当保留");
    }

    #[test]
    fn transform_identity_is_exact() {
        let f = Frame::filled(6, 6, [0.2, 0.4, 0.6, 1.0]);
        assert_eq!(transform(&f, 0.0, 0.0, 100.0, 0.0, 0.0, 0.0, 0.0), f);
    }

    #[test]
    fn transform_rotation_quarter_turn_moves_right_to_bottom() {
        // 屏幕坐标 y 朝下：顺时针转 90 度，画面右侧的点应当落到下方。
        let mut f = Frame::new(8, 8);
        f.set_pixel(6, 4, [1.0, 0.0, 0.0, 1.0]);
        let out = transform(&f, 0.0, 0.0, 100.0, 90.0, 0.0, 0.0, 0.0);
        assert!(approx(out.pixel(4, 6)[0], 1.0), "右侧红点应当旋转到下方：{:?}", out.pixel(4, 6));
        assert!(out.pixel(6, 4)[3] < 1e-3, "原位置应当空出来");
    }

    #[test]
    fn transform_scales_toward_anchor() {
        // 锚点推到左上角（(-4,-4) 即画布左上），缩放中心随之前移：
        // 源点 (2,2) 在 50% 缩放后应当落到输出 (1,1)。
        let mut f = Frame::new(8, 8);
        f.set_pixel(2, 2, [1.0, 0.0, 0.0, 1.0]);
        let out = transform(&f, 0.0, 0.0, 50.0, 0.0, -4.0, -4.0, 0.0);
        assert!(approx(out.pixel(1, 1)[0], 1.0), "锚点处的缩放应当把 (2,2) 收到 (1,1)：{:?}", out.pixel(1, 1));
    }

    #[test]
    fn crop_zeroes_alpha_on_trimmed_edges() {
        let f = Frame::filled(10, 10, [1.0, 1.0, 1.0, 1.0]);
        let out = crop(&f, 20.0, 0.0, 0.0, 0.0);
        assert!(out.pixel(0, 0)[3] < 1e-3, "顶部裁掉的部分应当透明");
        assert!(approx(out.pixel(0, 5)[3], 1.0), "未裁部分应当保留");
    }

    #[test]
    fn mosaic_makes_blocks_uniform() {
        let mut f = Frame::new(4, 4);
        f.set_pixel(0, 0, [1.0, 0.0, 0.0, 1.0]);
        f.set_pixel(1, 1, [0.0, 1.0, 0.0, 1.0]);
        let out = mosaic(&f, 2.0);
        assert_eq!(out.pixel(0, 0), out.pixel(1, 1), "同一块内应当取同一颜色");
    }

    #[test]
    fn noise_is_deterministic_and_zero_strength_is_identity() {
        let f = Frame::filled(8, 8, [0.5, 0.5, 0.5, 1.0]);
        assert_eq!(noise(&f, 20.0, 1.0, 0.0), noise(&f, 20.0, 1.0, 0.0), "同参数噪声必须可复现");
        assert_eq!(noise(&f, 0.0, 1.0, 0.0), f, "强度 0 应当恒等");
    }

    #[test]
    fn solid_color_fills_frame_with_alpha() {
        let f = Frame::filled(2, 2, [0.0, 0.0, 0.0, 1.0]);
        let p = solid_color(&f, "#57c08f", 50.0).pixel(0, 0);
        assert!(approx(p[1], 0.7529), "绿色通道应当接近 0xc0：{}", p[1]);
        assert!(approx(p[3], 0.5), "不透明度 50% 应换算成 alpha 0.5");
    }

    #[test]
    fn neutral_effects_are_identity() {
        let f = Frame::filled(4, 4, [0.2, 0.4, 0.8, 1.0]);
        assert_eq!(curves(&f, 0.0), f, "曲线强度 0 应当恒等");
        assert_eq!(sharpen(&f, 0.0, 3.0), f, "锐化强度 0 应当恒等");
        assert_eq!(lut(&f, ""), f, "未选 LUT 文件应当恒等");
        assert_eq!(glow(&f, 70.0, 24.0, 0.0), f, "发光强度 0 应当恒等");
    }

    #[test]
    fn mono_hue_tints_white_to_that_hue() {
        let f = Frame::filled(2, 2, [1.0, 1.0, 1.0, 1.0]);
        let p = mono(&f, false, 120.0, 100.0).pixel(0, 0);
        assert!(approx(p[0], 0.0) && approx(p[1], 1.0) && approx(p[2], 0.0), "色相 120 度应为纯绿：{p:?}");
    }

    #[test]
    fn mask_apply_uses_source_frame_as_coverage() {
        let input = Frame::filled(8, 8, [1.0, 1.0, 1.0, 1.0]);
        let black = Frame::new(8, 8);
        let out = mask_apply(&input, Some(&black), false, 0.0);
        assert!(out.pixel(4, 4)[3] < 1e-3, "全黑遮罩应当把画面抠空");
        let white = Frame::filled(8, 8, [1.0, 1.0, 1.0, 1.0]);
        let kept = mask_apply(&input, Some(&white), false, 0.0);
        assert!(approx(kept.pixel(4, 4)[3], 1.0), "全白遮罩应当完整保留");
    }

    #[test]
    fn keyer_removes_key_color_and_keeps_others() {
        // 纯绿背景应当被抠空。
        let green = Frame::filled(4, 4, [0.0, 1.0, 0.0, 1.0]);
        let keyed = keyer(&green, "#00FF00", 20.0, 4.0, 0.0, 0.0, false);
        assert!(keyed.pixel(2, 2)[3] < 1e-3, "键色像素应当变透明");
        // 与键色无关的红色应当完整保留。
        let red = Frame::filled(4, 4, [1.0, 0.0, 0.0, 1.0]);
        let kept = keyer(&red, "#00FF00", 20.0, 4.0, 0.0, 0.0, false);
        assert!(approx(kept.pixel(2, 2)[3], 1.0), "非键色像素应当保留");
    }

    #[test]
    fn keyer_matte_view_returns_coverage_as_gray() {
        let green = Frame::filled(2, 2, [0.0, 1.0, 0.0, 1.0]);
        let matte = keyer(&green, "#00FF00", 20.0, 4.0, 0.0, 0.0, true);
        let p = matte.pixel(0, 0);
        assert!(approx(p[0], 0.0) && approx(p[1], 0.0) && approx(p[2], 0.0), "遮罩视图下键色应为黑：{p:?}");
        assert!(approx(p[3], 1.0), "遮罩视图本身不透明");
    }

    #[test]
    fn keyer_spill_suppression_pulls_down_dominant_channel() {
        // 全强度溢色抑制：纯绿背景的绿通道应被压到另外两通道的上限附近。
        let green = Frame::filled(2, 2, [0.0, 1.0, 0.0, 1.0]);
        let out = keyer(&green, "#00FF00", 20.0, 4.0, 100.0, 0.0, false);
        assert!(approx(out.pixel(0, 0)[1], 0.0), "溢色抑制开启后绿通道应被拉平：{:?}", out.pixel(0, 0));
    }

    #[test]
    fn dispatcher_returns_none_for_unknown_type() {
        let f = Frame::filled(2, 2, [0.0, 0.0, 0.0, 1.0]);
        assert!(apply("notARealEffect", &params(&[]), &f, None).is_none());
    }

    #[test]
    fn catalog_effects_all_have_implementations() {
        // 节点目录与分派器必须逐项对齐：目录里登记的每个效果都得能在 apply() 里求值。
        // 少数依赖字体、素材文件或后续里程碑的类型显式列入白名单——
        // text / image 要字体与素材加载，composite3d 属三维合成，
        // compound 是 M3 的预合成，camera 属 M5 的相机解算。
        let deferred = ["text", "image", "composite3d", "compound", "camera"];
        let f = Frame::filled(8, 8, [0.5, 0.5, 0.5, 1.0]);
        let catalog = crate::graph::catalog::node_catalog();
        for info in &catalog {
            if deferred.contains(&info.node_type.as_str()) {
                continue;
            }
            assert!(
                apply(&info.node_type, &params(&[]), &f, Some(&f)).is_some(),
                "目录效果「{}」缺少 apply 内核实现",
                info.node_type
            );
        }
        // 白名单里的名字必须真的存在于目录，防止将来改名后白名单悄悄失效。
        for name in deferred {
            assert!(
                catalog.iter().any(|i| i.node_type == name),
                "待接入白名单里的「{name}」不在节点目录中"
            );
        }
    }

    #[test]
    fn dispatcher_reads_numeric_params() {
        let f = Frame::filled(2, 2, [0.25, 0.25, 0.25, 1.0]);
        let out = apply(
            "grade",
            &params(&[
                ("exposure", ParamValue::Number(1.0)),
                ("contrast", ParamValue::Number(1.0)),
                ("saturation", ParamValue::Number(1.0)),
            ]),
            &f,
            None,
        )
        .expect("grade 有内核实现");
        assert!(approx(out.pixel(0, 0)[0], 0.5));
    }

    #[test]
    fn blend_normal_uses_opacity_to_mix_layers() {
        let base = Frame::filled(2, 2, [0.2, 0.2, 0.2, 1.0]);
        let top = Frame::filled(2, 2, [0.8, 0.8, 0.8, 1.0]);
        let p = blend(&base, &top, "normal", 50.0).pixel(0, 0);
        assert!(approx(p[0], 0.5), "normal 模式 50% 不透明度应当取中值：{p:?}");
        assert!(approx(p[3], 1.0), "两层都不透明时结果应当不透明");
    }

    #[test]
    fn blend_zero_opacity_keeps_base() {
        let base = Frame::filled(2, 2, [0.2, 0.4, 0.6, 1.0]);
        let top = Frame::filled(2, 2, [0.9, 0.9, 0.9, 1.0]);
        let out = blend(&base, &top, "normal", 0.0);
        assert_eq!(out.pixel(0, 0), base.pixel(0, 0), "不透明度 0 应当只留下层");
    }

    #[test]
    fn blend_add_sums_channels() {
        let base = Frame::filled(2, 2, [0.2, 0.2, 0.2, 1.0]);
        let top = Frame::filled(2, 2, [0.3, 0.3, 0.3, 1.0]);
        let p = blend(&base, &top, "add", 100.0).pixel(0, 0);
        assert!(approx(p[0], 0.5), "加法模式应当把两路通道相加：{p:?}");
    }

    #[test]
    fn blend_multiply_and_screen_are_known_modes() {
        let base = Frame::filled(2, 2, [0.5, 0.5, 0.5, 1.0]);
        let top = Frame::filled(2, 2, [0.5, 0.5, 0.5, 1.0]);
        let mul = blend(&base, &top, "multiply", 100.0).pixel(0, 0);
        assert!(approx(mul[0], 0.25), "正片叠底应当取乘积：{mul:?}");
        let scr = blend(&base, &top, "screen", 100.0).pixel(0, 0);
        assert!(approx(scr[0], 0.75), "滤色应当为 1-(1-a)(1-b)：{scr:?}");
    }

    #[test]
    fn merge_max_and_difference_modes() {
        let base = Frame::filled(2, 2, [0.2, 0.2, 0.2, 1.0]);
        let src = Frame::filled(2, 2, [0.5, 0.5, 0.5, 1.0]);
        let mx = merge(&base, &src, "max").pixel(0, 0);
        assert!(approx(mx[0], 0.5), "取大模式应当保留更大的通道值：{mx:?}");
        let diff = merge(&base, &src, "difference").pixel(0, 0);
        assert!(approx(diff[0], 0.3), "差值模式应当取绝对差：{diff:?}");
    }

    #[test]
    fn merge_add_clamps_at_one() {
        let base = Frame::filled(2, 2, [0.8, 0.8, 0.8, 1.0]);
        let src = Frame::filled(2, 2, [0.8, 0.8, 0.8, 1.0]);
        let p = merge(&base, &src, "add").pixel(0, 0);
        assert!(approx(p[0], 1.0), "加法合成应当在 1.0 处夹取：{p:?}");
        assert!(approx(p[3], 1.0), "alpha 也应当在 1.0 处夹取");
    }

    #[test]
    fn blur_zero_radius_is_identity() {
        let f = Frame::filled(4, 4, [0.3, 0.6, 0.9, 1.0]);
        assert_eq!(blur(&f, 0.0), f, "半径 0 应当原样返回");
        assert_eq!(blur(&f, 0.4), f, "半径小于半像素时不应产生模糊");
    }

    #[test]
    fn blur_spreads_a_single_dot() {
        let mut f = Frame::new(9, 9);
        f.set_pixel(4, 4, [1.0, 1.0, 1.0, 1.0]);
        let out = blur(&f, 2.0);
        let center = out.pixel(4, 4)[0];
        assert!(center > 0.0 && center < 1.0, "单点的亮度应当被摊开：{center}");
        assert!(out.pixel(6, 4)[0] > 0.0, "模糊应当把能量扩散到邻近像素");
    }

    #[test]
    fn grade_exposure_doubles_mid_gray() {
        let f = Frame::filled(2, 2, [0.25, 0.25, 0.25, 1.0]);
        let p = grade(&f, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0).pixel(0, 0);
        assert!(approx(p[0], 0.5), "曝光 +1EV（增益 2）应当把 0.25 抬到 0.5：{p:?}");
    }

    #[test]
    fn grade_neutral_params_are_identity() {
        let f = Frame::filled(2, 2, [0.2, 0.4, 0.6, 1.0]);
        let out = grade(&f, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        for c in 0..4 {
            assert!(approx(out.pixel(0, 0)[c], f.pixel(0, 0)[c]), "调色全中性时通道 {c} 应当不变");
        }
    }
}
