import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { spawn, type IPty, type IDisposable } from 'node-pty'
import { HIGH_WATER, LOW_WATER, MAX_BUFFER, MAX_INPUT, parseClientMessage, type ServerMessage } from '../src/lib/terminal-protocol.ts'

let pty: IPty | undefined
let subscriptions: IDisposable[] = []
let pending = 0
let paused = false
let finished = false
let ending = false
let lastAck = Date.now()

function send(message: ServerMessage, callback?: () => void) {
  if (!process.connected || !process.send) { shutdown(); return }
  process.send(message, (error) => {
    if (error) shutdown()
    else callback?.()
  })
}

function shutdown() {
  if (finished) return
  finished = true
  clearInterval(watchdog)
  for (const subscription of subscriptions) subscription.dispose()
  subscriptions = []
  try { pty?.resume(); pty?.kill() } catch { /* The shell may already have exited. */ }
  // End the owning process to release node-pty's native worker threads and handles.
  process.exit(0)
}

function fail(message: string) {
  if (ending || finished) return
  ending = true
  send({ type: 'error', message }, shutdown)
}

const watchdog = setInterval(() => {
  if (paused && Date.now() - lastAck > 30_000) fail('终端输出确认超时，会话已关闭。')
}, 5_000)
process.once('disconnect', shutdown)
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)

process.on('message', (raw: unknown) => {
  if (finished) return
  if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'close') { shutdown(); return }
  if (ending) return
  const message = parseClientMessage(JSON.stringify(raw))
  if (!message || (message.type !== 'start' && !pty)) { fail('终端收到无效消息。'); return }
  try {
    switch (message.type) {
      case 'start': {
        if (pty) { fail('终端会话已经启动。'); return }
        const windows = process.platform === 'win32'
        const shell = windows
          ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
          : process.env.SHELL || '/bin/sh'
        const terminal = spawn(shell, windows ? ['-NoLogo', '-NoProfile'] : ['-l'], {
          name: 'xterm-256color', cols: message.cols, rows: message.rows,
          cwd: homedir(), env: { ...process.env, TERM: 'xterm-256color' },
          useConptyDll: windows,
        })
        pty = terminal
        send({ type: 'ready', shell: windows ? 'PowerShell' : basename(shell) })
        subscriptions = [
          terminal.onData((data) => {
            if (finished || ending) return
            pending += data.length
            if (pending > MAX_BUFFER) { fail('终端输出超过缓冲限制，会话已关闭。'); return }
            for (let offset = 0; offset < data.length; offset += MAX_INPUT) {
              send({ type: 'output', data: data.slice(offset, offset + MAX_INPUT) })
            }
            if (pending >= HIGH_WATER && !paused) {
              paused = true
              lastAck = Date.now()
              terminal.pause()
            }
          }),
          terminal.onExit(({ exitCode }) => {
            ending = true
            send({ type: 'exit', code: exitCode }, shutdown)
          }),
        ]
        break
      }
      case 'input': pty?.write(message.data); break
      case 'resize': pty?.resize(message.cols, message.rows); break
      case 'clear': pty?.clear(); break
      case 'ack':
        if (message.count > pending) { fail('终端输出确认无效。'); return }
        pending -= message.count
        lastAck = Date.now()
        if (paused && pending <= LOW_WATER) { paused = false; pty?.resume() }
        break
    }
  } catch {
    fail('无法运行本地终端，请检查 Shell 与 node-pty 安装后重新打开。')
  }
})
