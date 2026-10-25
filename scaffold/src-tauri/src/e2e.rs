//! 端到端验真：拿真实素材走一遍，证明 Reelix 是真能剪的，不是摆样子。
//!
//! 这里不 mock、不造假帧——直接打开小组作业里的片子，探测、上轨、
//! 排出渲染计划、真的解一帧出来看。素材不在机器上时自动跳过，
//! 免得没有这些文件的机器（CI）跑测试挂掉。

#![cfg(test)]

use std::collections::HashMap;

use crate::commands::render::{plan_frame, render_plan};
use crate::graph::node::{GraphNode, ParamValue};
use crate::keyframe::store::KeyframeStore;
use crate::media::probe;
use crate::project::model::{Asset, AssetKind};
use crate::project::serialize;
use crate::timeline::model::Clip;

/// 小组作业里的一段真实片子。
const REAL_VIDEO: &str = r"C:\Users\ASUS\Videos\小组作业\jason go to school.mp4";
/// 壁纸目录里的真实照片（用户指定的一组，不是 Wallpaper 里那堆猫）。
const REAL_PHOTO: &str = r"C:\Users\ASUS\Pictures\壁纸\2000975.jpg";

fn exists(path: &str) -> bool {
    std::path::Path::new(path).exists()
}

/// 按现有 fixture 的固定口味造一个片段（字段一个不落，避免缺省值偷偷歪掉）。
fn clip(id: &str, asset_id: &str, track_id: &str, start_ms: f64, duration_ms: f64) -> Clip {
    Clip {
        id: id.into(),
        asset_id: asset_id.into(),
        track_id: track_id.into(),
        start_ms,
        duration_ms,
        in_ms: 0.0,
        out_ms: duration_ms,
        speed: 1.0,
        reversed: false,
        speed_curve: None,
        audio_pitch_shift: false,
        node_id: "node-asset".into(),
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

/// 真实视频能出真画面：从探测 → 上轨 → 排计划 → 解帧，整条链路走得通，
/// 且解出来的是有内容的图（不是全黑占位、也不是全白糊弄）。
#[test]
fn real_footage_renders_an_actual_frame() {
    if !exists(REAL_VIDEO) {
        eprintln!("端到端跳过：这台机器上没有 {REAL_VIDEO}");
        return;
    }
    let info = probe::probe_path(REAL_VIDEO);
    assert!(info.duration_ms > 0.0, "素材探测应给出正时长：{info:?}");
    assert!(info.width > 0 && info.height > 0, "素材探测应给出画幅：{info:?}");

    let mut project = serialize::new_project_with("小组作业端到端", 640, 360, 25.0, "Rec.709");
    let sequence_id = project.sequences[0].id.clone();
    let track_id = project.sequences[0].tracks[0].id.clone();

    project.assets.push(Asset {
        id: "asset-video".into(),
        path: REAL_VIDEO.into(),
        name: "jason go to school.mp4".into(),
        kind: AssetKind::Video,
        duration_ms: info.duration_ms,
        width: info.width,
        height: info.height,
        frame_rate: info.frame_rate,
        codec: info.codec.clone(),
        has_audio: info.has_audio,
        missing: false,
        bin_id: None,
    });
    project.sequences[0].tracks[0]
        .clips
        .push(clip("clip-video", "asset-video", &track_id, 0.0, info.duration_ms));
    project.sequences[0].duration_ms = info.duration_ms;

    let store = KeyframeStore::new();
    // 取片子里第 1 秒处的一帧
    let plan = plan_frame(&project, &sequence_id, 1000.0, (640, 360), &store)
        .expect("这一刻应当排得出渲染计划");
    plan.source
        .as_ref()
        .expect("片头 1 秒处应当有画面来源");

    let frame = render_plan(&plan).expect("应当真的解出一帧画面");
    assert_eq!(frame.width, 640);
    assert_eq!(frame.height, 360);

    // 画面必须有内容：既不是全黑（没解码），也不是纯白（解码器给占位图）
    let pixels = (frame.width * frame.height) as f64;
    let mut sum = 0.0_f64;
    for p in frame.pixels.chunks_exact(4) {
        sum += (p[0] + p[1] + p[2]) as f64;
    }
    let mean = sum / (pixels * 3.0);
    assert!(mean > 0.001, "整帧几乎全黑（均值 {mean}），说明没解出真实画面");
    assert!(mean < 0.99, "整帧几乎全白（均值 {mean}），可疑，不像是真解码的结果");
}

/// 真实照片能当静止素材上轨：图片素材走得是同一条渲染链路。
#[test]
fn real_photo_renders_as_a_still() {
    if !exists(REAL_PHOTO) {
        eprintln!("端到端跳过：这台机器上没有 {REAL_PHOTO}");
        return;
    }
    let info = probe::probe_path(REAL_PHOTO);
    let mut project = serialize::new_project_with("照片端到端", 480, 270, 25.0, "Rec.709");
    let sequence_id = project.sequences[0].id.clone();
    let track_id = project.sequences[0].tracks[0].id.clone();

    project.assets.push(Asset {
        id: "asset-photo".into(),
        path: REAL_PHOTO.into(),
        name: "2000975.jpg".into(),
        kind: AssetKind::Image,
        duration_ms: info.duration_ms,
        width: info.width,
        height: info.height,
        frame_rate: info.frame_rate,
        codec: info.codec.clone(),
        has_audio: info.has_audio,
        missing: false,
        bin_id: None,
    });
    project.sequences[0].tracks[0].clips.push(
        clip("clip-photo", "asset-photo", &track_id, 0.0, 3000.0));
    project.sequences[0].duration_ms = 3000.0;

    let store = KeyframeStore::new();
    let plan = plan_frame(&project, &sequence_id, 500.0, (480, 270), &store)
        .expect("照片片段应当排得出渲染计划");
    let frame = render_plan(&plan).expect("照片应当真的解出一帧");
    let mut sum = 0.0_f64;
    for p in frame.pixels.chunks_exact(4) {
        sum += (p[0] + p[1] + p[2]) as f64;
    }
    let mean = sum / ((frame.width * frame.height) as f64 * 3.0);
    assert!(mean > 0.001, "照片帧几乎全黑（均值 {mean}），没解出图片内容");
}

/// 摄像机不是摆设：图里挂了 camera 节点，渲染计划必须真的把取景参数带上。
///
/// 这一条专门盯「建得出摄像机、拖得动，渲染时却一眼不看它」的老毛病。
#[test]
fn camera_node_is_wired_into_the_render_plan() {
    let mut project = serialize::new_project_with("摄像机接线", 640, 360, 25.0, "Rec.709");
    let sequence_id = project.sequences[0].id.clone();
    let graph_id = project.sequences[0].root_graph_id.clone();

    let graph = project
        .graphs
        .get_mut(&graph_id)
        .expect("新工程应当带根图");
    let mut params: HashMap<String, ParamValue> = HashMap::new();
    params.insert("posX".into(), ParamValue::Number(120.0));
    params.insert("posY".into(), ParamValue::Number(-40.0));
    params.insert("posZ".into(), ParamValue::Number(-640.0));
    params.insert("focalLength".into(), ParamValue::Number(35.0));
    graph.nodes.push(GraphNode {
        id: "camera-node".into(),
        node_type: "camera".into(),
        name: "摄像机".into(),
        x: 0.0,
        y: 0.0,
        params,
        bypassed: false,
        collapsed: false,
        animated: false,
        inputs: Vec::new(),
        outputs: Vec::new(),
    });

    let store = KeyframeStore::new();
    let plan = plan_frame(&project, &sequence_id, 0.0, (640, 360), &store)
        .expect("应当排得出渲染计划");
    let cam = plan
        .camera
        .expect("图里挂了摄像机节点，渲染计划里就必须带上取景参数");
    assert!((cam.position[0] - 120.0).abs() < 1e-6, "摄像机 X 应当透传到 plan：{:?}", cam.position);
    assert!((cam.position[1] - (-40.0)).abs() < 1e-6, "摄像机 Y 应当透传：{:?}", cam.position);
    assert!((cam.position[2] - (-640.0)).abs() < 1e-6, "摄像机 Z 应当透传：{:?}", cam.position);
    assert!((cam.focal_length - 35.0).abs() < 1e-6, "焦距应当透传：{}", cam.focal_length);
}

/// 没挂摄像机时不该凭空冒出取景参数，避免改动影响原有片子的观感。
#[test]
fn no_camera_node_means_no_camera_in_plan() {
    let project = serialize::new_project_with("无摄像机", 320, 180, 25.0, "Rec.709");
    let sequence_id = project.sequences[0].id.clone();
    let store = KeyframeStore::new();
    let plan = plan_frame(&project, &sequence_id, 0.0, (320, 180), &store)
        .expect("应当排得出渲染计划");
    assert!(plan.camera.is_none(), "没有摄像机节点时不该出现取景参数");
}

/// 生成一份可以直接打开的小组作业示例工程（手动触发，不参与常规测试）。
///
/// 内容：小组作业视频 → 壁纸照片 → 三条定时字幕 → 视频尾部淡出 →
/// 摄像机节点 + 环绕关键帧（posX 从 -260 绕到 +260，同时推近拉远）。
/// 跑法：`cargo test --lib generate_demo_project_file -- --ignored --nocapture`
#[test]
#[ignore = "手动生成示例工程产物，常规测试不跑"]
fn generate_demo_project_file() {
    use crate::keyframe::EasingPreset;
    use crate::timeline::model::{Track, TrackKind, Transition};

    let Some(video_ms) = (if exists(REAL_VIDEO) {
        Some(probe::probe_path(REAL_VIDEO).duration_ms)
    } else {
        None
    }) else {
        eprintln!("跳过：没有 {REAL_VIDEO}");
        return;
    };
    // 只取前 12 秒做演示，太长打开会卡
    let clip_ms = video_ms.min(12_000.0);

    let mut project = serialize::new_project_with("小组作业 · 自动剪辑演示", 1920, 1080, 25.0, "Rec.709");
    let sequence_id = project.sequences[0].id.clone();
    let video_track_id = project.sequences[0].tracks[0].id.clone();

    // —— 视频素材 —— //
    let vinfo = probe::probe_path(REAL_VIDEO);
    project.assets.push(Asset {
        id: "asset-video".into(),
        path: REAL_VIDEO.into(),
        name: "jason go to school.mp4".into(),
        kind: AssetKind::Video,
        duration_ms: vinfo.duration_ms,
        width: vinfo.width,
        height: vinfo.height,
        frame_rate: vinfo.frame_rate,
        codec: vinfo.codec.clone(),
        has_audio: vinfo.has_audio,
        missing: false,
        bin_id: None,
    });
    let mut video_clip = clip("clip-video", "asset-video", &video_track_id, 0.0, clip_ms);
    // 出场淡出：最后 1 秒渐隐到黑
    video_clip.transition_out = Some(Transition {
        kind: "dipToBlack".into(),
        duration_ms: 1000.0,
    });
    project.sequences[0].tracks[0].clips.push(video_clip);

    // —— 照片素材（接在视频后面） —— //
    if exists(REAL_PHOTO) {
        let pinfo = probe::probe_path(REAL_PHOTO);
        project.assets.push(Asset {
            id: "asset-photo".into(),
            path: REAL_PHOTO.into(),
            name: "壁纸照片".into(),
            kind: AssetKind::Image,
            duration_ms: pinfo.duration_ms,
            width: pinfo.width,
            height: pinfo.height,
            frame_rate: pinfo.frame_rate,
            codec: pinfo.codec.clone(),
            has_audio: false,
            missing: false,
            bin_id: None,
        });
        project.sequences[0].tracks[0].clips.push(clip(
            "clip-photo",
            "asset-photo",
            &video_track_id,
            clip_ms,
            4000.0,
        ));
    }

    // —— 字幕轨：三条，分别在第 2 / 5 / 8 秒出现 —— //
    let sub_track_id = "track-subtitle".to_string();
    project.sequences[0].tracks.push(Track {
        id: sub_track_id.clone(),
        kind: TrackKind::Subtitle,
        // 故意用 1：与视频轨（index 0）错开，字幕独占一行，不压在画面上
        index: 1,
        muted: false,
        solo: false,
        locked: false,
        hidden: false,
        height: 44.0,
        clips: vec![
            {
                let mut c = clip("sub-1", "", &sub_track_id, 2000.0, 3000.0);
                c.node_id = String::new();
                c.text = Some("这是我们的小组作业".into());
                c
            },
            {
                let mut c = clip("sub-2", "", &sub_track_id, 5000.0, 3000.0);
                c.node_id = String::new();
                c.text = Some("第 5 秒出现的第二句字幕".into());
                c
            },
            {
                let mut c = clip("sub-3", "", &sub_track_id, 8000.0, 3000.0);
                c.node_id = String::new();
                c.text = Some("结尾：摄像机正环绕这段片子".into());
                c
            },
        ],
    });

    // 序列时长跟着内容走
    let total = clip_ms + if exists(REAL_PHOTO) { 4000.0 } else { 0.0 };
    project.sequences[0].duration_ms = total;

    // —— 摄像机节点：挂在根图里，默认在 -Z 方向看向原点 —— //
    let graph_id = project.sequences[0].root_graph_id.clone();
    let mut params: HashMap<String, ParamValue> = HashMap::new();
    params.insert("posZ".into(), ParamValue::Number(-900.0));
    params.insert("focalLength".into(), ParamValue::Number(40.0));
    params.insert("targetX".into(), ParamValue::Number(0.0));
    params.insert("targetY".into(), ParamValue::Number(0.0));
    params.insert("targetZ".into(), ParamValue::Number(0.0));
    project
        .graphs
        .get_mut(&graph_id)
        .expect("新工程带根图")
        .nodes
        .push(GraphNode {
            id: "camera-node".into(),
            node_type: "camera".into(),
            name: "环绕摄像机".into(),
            x: 560.0,
            y: 240.0,
            params,
            bypassed: false,
            collapsed: false,
            animated: true,
            inputs: Vec::new(),
            outputs: Vec::new(),
        });

    // —— 环绕关键帧：左右来回 + 推近拉远 —— //
    let mut store = KeyframeStore::new();
    store.set_keyframe("camera-node", "posX", 0.0, -260.0, EasingPreset::EaseInOut);
    store.set_keyframe("camera-node", "posX", total, 260.0, EasingPreset::EaseInOut);
    store.set_keyframe("camera-node", "posZ", 0.0, -900.0, EasingPreset::EaseInOut);
    store.set_keyframe("camera-node", "posZ", total / 2.0, -620.0, EasingPreset::EaseInOut);
    store.set_keyframe("camera-node", "posZ", total, -900.0, EasingPreset::EaseInOut);
    project.curves = store.curves();

    // 视频片段开 3D，摄像机才对它有透视效果
    if let Some(c) = project.sequences[0].tracks[0]
        .clips
        .iter_mut()
        .find(|c| c.id == "clip-video")
    {
        c.enable_3d = true;
        c.transform_3d = Some(Default::default());
    }

    let out = std::path::PathBuf::from(r"D:\20533\Desktop\小组作业_自动剪辑演示.reelix");
    serialize::save(&out, &project).expect("写示例工程失败");
    // 顺手打一遍渲染计划，确认这份工程是真能出画面的
    let plan = plan_frame(&project, &sequence_id, 3000.0, (640, 360), &store).expect("排计划失败");
    eprintln!(
        "已生成 {}：视频 {}ms + 照片 4000ms，字幕 3 条，摄像机 posX -260→+260，plan.camera={:?}",
        out.display(),
        clip_ms,
        plan.camera.map(|c| c.position)
    );
}

///
/// 这一条是「让摄像机环绕这个视频拍摄」能不能成立的分水岭：
/// 关键帧 → 烘参数 → 渲染计划取景，三段必须串得起来。
#[test]
fn camera_orbits_over_time_via_keyframes() {
    use crate::keyframe::EasingPreset;

    let mut project = serialize::new_project_with("环绕", 320, 180, 25.0, "Rec.709");
    let sequence_id = project.sequences[0].id.clone();
    let graph_id = project.sequences[0].root_graph_id.clone();

    let mut params: HashMap<String, ParamValue> = HashMap::new();
    params.insert("posZ".into(), ParamValue::Number(-600.0));
    params.insert("focalLength".into(), ParamValue::Number(40.0));
    project
        .graphs
        .get_mut(&graph_id)
        .expect("新工程带根图")
        .nodes
        .push(GraphNode {
            id: "camera-node".into(),
            node_type: "camera".into(),
            name: "摄像机".into(),
            x: 0.0,
            y: 0.0,
            params,
            bypassed: false,
            collapsed: false,
            animated: true,
            inputs: Vec::new(),
            outputs: Vec::new(),
        });

    // 4 秒内机位从左侧 -300 绕到右侧 +300
    let mut store = KeyframeStore::new();
    store.set_keyframe("camera-node", "posX", 0.0, -300.0, EasingPreset::Linear);
    store.set_keyframe("camera-node", "posX", 4000.0, 300.0, EasingPreset::Linear);

    let at_start = plan_frame(&project, &sequence_id, 0.0, (320, 180), &store)
        .expect("排计划")
        .camera
        .expect("有摄像机节点");
    let at_end = plan_frame(&project, &sequence_id, 4000.0, (320, 180), &store)
        .expect("排计划")
        .camera
        .expect("有摄像机节点");

    assert!(
        (at_start.position[0] - (-300.0)).abs() < 1.0,
        "0 秒机位应在左侧 -300，实际 {}",
        at_start.position[0]
    );
    assert!(
        (at_end.position[0] - 300.0).abs() < 1.0,
        "4 秒机位应在右侧 +300，实际 {}",
        at_end.position[0]
    );
    assert!(
        (at_end.position[0] - at_start.position[0]).abs() > 500.0,
        "机位必须真的绕过去，不是钉在原地"
    );
    // 焦距不随关键帧变，应当保持常量
    assert!((at_end.focal_length - 40.0).abs() < 1e-6);
}
