import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// dev 端口 1422。1420 是 Strata，1421 是 FangBox，不要抢。
//
// 体积控制（docs/07 第二节 · docs/11 第一节）：安装包红线 150MB。
// 前端产物随包内嵌，这里按「尽可能小」构建：esbuild 压缩 + 去调试语句 + 不开 sourcemap。
export default defineConfig(({ mode }) => {
  const isProd = mode === "production";
  return {
    plugins: [react()],
    clearScreen: false,
    server: {
      port: 1422,
      strictPort: true,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
    build: {
      // 桌面端自带 WebView2（Chromium 内核），可直接用现代语法，省掉降级垫片
      target: "es2022",
      minify: "esbuild",
      // 不发 sourcemap：既压体积，也避免把源码路径带进产物
      sourcemap: false,
      cssMinify: true,
      // 4KB 以下的小资源内联，减少随包文件个数
      assetsInlineLimit: 4096,
      reportCompressedSize: true,
      chunkSizeWarningLimit: 1024,
    },
    esbuild: {
      // 生产构建剥离 console / debugger，压体积
      drop: isProd ? ["console", "debugger"] : [],
    },
  };
});
