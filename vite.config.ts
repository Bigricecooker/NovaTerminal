import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
    },
  },
  build: { outDir: fileURLToPath(new URL('./dist', import.meta.url)), emptyOutDir: true },
  server: {
    host: '127.0.0.1', port: 5180, strictPort: true,
    headers: { 'Content-Security-Policy': "frame-ancestors 'none'" },
  },
})
