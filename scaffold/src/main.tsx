/**
 * Reelix 前端入口。
 *
 * 只做四件事：挂载 React、引入样式令牌、启动页包装、渲染 App。
 * 任何业务逻辑都不许写在这里。
 */

import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import Splash from "./components/Splash";
import "./styles/tokens.css";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到根节点 #root，界面无法挂载。");
}

/**
 * 启动包装：启动页（Splash）是最先出现的正常启动画面，
 * 加载完成后淡出进入欢迎页（StartScreen，在 App 内，保持原样）。
 * App 在启动页底下同步挂载初始化，加载进度对应的都是真实动作。
 */
function Boot() {
  const [splash, setSplash] = useState(true);
  return (
    <>
      <App />
      {splash && <Splash onDone={() => setSplash(false)} />}
    </>
  );
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <Boot />
  </React.StrictMode>
);
