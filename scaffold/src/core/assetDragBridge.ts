/**
 * 素材拖拽全局桥（同步，不依赖 React state）。
 *
 * 为什么不用 store 的 draggingAssetId：state 更新是异步的——用户按下、移动、
 * 松手可能发生在同一次事件循环里，TimelineView 的 useEffect 还没挂上监听，
 * pointerup 就过去了，落轨永远不触发（用户报过四次「拖得动、放不进去」）。
 * 这里用模块级单例 + 直接回调，全程同步，绕开 React 调度。
 */

export interface AssetDropInfo {
  clientX: number;
  clientY: number;
  assetId: string;
}

export const assetDragBridge = {
  /** 是否正在拖素材 */
  active: false,
  /** 正在拖的素材 id */
  assetId: null as string | null,
  /** 落轨回调：TimelineView 挂载时注册 */
  onDrop: null as ((info: AssetDropInfo) => void) | null,
};

/** 开始拖（BinRow 调用） */
export function beginAssetDrag(assetId: string): void {
  assetDragBridge.active = true;
  assetDragBridge.assetId = assetId;
}

/** 结束拖（BinRow 的 pointerup 调用；落在轨道上会触发 onDrop） */
export function endAssetDrag(clientX: number, clientY: number): void {
  if (assetDragBridge.active && assetDragBridge.assetId) {
    assetDragBridge.onDrop?.({
      clientX,
      clientY,
      assetId: assetDragBridge.assetId,
    });
  }
  assetDragBridge.active = false;
  assetDragBridge.assetId = null;
}
