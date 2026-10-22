/**
 * 内置示例工程：「30 秒认识 Reelix」。
 *
 * 目的：让新用户点一下就在时间线上看到**真东西**——文字、字幕、颜色、转场、
 * 关键帧、效果栈、多轨道、标记全都用上，而不是空工程。
 *
 * 工程里**不放二进制素材**（体积）：视频位用两个「生成」效果节点当画面源
 * （渐变 + 网格 + 圆），字幕走字幕轨的真文字，音频位故意留空（用户自己拖歌），
 * 这样 8KB 的 json 就能演示全链路。
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
  const gCircle = id("node");
  const gGrid = id("node");
  const gPoster = id("node");
  const gText = id("node");

  return {
    id: id("proj"),
    name: "30 秒认识 Reelix（示例）",
    createdAt: t(0),
    modifiedAt: t(0),
    assets: [],
    sequences: [
      {
        id: id("seq"),
        name: "主序列",
        width: 1920,
        height: 1080,
        frameRate: 30,
        durationMs: 30_000,
        backgroundColor: "#101418",
        rootGraphId: seqGraphId,
        tracks: [
          // V3（最顶）：文字标题层
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
                nodeId: gText,
                compoundId: null,
                enable3d: false,
                transform3d: null,
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
                enable3d: true,
                transform3d: {
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
                enable3d: false,
                transform3d: null,
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
                enable3d: false,
                transform3d: null,
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
        markers: [
          { id: id("mk"), timeMs: 0, color: "blue", comment: "开场：渐变入场" },
          { id: id("mk"), timeMs: 11_000, color: "yellow", comment: "中段：字幕切入" },
          { id: id("mk"), timeMs: 22_000, color: "red", comment: "收尾：准备导出" },
        ],
      },
    ],
    graphs: {
      [seqGraphId]: {
        id: seqGraphId,
        nodes: [
          { id: gGradient, nodeType: "gradient", name: "渐变", x: 0, y: 0,
            params: { colorA: "#1b2a4a", colorB: "#e8734a", angle: 35 },
            inputs: [{ key: "in", label: "输入", dataType: "image", multiple: false }],
            outputs: [{ key: "out", label: "输出", dataType: "image", multiple: true }],
            bypassed: false, collapsed: false, animated: false },
          { id: gGrid, nodeType: "grid", name: "网格", x: 0, y: 0,
            params: { spacing: 120, lineWidth: 2, color: "#6db3ff" },
            inputs: [{ key: "in", label: "输入", dataType: "image", multiple: false }],
            outputs: [{ key: "out", label: "输出", dataType: "image", multiple: true }],
            bypassed: false, collapsed: false, animated: false },
          { id: gCircle, nodeType: "circle", name: "圆", x: 0, y: 0,
            params: { centerX: 0.5, centerY: 0.45, radius: 28, color: "#ffd94d", feather: 12 },
            inputs: [{ key: "in", label: "输入", dataType: "image", multiple: false }],
            outputs: [{ key: "out", label: "输出", dataType: "image", multiple: true }],
            bypassed: false, collapsed: false, animated: false },
          { id: gPoster, nodeType: "posterize", name: "色调分离", x: 0, y: 0,
            params: { levels: 8 },
            inputs: [{ key: "in", label: "输入", dataType: "image", multiple: false }],
            outputs: [{ key: "out", label: "输出", dataType: "image", multiple: true }],
            bypassed: false, collapsed: false, animated: false },
        ],
        connections: [
          { id: id("conn"), fromNode: gGradient, fromPlug: "out", toNode: gGrid, toPlug: "in" },
          { id: id("conn"), fromNode: gGrid, fromPlug: "out", toNode: gCircle, toPlug: "in" },
          { id: id("conn"), fromNode: gCircle, fromPlug: "out", toNode: gPoster, toPlug: "in" },
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
    await invoke("open_project", { path });
    await refreshProject();
    useAppStore.getState().pushNotice("info", "示例工程已打开：试试拖动播放头、右键片段、加效果");
    return true;
  } catch (err) {
    useAppStore
      .getState()
      .pushNotice("error", err instanceof Error ? err.message : String(err));
    return false;
  }
}
