/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// In development the React app proxies `/api/*` to the backend, so the browser sees one origin:
// cookies stay first-party and the backend's Origin check receives the Vite origin unchanged.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backend = env.FACTOS_BACKEND_URL || 'http://127.0.0.1:8000'
  return {
    plugins: [react()],
    server: {
      host: 'localhost',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: backend, rewrite: (path) => path.replace(/^\/api/, '') },
      },
    },
    test: { environment: 'jsdom' },
  }
})
