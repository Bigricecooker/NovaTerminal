import { parseServerMessage, type ClientMessage, type ServerMessage } from '../../../shared/terminal-protocol.ts'
import { terminalInputChunks } from '../../../shared/terminal-input.ts'
import { MAX_PASTE } from '../../../shared/terminal-interactions.ts'

import type { DesktopTerminalApi } from '../../../shared/desktop-api.ts'

type Events = { open: () => void; message: (message: ServerMessage) => void; close: () => void; error: () => void }
export type TerminalTransport = { send: (message: ClientMessage) => void; sendInput: (data: string, binary?: true) => boolean; close: () => void; isOpen: () => boolean }

export function createTerminalTransport(events: Events, api: DesktopTerminalApi | undefined): TerminalTransport {
  if (!api) throw new Error('桌面会话接口不可用，请通过 NovaTerminal 桌面应用启动。')
  let id: string | undefined
  let disposed = false
  let ready = false
  let pending = 0
  const unsubscribe = api.onEvent((event) => {
    if (disposed || event.id !== id) return
    if ('closed' in event) { ready = false; events.close() }
    else {
      const message = parseServerMessage(JSON.stringify(event.message))
      if (message) events.message(message)
      else events.error()
    }
  })
  // A discarded development effect must not reserve a slot before its replacement opens.
  queueMicrotask(() => {
    if (disposed) return
    void api.open().then((value) => {
      id = value
      if (disposed) { void api.close(value).catch(() => {}); return }
      ready = true
      events.open()
    }).catch(() => { if (!disposed) events.error() })
  })
  const send = (message: ClientMessage) => {
    if (!id || disposed || !ready) return
    const size = JSON.stringify(message).length
    pending += size
    void api.send(id, message).then((accepted) => { if (!accepted && !disposed) events.error() })
      .catch(() => { if (!disposed) events.error() }).finally(() => { pending -= size })
  }
  return {
    isOpen: () => ready && !disposed,
    send,
    sendInput: (data, binary) => {
      // Bracketed paste adds 12 units; reserve the complete encoded batch before sending any part.
      if (!id || disposed || !ready || data.length > MAX_PASTE + 12) return false
      const messages = Array.from(terminalInputChunks(data), (chunk): ClientMessage => ({ type: 'input', data: chunk, ...(binary ? { binary } : {}) }))
      if (messages.reduce((total, message) => total + JSON.stringify(message).length, pending) > 131_072) return false
      for (const message of messages) send(message)
      return true
    },
    close: () => {
      if (disposed) return
      disposed = true; ready = false; unsubscribe()
      if (id) void api.close(id).catch(() => {})
    },
  }
}
