import type { Plugin } from 'vite'
import { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { attachTerminalServer } from './terminal-server.ts'

export function terminalPlugin(): Plugin {
  const workerPath = fileURLToPath(new URL('./pty-worker.ts', import.meta.url))
  return {
    name: 'nova-local-terminal',
    configResolved(config) {
      if (config.server.host !== '127.0.0.1' || config.preview.host !== '127.0.0.1' || config.server.https) {
        throw new Error('NovaTerminal 本地终端只支持 http://127.0.0.1，请勿修改监听地址或启用 HTTPS。')
      }
    },
    configureServer(server) {
      if (!(server.httpServer instanceof Server)) throw new Error('NovaTerminal 需要独立 HTTP 服务。')
      // HTTP close owns cleanup; closeBundle also runs for individual Vite environments.
      attachTerminalServer(server.httpServer, workerPath)
    },
    configurePreviewServer(server) {
      if (!(server.httpServer instanceof Server)) throw new Error('NovaTerminal 需要独立 HTTP 服务。')
      attachTerminalServer(server.httpServer, workerPath)
    },
  }
}
