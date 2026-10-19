import { fork, type ChildProcess } from 'node:child_process'
import type { Server, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { MAX_BUFFER, MAX_SESSIONS, SSH_START_TIMEOUT, TERMINAL_PATH, parseClientMessage, parseServerMessage, type ServerMessage } from '../shared/terminal-protocol.ts'
import { createKnownHosts } from './known-hosts.ts'
import { createSshSession, type SshSession } from './ssh-session.ts'

export function isAllowedRequest(request: IncomingMessage, port: number): boolean {
  const host = `127.0.0.1:${port}`
  return request.url === TERMINAL_PATH
    && request.headers.host === host
    && request.headers.origin === `http://${host}`
    && (request.socket.remoteAddress === '127.0.0.1' || request.socket.remoteAddress === '::ffff:127.0.0.1')
}

export function attachTerminalServer(
  server: Server,
  workerPath = fileURLToPath(new URL('./pty-worker.ts', import.meta.url)),
  knownHostsDirectory?: string,
): () => void {
  const knownHosts = createKnownHosts(knownHostsDirectory)
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 131_072, perMessageDeflate: false })
  const sessions = new Map<WebSocket, () => void>()
  const workers = new Set<ChildProcess>()

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url?.split('?')[0] !== TERMINAL_PATH) return
    const address = server.address()
    if (!address || typeof address === 'string' || !isAllowedRequest(request, address.port)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    if (sockets.clients.size >= MAX_SESSIONS || workers.size >= MAX_SESSIONS) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      return
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit('connection', client))
  }

  sockets.on('connection', (client) => {
    let worker: ChildProcess | undefined
    let ssh: SshSession | undefined
    let finished = false
    let alive = true
    let inputWindow = Date.now()
    let inputCount = 0

    const send = (message: ServerMessage) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message))
    }
    const finish = (code: number, reason: string) => {
      if (finished) return
      finished = true
      sessions.delete(client)
      clearTimeout(startTimer)
      clearInterval(heartbeat)
      ssh?.close()
      if (worker) {
        const child = worker
        worker = undefined
        if (child.connected) child.send({ type: 'close' }, () => {})
        // A per-session process bounds the lifetime of native ConPTY resources.
        const killTimer = setTimeout(() => child.kill(), 2_000)
        killTimer.unref()
        child.once('exit', () => clearTimeout(killTimer))
      }
      client.close(code, reason)
      const timer = setTimeout(() => client.terminate(), 1_000)
      timer.unref()
      client.once('close', () => clearTimeout(timer))
    }
    const fail = (message: string, code = 1008) => {
      send({ type: 'error', message })
      finish(code, 'Terminal session ended')
    }
    let startTimer = setTimeout(() => fail('终端启动超时，请新建终端。'), 10_000)
    const deliver = (output: ServerMessage) => {
      if (finished) return
      if (client.bufferedAmount > MAX_BUFFER) { fail('终端输出超过缓冲限制。', 1009); return }
      send(output)
      if (output.type === 'ready') clearTimeout(startTimer)
      if (output.type === 'exit') finish(1000, 'Shell exited')
      if (output.type === 'error') finish(1008, 'Terminal failed')
    }
    const heartbeat = setInterval(() => {
      if (!alive) { finish(1008, 'Terminal timed out'); return }
      alive = false
      client.ping()
    }, 15_000)
    heartbeat.unref()
    sessions.set(client, () => finish(1001, 'Server stopped'))
    client.on('pong', () => { alive = true })
    client.once('close', () => finish(1000, 'Disconnected'))
    client.once('error', () => finish(1011, 'Transport error'))

    client.on('message', (raw, binary) => {
      if (finished) return
      const message = binary ? null : parseClientMessage(raw.toString())
      if (!message || (message.type !== 'start' && !worker && !ssh)
        || message.type === 'host-key-response' && !ssh) { fail('终端收到无效消息。'); return }
      if (message.type === 'input') {
        if (Date.now() - inputWindow >= 1_000) { inputWindow = Date.now(); inputCount = 0 }
        inputCount += message.data.length
        if (inputCount > 131_072) { fail('终端输入过快，会话已关闭。', 1009); return }
      }
      try {
        if (message.type === 'start') {
          if (worker || ssh) { fail('终端会话已经启动。'); return }
          if (message.ssh) {
            clearTimeout(startTimer)
            startTimer = setTimeout(() => fail('SSH 连接或主机指纹确认超时。'), SSH_START_TIMEOUT)
            ssh = createSshSession(message.ssh, message.cols, message.rows, knownHosts, deliver)
            return
          }
          // Keep native PTYs outside Vite so their native threads cannot accumulate there.
          worker = fork(workerPath, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
          const child = worker
          workers.add(child)
          child.once('exit', () => workers.delete(child))
          worker.on('message', (raw: unknown) => {
            if (finished) return
            const output = parseServerMessage(JSON.stringify(raw))
            if (!output) { fail('终端服务返回了无效消息。', 1011); return }
            deliver(output)
          })
          worker.once('error', () => fail('无法启动本地终端服务。', 1011))
          worker.once('exit', () => { if (!finished) fail('本地终端服务意外退出，请重新打开。', 1011) })
        }
        if (ssh) { ssh.handle(message); return }
        if (!worker?.connected || !worker.send(message, (error) => {
          if (error && !finished) fail('本地终端服务已断开。', 1011)
        })) fail('终端输入缓冲已满，会话已关闭。', 1009)
      } catch {
        fail('无法处理终端操作，请检查连接或本地 Shell 配置后新建终端。', 1011)
      }
    })
  })

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    server.off('upgrade', onUpgrade)
    server.off('close', dispose)
    process.off('exit', dispose)
    for (const endSession of sessions.values()) endSession()
    for (const client of sockets.clients) client.terminate()
    sockets.close()
  }
  server.on('upgrade', onUpgrade)
  server.once('close', dispose)
  // Leave termination signals to the host. A cleanup-only listener would suppress
  // Node's default exit and leave HTTP alive with the terminal upgrade route removed.
  process.once('exit', dispose)
  return dispose
}
