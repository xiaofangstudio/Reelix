/**
 * Reelix 前端入口。
 *
 * 只做三件事：挂载 React、引入样式令牌、渲染 App。
 * 任何业务逻辑都不许写在这里。
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到根节点 #root，界面无法挂载。");
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
