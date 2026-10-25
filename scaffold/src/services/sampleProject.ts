/**
 * 内置示例工程：「30 秒认识 Reelix」。
 *
 * 目的：让新用户点一下就在时间线上看到**真东西**——文字、字幕、颜色、转场、
 * 关键帧、效果栈、多轨道、标记全都用上，而不是空工程。
 *
 * 工程里**不放二进制素材**（体积）：视频位用两个「生成」效果节点当画面源
 * （渐变 + 网格 + 圆），字幕走字幕轨的真文字，音频位故意留空（用户自己拖歌），
 * 这样几 KB 的 json 就能演示全链路。
 *
 * 字段名是前后端契约，一个都不能错（踩过的坑，改前先读一遍）：
 * - 图节点类型字段叫 `type`，不是 `nodeType`（Rust 侧 rename）
 * - 插槽的叫 `connected`，不是 `multiple`
 * - 片段的 3D 开关叫 `enable3D` / `transform3D`，D 大写
 * - 序列必须给 `colorSpace`，标记只有 `{ id, timeMs, name }`
 *
 * 生成方式：在内存里拼 Project → 走 save_project 落盘到用户的文档目录 →
 * 再 open_project 打开。真实文件、真实工程，之后用户还能接着改。
 */

import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/appStore";
import { refreshProject } from "../store/projectActions";

