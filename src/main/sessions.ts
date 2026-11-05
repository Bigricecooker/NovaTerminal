import { randomUUID } from 'node:crypto'
import { MAX_BUFFER, MAX_SESSIONS, SSH_START_TIMEOUT, parseServerMessage, type SavedSshConnection, type SshOptions } from '../shared/terminal-protocol.ts'
import type { DesktopEvent } from '../shared/desktop-api.ts'
import { desktopMessage, sessionId } from './security.ts'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings.ts'
import type { InputMessage } from '../shared/terminal-input.ts'
import { sftpEvent, sftpRequest, type SftpRequest, type SftpResult, type SftpProgress } from '../shared/sftp.ts'

export type SessionProcess = {
  postMessage: (message: unknown) => void
  kill: () => boolean
  on: (event: 'message', listener: (message: unknown) => void) => unknown
  once: (event: 'exit', listener: (code: number) => void) => unknown
}

type Session = {
  owner: number; worker?: SessionProcess; started: boolean; pending: number
  inputAt: number; inputCount: number; timer: ReturnType<typeof setTimeout>
  ssh?: boolean; ready?: boolean
  file?: { requestId: string; resolve: (result: SftpResult) => void; reject: (error: Error) => void }
}

export function createDesktopSessions(spawn: () => SessionProcess, deliver: (owner: number, event: DesktopEvent) => void, resolveSsh?: (reference: SavedSshConnection) => SshOptions, preferences: () => Pick<Settings, 'maxSessions' | 'shell' | 'directory'> = () => DEFAULT_SETTINGS, progress: (owner: number, event: SftpProgress) => void = () => {}) {
  const sessions = new Map<string, Session>()
  const slots = new Set<string>()
  // Closing workers retain their slot until exit, including native resource teardown.
  const workers = new Set<SessionProcess>()
  const close = (id: string) => {
    const current = sessions.get(id)
    if (!current) return
    sessions.delete(id)
    clearTimeout(current.timer)
    current.file?.reject(new Error('SSH 会话已关闭，文件操作已取消。'))
    delete current.file
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
  const writeInput = (id: string, current: Session, messages: InputMessage[]) => {
    if (Date.now() - current.inputAt >= 1_000) { current.inputAt = Date.now(); current.inputCount = 0 }
    const count = messages.reduce((total, message) => total + message.data.length, 0)
    // Reserve the whole paste before forwarding its first chunk, including bracket markers.
    if (current.inputCount + count > 131_072) return false
    current.inputCount += count
    try { for (const message of messages) current.worker?.postMessage(message); return true }
    catch { fail(id, '终端传输已关闭。'); return false }
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
      if (sftpEvent(raw)) {
        const file = current.file
        if (!file || file.requestId !== raw.requestId) return
        if (raw.type === 'sftp-progress') progress(current.owner, { id, transferred: raw.transferred, total: raw.total })
        else {
          delete current.file
          if (raw.error || !raw.result) file.reject(new Error(raw.error ?? 'SFTP 响应无效。'))
          else file.resolve(raw.result)
        }
        return
      }
      const message = parseServerMessage(JSON.stringify(raw))
      if (!message) { fail(id, '终端会话返回无效消息。'); return }
      if (message.type === 'output') {
        current.pending += message.data.length
        if (current.pending > MAX_BUFFER) { fail(id, '终端输出超过缓冲限制。'); return }
      }
      if (message.type === 'ready') { clearTimeout(current.timer); current.ready = true }
      deliver(current.owner, { id, message })
      if (message.type === 'exit' || message.type === 'error') close(id)
    })
  }
  return {
    open: (owner: number) => {
      if (slots.size >= Math.max(1, Math.min(8, preferences().maxSessions || MAX_SESSIONS))) throw new Error('会话数量已达上限，或上个会话仍在清理，请稍后重试。')
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
      let message = desktopMessage(raw)
      if (Array.isArray(message)) {
        if (!current.started) { fail(id, '终端收到无效消息。'); return false }
        return writeInput(id, current, message)
      }
      if (!message || (message.type !== 'start' && !current.started)) { fail(id, '终端收到无效消息。'); return false }
      if (message.type === 'start') {
        if (current.started) { fail(id, '终端已经启动。'); return false }
        if (message.savedSsh) {
          try {
            if (!resolveSsh) throw new Error('No credential resolver')
            message = { type: 'start', cols: message.cols, rows: message.rows, ssh: resolveSsh(message.savedSsh) }
          } catch {
            fail(id, '无法读取此连接的系统安全存储认证信息；请确认密钥库已解锁。旧连接或凭据失效时，请编辑连接并重新填写认证信息。')
            return false
          }
        }
        if (!message.ssh) {
          const defaults = preferences()
          const cwd = message.cwd ?? defaults.directory
          message = { type: 'start', cols: message.cols, rows: message.rows, shell: defaults.shell, ...(cwd ? { cwd } : {}) }
        }
        current.started = true
        current.ssh = Boolean(message.ssh)
        try { activate(id, current) }
        catch { fail(id, '无法启动终端会话进程。'); return false }
        clearTimeout(current.timer)
        current.timer = setTimeout(() => fail(id, '终端连接超时。'), message.ssh ? SSH_START_TIMEOUT : 10_000)
      }
      if (message.type === 'ack') {
        if (message.count > current.pending) { fail(id, '终端输出确认无效。'); return false }
        current.pending -= message.count
      }
      if (message.type === 'input') return writeInput(id, current, [message])
      try { current.worker?.postMessage(message); return true }
      catch { fail(id, '终端传输已关闭。'); return false }
    },
    sftpAvailable: (owner: number, id: unknown) => {
      const current = owned(owner, id)
      if (!current.ssh || !current.ready || !current.worker) throw new Error('文件传输仅适用于已连接的 SSH 会话。')
      if (current.file) throw new Error('该会话正在处理其他文件操作。')
    },
    sftp: (owner: number, id: unknown, operation: Omit<SftpRequest, 'type' | 'requestId'>): Promise<SftpResult> => {
      const current = owned(owner, id)
      if (!current.ssh || !current.ready || !current.worker) throw new Error('文件传输仅适用于已连接的 SSH 会话。')
      if (current.file) throw new Error('该会话正在处理其他文件操作。')
      const request = { ...operation, type: 'sftp', requestId: randomUUID() }
      if (!sftpRequest(request)) throw new Error('文件操作参数无效。')
      return new Promise((resolve, reject) => {
        current.file = { requestId: request.requestId, resolve, reject }
        try { current.worker?.postMessage(request) }
        catch { delete current.file; reject(new Error('SFTP 会话进程不可用。')) }
      })
    },
    cancelSftp: (owner: number, id: unknown) => {
      const current = owned(owner, id)
      if (current.file) current.worker?.postMessage({ type: 'sftp-cancel' })
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
