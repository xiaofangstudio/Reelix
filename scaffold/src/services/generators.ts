/**
 * 生成器素材：白底 / 黑场 / 彩条与音调 / 颜色遮罩。
 * 后端用 ffmpeg lavfi 真生成 PNG 落缓存目录，作为普通图片素材进工程——
 * 预览 / 合成 / 导出管线天然支持，不是摆设。
 */

import { invoke } from "@tauri-apps/api/core";
import type { Asset } from "../types/project";

/** 新建生成器素材（秒数决定时间线上的默认长度，可再拉） */
export function newGenerator(kind: string, seconds: number): Promise<Asset> {
  return invoke<Asset>("new_generator", { kind, seconds });
}

/** 生成器面板上陈列的种类（name 用于界面，kind 传给后端） */
export const GENERATORS: Array<{ kind: string; name: string; hint: string; seconds: number }> = [
  { kind: "white", name: "白底", hint: "纯白底图，默认 3 秒，可随意拉伸", seconds: 3 },
  { kind: "black", name: "黑场", hint: "纯黑底图，默认 3 秒，可随意拉伸", seconds: 3 },
  { kind: "bars", name: "彩条与音调", hint: "测试彩条，默认 10 秒", seconds: 10 },
  { kind: "#00b140", name: "绿幕", hint: "标准抠像绿（#00B140），默认 3 秒", seconds: 3 },
  { kind: "#0047bb", name: "蓝幕", hint: "标准抠像蓝（#0047BB），默认 3 秒", seconds: 3 },
  { kind: "#808080", name: "中灰", hint: "中性灰底（调色/对比参考），默认 3 秒", seconds: 3 },
  { kind: "#57c08f", name: "颜色遮罩 · 品牌绿", hint: "主题绿纯色，默认 3 秒", seconds: 3 },
  { kind: "#26734f", name: "颜色遮罩 · 深绿", hint: "强调绿纯色，默认 3 秒", seconds: 3 },
  { kind: "#e5484d", name: "颜色遮罩 · 红", hint: "纯色红底（Meme/标记常用），默认 3 秒", seconds: 3 },
  { kind: "#f5c518", name: "颜色遮罩 · 黄", hint: "纯色黄底（高亮/贴纸底），默认 3 秒", seconds: 3 },
  { kind: "#f97316", name: "颜色遮罩 · 橙", hint: "纯色橙底（醒目提示），默认 3 秒", seconds: 3 },
  { kind: "#8b5cf6", name: "颜色遮罩 · 紫", hint: "纯色紫底（氛围/装饰），默认 3 秒", seconds: 3 },
  { kind: "#ec4899", name: "颜色遮罩 · 粉", hint: "纯色粉底（Meme 常用），默认 3 秒", seconds: 3 },
  { kind: "#3b82f6", name: "颜色遮罩 · 蓝", hint: "纯色蓝底（抠像/对比），默认 3 秒", seconds: 3 },
];

/** 默认媒体库的系统目录（唯一增删入口：用户手动放文件） */
export function defaultMediaDir(kind: string): Promise<string> {
  return invoke<string>("default_media_dir", { kind });
}

/** 列系统默认媒体目录里的文件（界面只读；界面上传按钮刻意不做） */
export function listDefaultMedia(kind: string): Promise<Array<[string, string]>> {
  return invoke<Array<[string, string]>>("list_default_media", { kind });
}
