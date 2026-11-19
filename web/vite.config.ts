import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: `npm run dev` proxies the API to a running incus-webui on :8443.
export default defineConfig({
  plugins: [react()],
  build: { sourcemap: false, outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    proxy: { "/api": { target: "https://127.0.0.1:8443", secure: false, ws: true, changeOrigin: false } },
  },
});
