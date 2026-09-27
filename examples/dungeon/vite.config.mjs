// 开发模式专用：`npm run dev` 启动 vite（HMR 免构建），打开 /dev.html。
// 生产构建仍走 build.mjs（esbuild → ui/app/assets/app.js，产物提交入库），
// vite 只在开发期使用，产物与 vite 无关。
// 代理把 API/SSE 转发到网关（默认 localhost:6363，可用 GATEWAY 环境变量覆盖），
// 这样 app 代码里「留空 = 同源网关」的约定在 dev 源上同样成立。
import { defineConfig } from "vite";

const gw = process.env.GATEWAY || "http://localhost:6363";
const proxyTargets = ["/v1", "/svc", "/admin"];

export default defineConfig({
  esbuild: {
    // 与 build.mjs / tsconfig 一致：automatic runtime（vue/jsx-runtime）
    jsx: "automatic",
    jsxImportSource: "vue",
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      proxyTargets.map((p) => [p, { target: gw, changeOrigin: true }]),
    ),
  },
});
