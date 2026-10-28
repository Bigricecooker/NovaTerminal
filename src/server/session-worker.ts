import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'
import { spawn, type IPty, type IDisposable } from 'node-pty'
import { HIGH_WATER, LOW_WATER, MAX_BUFFER, MAX_INPUT, parseClientMessage, type ServerMessage } from '../shared/terminal-protocol.ts'

import { createKnownHosts, type KnownHosts } from './known-hosts.ts'
import { createSshSession, type SshSession } from './ssh-session.ts'
import { resolveLocalShell } from './local-shell.ts'

export type WorkerTransport = {
  send: (message: ServerMessage, callback: (error: Error | null) => void) => void
  onMessage: (callback: (message: unknown) => void) => void
  onDisconnect: (callback: () => void) => void
}

export function runSessionWorker(transport: WorkerTransport, knownHosts: KnownHosts = createKnownHosts()): void {
  let pty: IPty | undefined
  let ssh: SshSession | undefined
  let subscriptions: IDisposable[] = []
  let pending = 0
  let paused = false
  let finished = false
  let ending = false
  let lastAck = Date.now()

  function send(message: ServerMessage, callback?: () => void) {
    transport.send(message, (error) => {
      if (error) shutdown()
      else callback?.()
    })
  }

  function shutdown() {
    if (finished) return
    finished = true
    clearInterval(watchdog)
    ssh?.close()
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
  transport.onDisconnect(shutdown)

  transport.onMessage((raw: unknown) => {
    if (finished) return
    if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'close') { shutdown(); return }
    if (ending) return
    const message = parseClientMessage(JSON.stringify(raw))
    if (!message || (message.type !== 'start' && !pty && !ssh)) { fail('终端收到无效消息。'); return }
    try {
      if (ssh) { ssh.handle(message); return }
      switch (message.type) {
        case 'start': {
          if (message.savedSsh) { fail('SSH 连接引用必须由主进程解析。'); return }
          if (pty) { fail('终端会话已经启动。'); return }
          if (message.ssh) {
            ssh = createSshSession(message.ssh, message.cols, message.rows, knownHosts, (output) => {
              send(output, output.type === 'error' || output.type === 'exit' ? shutdown : undefined)
            })
            return
          }
          const windows = process.platform === 'win32'
          const cwd = message.cwd ?? homedir()
          try {
            if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) throw new Error('Invalid directory')
          } catch { fail('无法打开本地目录，请确认目录存在且有访问权限。'); return }
          let shell: ReturnType<typeof resolveLocalShell>
          try { shell = resolveLocalShell(message.shell ?? 'default') }
          catch (error) { fail(error instanceof Error ? error.message : 'Shell 不可用。'); return }
          const terminal = spawn(shell.file, shell.args, {
            name: 'xterm-256color', cols: message.cols, rows: message.rows,
            cwd, env: { ...process.env, TERM: 'xterm-256color' },
            useConptyDll: windows,
          })
          pty = terminal
          send({ type: 'ready', shell: shell.label })
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
        case 'input': pty?.write(message.binary ? Buffer.from(message.data, 'latin1') : message.data); break
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
}
