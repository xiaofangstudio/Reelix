/**
 * 图数据模型。
 *
 * 核心设计：整个项目就是一张有向无环图，时间线本身是图上的一个节点（序列节点）。
 * 给片段加特效 = 在片段节点和序列节点之间插一个处理节点。
 * 详见 docs/04-剪辑与特效融合设计.md。
 */

import type { Id } from "./project";

export type PlugDataType =
  | "image"
  | "number"
  | "vector"
  | "color"
  | "text"
  | "mask";

export interface Plug {
  key: string;
  /** 中文标签 */
  label: string;
  dataType: PlugDataType;
  connected: boolean;
  /**
   * 是否为 3D 插槽。片段勾选「启用 3D」后，其节点会多出 3D 插槽，
   * 供 3D 合成节点与摄像机节点消费（docs/09 第 2.4 节）。
   */
  is3D?: boolean;
}

export type ParamValue = number | string | boolean;

export interface GraphNode {
  id: Id;
  /** 注册表里的类型键 */
  type: string;
  /** 中文显示名，用户可改 */
  name: string;
  x: number;
  y: number;
  params: Record<string, ParamValue>;
  /** 旁路：数据直通，节点保留 */
  bypassed: boolean;
  /** 折叠为复合片段 */
  collapsed: boolean;
  inputs: Plug[];
  outputs: Plug[];
  /** 该节点是否有关键帧参数，用于标题栏画小圆点 */
  animated: boolean;
}

export interface Connection {
  id: Id;
  fromNode: Id;
  fromPlug: string;
  toNode: Id;
  toPlug: string;
}

export interface Graph {
  id: Id;
  nodes: GraphNode[];
  connections: Connection[];
  /** 属于哪个复合片段 */
  parentNodeId?: Id;
}

/** 节点分类。摄像机单独成类，见 docs/09 第 2.3 节。 */
export type NodeCategory =
  | "输入"
  | "变换"
  | "颜色"
  | "滤镜"
  | "抠像"
  | "蒙版"
  | "粒子"
  | "合成"
  | "摄像机"
  | "GPU"
  | "生成"
  | "调色"
  | "风格化"
  | "输出";

/** 节点类型注册表里的一条 */
export interface NodeTypeInfo {
  type: string;
  /** 中文名 */
  label: string;
  category: NodeCategory;
  inputs: Array<Pick<Plug, "key" | "label" | "dataType">>;
  outputs: Array<Pick<Plug, "key" | "label" | "dataType">>;
  /** 参数默认值，键是参数名，值是默认值 */
  defaults: Record<string, ParamValue>;
}