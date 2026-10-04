import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/client",
  // 部署在 nginx /obs/ 前缀下；开发环境默认 "/"
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
