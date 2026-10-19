import { spawn } from 'node:child_process'
import electron from 'electron'
import { createServer } from 'vite'

let server
if (process.argv.includes('--dev')) {
  await import('./build-desktop.mjs')
  server = await createServer({ mode: 'desktop', server: { host: '127.0.0.1', port: 5180, strictPort: true } })
  await server.listen()
  server.printUrls()
}
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NOVA_DEV_SERVER
if (server) env.NOVA_DEV_SERVER = 'http://127.0.0.1:5180/'
console.log('正在启动 NovaTerminal 桌面窗口…')
// SW_HIDE can suppress the GUI window's first show on Windows.
const child = spawn(electron, ['.'], { env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: false })
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  if (child.connected) child.send({ type: 'app:quit' })
  else child.kill()
  const timeout = setTimeout(() => child.kill(), 5_000)
  timeout.unref()
  child.once('exit', () => clearTimeout(timeout))
  await server?.close()
}
process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
child.once('error', async (error) => { console.error(`无法启动 NovaTerminal：${error.message}`); await stop(); process.exitCode = 1 })
child.once('exit', async (code) => {
  if (code !== 0) console.error(`NovaTerminal 已异常退出（退出码：${code ?? '未知'}）。`)
  await server?.close()
  process.exitCode = code ?? 1
})
