import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Ports are chosen by scripts/find-ports.mjs at startup so multiple instances
// can coexist. Fall back to the historical defaults when run directly.
const webPort = parseInt(process.env.NOVELWEB_WEB_PORT || '5173', 10)
const apiTarget = `http://localhost:${process.env.NOVELWEB_API_PORT || '3001'}`

export default defineConfig({
  plugins: [vue()],
  server: {
    host: true,
    port: webPort,
    // The launcher already selects a free frontend/backend pair. Silently
    // incrementing only the Vite port would open the wrong URL and can leave
    // the frontend paired with a different backend.
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, xfwd: true },
      '/pieces-render': { target: apiTarget, xfwd: true }
    }
  }
})
