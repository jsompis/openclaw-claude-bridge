import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "path"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const statusApiTarget = env.VITE_STATUS_API_TARGET || "http://127.0.0.1:3458"

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      proxy: {
        "/status": {
          target: statusApiTarget,
          changeOrigin: true,
        },
        "/cleanup": {
          target: statusApiTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
