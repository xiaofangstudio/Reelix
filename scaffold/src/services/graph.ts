/**
 * 图服务（内部）。
 *
 * 界面上只有图层与效果栈，没有节点也没有连线；效果栈在**内部**被编译成一张图来求值，
 * 时间线与效果栈共用这张图。所以这些命令是内部求值机制的操作口，不对用户暴露。
 */

import { invoke } from "@tauri-apps/api/core";
import type { Connection, GraphNode, NodeTypeInfo, ParamValue } from "../types/graph";

/** 复合片段节点：对外是一个普通节点，内部是一张图 */
export interface CompoundNode {
  node: GraphNode;
  graphId: string;
}

/** 往图里加一个节点 */
export function addNode(
  graphId: string,
  nodeType: string,
  x: number,
  y: number
): Promise<GraphNode> {
  return invoke<GraphNode>("add_node", { graphId, nodeType, x, y });
}

/** 删节点，同时断开它的所有连接 */
export function removeNode(nodeId: string): Promise<boolean> {
  return invoke<boolean>("remove_node", { nodeId });
}

/** 连接两个插槽 */
export function connect(
  fromNode: string,
  fromPlug: string,
  toNode: string,
  toPlug: string
): Promise<Connection> {
  return invoke<Connection>("connect", { fromNode, fromPlug, toNode, toPlug });
}

/** 断开一条连接 */
export function disconnect(connectionId: string): Promise<boolean> {
  return invoke<boolean>("disconnect", { connectionId });
}

/** 修改节点参数。改完上游标脏，下游会重算 */
export function setNodeParam(
  nodeId: string,
  param: string,
  value: ParamValue
): Promise<boolean> {
  return invoke<boolean>("set_node_param", { nodeId, param, value });
}

/** 把一组节点折叠成复合片段（预合成） */
export function collapseCompound(nodeIds: string[]): Promise<CompoundNode> {
  return invoke<CompoundNode>("collapse_compound", { nodeIds });
}

/** 进入复合片段内部编辑，返回内部图的 id */
export function enterCompound(nodeId: string): Promise<{ graphId: string }> {
  return invoke<{ graphId: string }>("enter_compound", { nodeId });
}

/** 取节点类型注册表，供出「+ 效果」菜单与效果栈卡片回填默认参数 */
export function getNodeCatalog(): Promise<NodeTypeInfo[]> {
  return invoke<NodeTypeInfo[]>("get_node_catalog");
}
