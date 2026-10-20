/**
 * 错误边界：任何子组件渲染抛错时，显示可读的错误信息而不是整页白屏。
 * 用户报过「剪辑页一片白」——根因是某个组件抛错后 React 卸载整棵树。
 * 有了边界，最坏情况是那一块显示错误卡，其余界面照常工作。
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** 出错时显示的区域名（如「剪辑页」「特效页」） */
  area?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台留一份完整堆栈，方便排查
    console.error(`[ErrorBoundary${this.props.area ? ` ${this.props.area}` : ""}]`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary-title">
          {this.props.area ?? "这块区域"}渲染出错了
        </div>
        <div className="error-boundary-msg">{error.message}</div>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => this.setState({ error: null })}
        >
          重试
        </button>
      </div>
    );
  }
}
