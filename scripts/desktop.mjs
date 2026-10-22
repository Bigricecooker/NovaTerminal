import { spawn } from 'node:child_process'
import electron from 'electron'
import { createServer } from 'vite'

let server
if (process.argv.includes('--dev')) {
  await import('./build-desktop.mjs')
  server = await createServer()
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
const stop = () => {
  if (stopping) return
  stopping = true
  if (child.connected) child.send({ type: 'app:quit' })
  else child.kill()
  // Keep Vite alive while the user decides. Main owns acknowledgement timeouts.
}
child.on('message', (message) => {
  if (message && typeof message === 'object' && message.type === 'app:quit-cancelled') stopping = false
})
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
child.once('error', async (error) => { console.error(`无法启动 NovaTerminal：${error.message}`); stop(); await server?.close(); process.exitCode = 1 })
child.once('exit', async (code) => {
  if (code !== 0) console.error(`NovaTerminal 已异常退出（退出码：${code ?? '未知'}）。`)
  await server?.close()
  process.exitCode = code ?? 1
})
