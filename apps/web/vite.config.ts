import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // Release identity baked into the bundle (#131): the stale-bundle notice
    // compares this build id against the BFF's `/api/status` build.
    __MASTERHAND_VERSION__: JSON.stringify(process.env.MASTERHAND_VERSION ?? "0.1.0"),
    __MASTERHAND_BUILD__: JSON.stringify(process.env.MASTERHAND_BUILD ?? "dev"),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
})
