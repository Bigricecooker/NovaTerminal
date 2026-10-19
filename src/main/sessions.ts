import { randomUUID } from 'node:crypto'
import { MAX_BUFFER, MAX_SESSIONS, SSH_START_TIMEOUT, parseServerMessage } from '../shared/terminal-protocol.ts'
import type { DesktopEvent } from '../shared/desktop-api.ts'
import { desktopMessage, sessionId } from './security.ts'

export type SessionProcess = {
  postMessage: (message: unknown) => void
  kill: () => boolean
  on: (event: 'message', listener: (message: unknown) => void) => unknown
  once: (event: 'exit', listener: (code: number) => void) => unknown
}

type Session = {
  owner: number; worker?: SessionProcess; started: boolean; pending: number
  inputAt: number; inputCount: number; timer: ReturnType<typeof setTimeout>
}

export function createDesktopSessions(spawn: () => SessionProcess, deliver: (owner: number, event: DesktopEvent) => void) {
  const sessions = new Map<string, Session>()
  const slots = new Set<string>()
  // Closing workers retain their slot until exit, including native resource teardown.
  const workers = new Set<SessionProcess>()
  const close = (id: string) => {
    const current = sessions.get(id)
    if (!current) return
    sessions.delete(id)
    clearTimeout(current.timer)
    const worker = current.worker
    if (!worker) { slots.delete(id); deliver(current.owner, { id, closed: true }); return }
    try { worker.postMessage({ type: 'close' }) } catch { /* Worker already exited. */ }
    const timeout = setTimeout(() => worker.kill(), 2_500)
    timeout.unref()
    worker.once('exit', () => clearTimeout(timeout))
    deliver(current.owner, { id, closed: true })
  }
  const fail = (id: string, message: string) => {
    const current = sessions.get(id)
    if (current) deliver(current.owner, { id, message: { type: 'error', message } })
    close(id)
  }
  const owned = (owner: number, id: unknown) => {
    if (!sessionId(id)) throw new Error('Invalid terminal session')
    const current = sessions.get(id)
    if (!current || current.owner !== owner) throw new Error('Terminal session unavailable')
    return current
  }
  const activate = (id: string, current: Session) => {
    const worker = spawn()
    current.worker = worker
    workers.add(worker)
    worker.once('exit', () => {
      workers.delete(worker)
      slots.delete(id)
      delete current.worker
      if (sessions.has(id)) fail(id, '终端会话进程已退出。')
    })
    worker.on('message', (raw) => {
      if (!sessions.has(id)) return
      const message = parseServerMessage(JSON.stringify(raw))
      if (!message) { fail(id, '终端会话返回无效消息。'); return }
      if (message.type === 'output') {
        current.pending += message.data.length
        if (current.pending > MAX_BUFFER) { fail(id, '终端输出超过缓冲限制。'); return }
      }
      if (message.type === 'ready') clearTimeout(current.timer)
      deliver(current.owner, { id, message })
      if (message.type === 'exit' || message.type === 'error') close(id)
    })
  }
  return {
    open: (owner: number) => {
      if (slots.size >= MAX_SESSIONS) throw new Error('Terminal session limit reached')
      const id = randomUUID()
      slots.add(id)
      const current: Session = {
        owner, started: false, pending: 0, inputAt: Date.now(), inputCount: 0,
        timer: setTimeout(() => fail(id, '终端启动超时。'), 10_000),
      }
      sessions.set(id, current)
      return id
    },
    send: (owner: number, id: unknown, raw: unknown) => {
      const current = owned(owner, id)
      if (typeof id !== 'string') return false
      const message = desktopMessage(raw)
      if (!message || (message.type !== 'start' && !current.started)) { fail(id, '终端收到无效消息。'); return false }
      if (message.type === 'start') {
        if (current.started) { fail(id, '终端已经启动。'); return false }
        current.started = true
        try { activate(id, current) }
        catch { fail(id, '无法启动终端会话进程。'); return false }
        clearTimeout(current.timer)
        current.timer = setTimeout(() => fail(id, '终端连接超时。'), message.ssh ? SSH_START_TIMEOUT : 10_000)
      }
      if (message.type === 'ack') {
        if (message.count > current.pending) { fail(id, '终端输出确认无效。'); return false }
        current.pending -= message.count
      }
      if (message.type === 'input') {
        if (Date.now() - current.inputAt >= 1_000) { current.inputAt = Date.now(); current.inputCount = 0 }
        current.inputCount += message.data.length
        if (current.inputCount > 131_072) { fail(id, '终端输入过快。'); return false }
      }
      try { current.worker?.postMessage(message); return true }
      catch { fail(id, '终端传输已关闭。'); return false }
    },
    close: (owner: number, id: unknown) => {
      if (sessionId(id) && !sessions.has(id)) return
      owned(owner, id)
      if (typeof id === 'string') close(id)
    },
    closeOwner: (owner: number) => {
      for (const [id, current] of sessions) if (current.owner === owner) close(id)
    },
    dispose: () => { for (const id of sessions.keys()) close(id) },
    shutdown: async () => {
      for (const id of sessions.keys()) close(id)
      await Promise.all([...workers].map((worker) => new Promise<void>((done) => {
        const timeout = setTimeout(() => { worker.kill(); done() }, 4_000)
        worker.once('exit', () => { clearTimeout(timeout); done() })
      })))
    },
    count: () => sessions.size,
  }
}
