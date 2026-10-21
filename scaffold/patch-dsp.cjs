const fs = require("fs");

// ===== 1. timeline/model.rs：Clip 加三个音频 DSP 字段 =====
let m = fs.readFileSync("src-tauri/src/timeline/model.rs", "utf8");
if (!m.includes("audio_highpass_hz")) {
  m = m.replace(
    `    /// 音频慢入时长（毫秒）；区间内音量从 0 线性升到满，混音时生效
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_fade_in_ms: Option<f64>,`,
    `    /// 音频慢入时长（毫秒）；区间内音量从 0 线性升到满，混音时生效
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
    pub audio_delay_ms: Option<f64>,`
  );
  // 默认 Clip 构造（transition_in: None 附近）补三个 None
  m = m.replace(
    `            transition_in: None,`,
    `            transition_in: None,
            audio_highpass_hz: None,
            audio_lowpass_hz: None,
            audio_delay_ms: None,`
  );
}
fs.writeFileSync("src-tauri/src/timeline/model.rs", m);

// ===== 2. export.rs mix_audio 里应用 DSP =====
let e = fs.readFileSync("src-tauri/src/commands/export.rs", "utf8");
if (!e.includes("biquad_apply")) {
  // 在 mix_audio 前插 biquad 工具
  const helper = `/// 二阶 biquad 滤波（RBJ 公式）：high_pass 时传 high=true。
/// 对立体声交错 PCM 原地滤波；每声道独立状态。
fn biquad_apply(
    pcm: &mut [f32],
    sample_rate: f64,
    cutoff_hz: f64,
    high_pass: bool,
) {
    let fc = cutoff_hz.clamp(20.0, sample_rate / 2.0 - 100.0);
    let w0 = 2.0 * std::f64::consts::PI * fc / sample_rate;
    let cosw = w0.cos();
    let alpha = w0.sin() / (2.0 * 0.707);
    let (b0, b1, b2, a0, a1, a2) = if high_pass {
        let a0 = 1.0 + alpha;
        (
            ((1.0 + cosw) / 2.0) / a0,
            (-(1.0 + cosw)) / a0,
            ((1.0 + cosw) / 2.0) / a0,
            1.0,
            (-2.0 * cosw) / a0,
            (1.0 - alpha) / a0,
        )
    } else {
        let a0 = 1.0 + alpha;
        (
            ((1.0 - cosw) / 2.0) / a0,
            (1.0 - cosw) / a0,
            ((1.0 - cosw) / 2.0) / a0,
            1.0,
            (-2.0 * cosw) / a0,
            (1.0 - alpha) / a0,
        )
    };
    let mut x1 = [0.0f64; 2];
    let mut x2 = [0.0f64; 2];
    let mut y1 = [0.0f64; 2];
    let mut y2 = [0.0f64; 2];
    for (i, s) in pcm.iter_mut().enumerate() {
        let ch = i % 2;
        let x0 = *s as f64;
        let y0 = b0 * x0 + b1 * x1[ch] + b2 * x2[ch] - a1 * y1[ch] - a2 * y2[ch];
        x2[ch] = x1[ch];
        x1[ch] = x0;
        y2[ch] = y1[ch];
        y1[ch] = y0;
        *s = y0 as f32;
    }
}

/// 延迟回声：delay_ms 后叠一层 0.35 衰减的原声（单次，不无限循环）。
fn echo_apply(pcm: &mut [f32], sample_rate: f64, delay_ms: f64) {
    let d = ((delay_ms / 1000.0) * sample_rate).round() as usize * 2;
    if d == 0 || d >= pcm.len() {
        return;
    }
    for i in (0..pcm.len() - d).rev() {
        pcm[i + d] += pcm[i] * 0.35;
    }
}

/// 把范围内所有带音轨的片段混成一条立体声 PCM，落临时文件。`;
  e = e.replace("/// 把范围内所有带音轨的片段混成一条立体声 PCM，落临时文件。", helper);
}
// 混音里应用：gain 计算之后
if (!e.includes("biquad_apply(&mut seg, ")) {
  e = e.replace(
    `            // 按立体声帧算片段内偏移：淡入淡出只与时间线位置有关，`,
    `            // 音频 DSP（片段级）：高通/低通/回声——按clip参数对这段PCM原地处理
            let mut seg = pcm[..avail].to_vec();
            if let Some(hp) = clip.audio_highpass_hz {
                biquad_apply(&mut seg, MIX_SAMPLE_RATE as f64, hp, true);
            }
            if let Some(lp) = clip.audio_lowpass_hz {
                biquad_apply(&mut seg, MIX_SAMPLE_RATE as f64, lp, false);
            }
            if let Some(dl) = clip.audio_delay_ms {
                if dl > 1.0 {
                    echo_apply(&mut seg, MIX_SAMPLE_RATE as f64, dl);
                }
            }
            // 按立体声帧算片段内偏移：淡入淡出只与时间线位置有关，`
  );
  e = e.replace(
    `                mix[offset + frame * 2] += pair[0] * gain;
                mix[offset + frame * 2 + 1] += pair[1] * gain;`,
    `                mix[offset + frame * 2] += pair[0] * gain;
                mix[offset + frame * 2 + 1] += pair[1] * gain;`
  );
  // 循环数据源从 pcm 改为 seg
  e = e.replace(
    "            for (frame, pair) in pcm[..avail].chunks_exact(2).enumerate() {",
    "            for (frame, pair) in seg[..avail].chunks_exact(2).enumerate() {"
  );
}
fs.writeFileSync("src-tauri/src/commands/export.rs", e);

// ===== 3. set_audio_fade 同款：set_audio_dsp 命令 =====
let tl = fs.readFileSync("src-tauri/src/commands/timeline.rs", "utf8");
if (!tl.includes("pub fn set_audio_dsp")) {
  tl += `

/// 设置片段音频 DSP：高通/低通截止（Hz，null 关）、回声延迟（ms，null 关）。
#[tauri::command]
pub fn set_audio_dsp(
    clip_id: String,
    highpass_hz: Option<f64>,
    lowpass_hz: Option<f64>,
    delay_ms: Option<f64>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut guard = require_project(&state)?;
    let project = guard.as_mut().ok_or_else(|| "还没有打开项目".to_string())?;
    let clip = find_clip_mut(project, &clip_id).ok_or_else(|| "找不到该片段".to_string())?;
    clip.audio_highpass_hz = highpass_hz.filter(|v| *v > 20.0);
    clip.audio_lowpass_hz = lowpass_hz.filter(|v| *v > 20.0);
    clip.audio_delay_ms = delay_ms.filter(|v| *v > 1.0);
    record(&state, "设置音频处理", project)?;
    *lock(&state.project_dirty)? = true;
    Ok(true)
}
`;
}
fs.writeFileSync("src-tauri/src/commands/timeline.rs", tl);

// ===== 4. 注册命令 =====
let lib = fs.readFileSync("src/lib.rs", "utf8");
if (!lib.includes("set_audio_dsp")) {
  lib = lib.replace(
    "            commands::timeline::set_transition,",
    "            commands::timeline::set_transition,\n            commands::timeline::set_audio_dsp,"
  );
}
fs.writeFileSync("src/lib.rs", lib);

console.log("ok");
