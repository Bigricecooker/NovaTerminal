import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { terminalPlugin } from './server/terminal-plugin.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), terminalPlugin()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    headers: { 'Content-Security-Policy': "frame-ancestors 'none'" },
  },
  preview: {
    host: '127.0.0.1', port: 4173, strictPort: true,
    headers: { 'Content-Security-Policy': "frame-ancestors 'none'" },
  },
})