/** 生成示例工程 JSON（与后端 serialize 的 Project 结构一致）。 */
function buildSampleProject(): Record<string, unknown> {
  const now = Date.now();
  const id = (p: string) => `${p}-${Math.random().toString(36).slice(2, 9)}`;
  const t = (offset: number) => now - 30_000 + offset;

  /** 造一个关键帧。字段名必须与后端 `Keyframe` 的 camelCase 序列化一致，
   *  否则读回来曲线是空的、动画等于没有。 */
  const kf = (
    targetId: string,
    param: string,
    timeMs: number,
    value: number,
    easing: string,
  ) => ({
    id: id("kf"),
    targetId,
    param,
    timeMs,
    value,
    easing,
    inTangent: { x: 0, y: 0 },
    outTangent: { x: 0, y: 0 },
  });

  const seqGraphId = id("graph");
  // 三条视频轨 + 一条音频轨 + 一条字幕轨 + 一条摄像机轨
  const v1 = id("track");
  const v2 = id("track");
  const v3 = id("track");
  const a1 = id("track");
  const s1 = id("track");
  const cam = id("track");

  // 根效果图：节点链演示「生成 → 风格化 → 输出」
  const gGradient = id("node");
  const gGrid = id("node");
  const gCircle = id("node");
  const gPoster = id("node");
  const gOutput = id("node");

  /** 滤镜节点的标准输入插槽（契约：connected，不是 multiple）。 */
  const inPlug = { key: "in", label: "输入", dataType: "image", connected: false };
  /** 滤镜节点的标准输出插槽。 */
  const outPlug = { key: "out", label: "输出", dataType: "image", connected: false };

  return {
    id: id("proj"),
    name: "30 秒认识 Reelix（示例）",
    createdAt: t(0),
    modifiedAt: t(0),
    assets: [],
    // —— 关键帧：示例工程不是「监视器里放个视频」，而是真参数动画 —— //
    // 每条曲线都能在界面里继续拖、改缓动、加删帧；存盘后随工程一起走。
    curves: [
      {
        targetId: gGrid,
        param: "opacity",
        keyframes: [
          kf(gGrid, "opacity", 0, 0, "ease-out"),
          kf(gGrid, "opacity", 1200, 70, "ease-out"),
        ],
      },
      {
        targetId: gCircle,
        param: "opacity",
        keyframes: [
          kf(gCircle, "opacity", 300, 0, "ease-out"),
          kf(gCircle, "opacity", 1500, 100, "ease-out"),
        ],
      },
      {
        targetId: gCircle,
        param: "radius",
        keyframes: [
          kf(gCircle, "radius", 300, 18, "ease-in-out"),
          kf(gCircle, "radius", 1600, 34, "ease-in-out"),
          kf(gCircle, "radius", 3000, 24, "ease-in-out"),
        ],
      },
      {
        targetId: gGradient,
        param: "angle",
        keyframes: [
          kf(gGradient, "angle", 0, 35, "linear"),
          kf(gGradient, "angle", 3000, 95, "linear"),
        ],
      },
    ],
    sequences: [
      {
        id: id("seq"),
        name: "主序列",
        width: 1920,
        height: 1080,
        frameRate: 30,
        // 必填：后端 Sequence.color_space 没有 serde default，缺了直接打不开
        colorSpace: "Rec.709",
        durationMs: 30_000,
        rootGraphId: seqGraphId,
        tracks: [
          // V3（最顶）：文字标题层（文字走 clip.text，监视器直接叠字）
          {
            id: v3,
            kind: "subtitle",
            index: 2,
            muted: false,
            solo: false,
            locked: false,
            hidden: false,
            height: 44,
            clips: [
              {
                id: id("clip"),
                assetId: "",
                trackId: v3,
                text: "Reelix · 特效合成软件",
                label: "主标题",
                startMs: 500,
                durationMs: 4000,
                inMs: 0,
                outMs: 4000,
                speed: 1,
                reversed: false,
                nodeId: "",
                compoundId: null,
                enable3D: false,
                transform3D: null,
                transitionIn: null,
                enabled: true,
              },
            ],
          },
          // V2：形状层（圆 + 网格，3D 旋转演示）
          {
            id: v2,
            kind: "video",
            index: 1,
            muted: false,
            solo: false,
            locked: false,
            hidden: false,
            height: 64,
            clips: [
              {
                id: id("clip"),
                assetId: "",
                trackId: v2,
                text: null,
                label: null,
                startMs: 3000,
                durationMs: 8000,
                inMs: 0,
                outMs: 8000,
                speed: 1,
                reversed: false,
                nodeId: gCircle,
                compoundId: null,
                enable3D: true,
                transform3D: {
                  position: { x: 120, y: 40, z: 200 },
                  rotation: { x: 0, y: 0, z: 15 },
                  scale: 0.8,
                  anchor: { x: 0.5, y: 0.5 },
                  orientation: "camera",
                  receiveLight: true,
                },
                // 4.5 秒处一个交叉溶解，演示转场
                transitionIn: { kind: "crossDissolve", durationMs: 800 },
                enabled: true,
              },
            ],
          },
          // V1（主轨）：渐变背景 + 网格 + 色调分离（效果栈演示）
          {
            id: v1,
            kind: "video",
            index: 0,
            muted: false,
            solo: false,
            locked: false,
            hidden: false,
            height: 64,
            clips: [
              {
                id: id("clip"),
                assetId: "",
                trackId: v1,
                text: null,
                label: "渐变背景",
                startMs: 0,
                durationMs: 30_000,
                inMs: 0,
                outMs: 30_000,
                speed: 1,
                reversed: false,
                nodeId: gGradient,
                compoundId: null,
                enable3D: false,
                transform3D: null,
                transitionIn: null,
                enabled: true,
              },
            ],
          },
          // A1：音频轨（空，提示用户拖歌）
          {
            id: a1,
            kind: "audio",
            index: 0,
            muted: false,
            solo: false,
            locked: false,
            hidden: false,
            height: 48,
            clips: [],
          },
          // 字幕轨（第二条，叠在 V3 下的字幕）
          {
            id: s1,
            kind: "subtitle",
            index: 1,
            muted: false,
            solo: false,
            locked: false,
            hidden: false,
            height: 44,
            clips: [
              {
                id: id("clip"),
                assetId: "",
                trackId: s1,
                text: "合成 · 剪辑 · 3D · 关键帧",
                label: null,
                startMs: 12_000,
                durationMs: 5000,
                inMs: 0,
                outMs: 5000,
                speed: 1,
                reversed: false,
                nodeId: "",
                compoundId: null,
                enable3D: false,
                transform3D: null,
                transitionIn: { kind: "dipToBlack", durationMs: 400 },
                enabled: true,
              },
            ],
          },
          // 摄像机轨（空，演示 3D 摄像机入口）
          {
            id: cam,
            kind: "camera",
            index: 0,
            muted: false,
            solo: false,
            locked: false,
            hidden: false,
            height: 44,
            clips: [],
          },
        ],
        // 标记契约只有 { id, timeMs, name }——没有 color/comment，写了也被后端丢掉
        markers: [
          { id: id("mk"), timeMs: 0, name: "开场：渐变入场" },
          { id: id("mk"), timeMs: 11_000, name: "中段：字幕切入" },
          { id: id("mk"), timeMs: 22_000, name: "收尾：准备导出" },
        ],
      },
    ],
    graphs: {
      [seqGraphId]: {
        id: seqGraphId,
        nodes: [
          { id: gGradient, type: "gradient", name: "渐变", x: 0, y: 0,
            params: { colorA: "#0f2b22", colorB: "#9fd4b6", angle: 35 },
            inputs: [{ ...inPlug }],
            outputs: [{ ...outPlug, connected: true }],
            bypassed: false, collapsed: false, animated: false },
          { id: gGrid, type: "grid", name: "网格", x: 0, y: 0,
            // opacity 由下面的关键帧从 0 推到 70：开场网格是「淡入」的，不是一上来就有
            params: { spacing: 120, lineWidth: 2, color: "#8fc4a8", opacity: 0 },
            inputs: [{ ...inPlug, connected: true }],
            outputs: [{ ...outPlug, connected: true }],
            bypassed: false, collapsed: false, animated: true },
          { id: gCircle, type: "circle", name: "圆", x: 0, y: 0,
            params: { centerX: 0.5, centerY: 0.45, radius: 28, color: "#ffd94d", feather: 12, opacity: 0 },
            inputs: [{ ...inPlug, connected: true }],
            outputs: [{ ...outPlug, connected: true }],
            bypassed: false, collapsed: false, animated: true },
          { id: gPoster, type: "posterize", name: "色调分离", x: 0, y: 0,
            params: { levels: 8 },
            inputs: [{ ...inPlug, connected: true }],
            outputs: [{ ...outPlug, connected: true }],
            bypassed: false, collapsed: false, animated: false },
          // 输出节点：链的终点。合成器优先认它，没它则退化成「拓扑序最后一个」
          { id: gOutput, type: "output", name: "输出", x: 0, y: 0,
            params: {},
            inputs: [{ ...inPlug, connected: true }],
            outputs: [],
            bypassed: false, collapsed: false, animated: false },
        ],
        connections: [
          { id: id("conn"), fromNode: gGradient, fromPlug: "out", toNode: gGrid, toPlug: "in" },
          { id: id("conn"), fromNode: gGrid, fromPlug: "out", toNode: gCircle, toPlug: "in" },
          { id: id("conn"), fromNode: gCircle, fromPlug: "out", toNode: gPoster, toPlug: "in" },
          { id: id("conn"), fromNode: gPoster, fromPlug: "out", toNode: gOutput, toPlug: "in" },
        ],
      },
    },
    bins: [],
  };
}

/** 打开内置示例工程：生成 → 落盘 → 打开。 */
export async function openSampleProject(): Promise<boolean> {
  try {
    const home = await invoke<string>("home_dir");
    const path = `${home}\\Documents\\Reelix 示例工程.reelix`;
    const json = JSON.stringify(buildSampleProject(), null, 2);
    await invoke("write_text_file", { path, contents: json });
    // open_project 会把整个工程返回，直接同步进 store 最稳——
    // 不再依赖 refreshProject 是否愿意拉（它以前有前置判断，会把这条路径整死）。
    const opened = await invoke<Record<string, unknown>>("open_project", { path });
    if (opened) {
      useAppStore.getState().syncProject(opened as never);
    }
    await refreshProject();
    // 关键一步：工程打开了但欢迎页没关，界面上就一直是「选择项目」那一屏。
    // 编辑器是否显示取决于 project !== null && !startScreen，两个条件缺一不可。
    useAppStore.getState().hideStartScreen();
    useAppStore.getState().pushNotice("info", "示例工程已打开：试试拖动播放头、右键片段、加效果");
    return true;
  } catch (err) {
    useAppStore
      .getState()
      .pushNotice("error", err instanceof Error ? err.message : String(err));
    return false;
  }
}
