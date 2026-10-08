import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/client",
  // 部署在 nginx /obs/ 前缀下；生产 base 由 `pnpm build` 的 --base=/obs/ 内置（勿裸跑 vite build），
  // 开发环境（vite / dev:web，:5180）默认 "/"
  base: process.env.VITE_APP_BASE ?? "/",
  plugins: [react()],
  server: {
    port: 5180,
    host: "0.0.0.0",
    proxy: {
      "/api": "http://127.0.0.1:4180",
    },
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
});
