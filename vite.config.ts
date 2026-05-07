import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5191,
    // strictPort intentionally off: if 5191 is taken (e.g. by the Claude in-app
    // preview server), Vite picks 5192, 5193, ... so a parallel `pnpm dev` still
    // runs. Playwright's webServer is configured to reuse 5191 if up, so its
    // smoke test still hits the running preview.
    strictPort: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
})
