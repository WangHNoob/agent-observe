import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/client",
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
