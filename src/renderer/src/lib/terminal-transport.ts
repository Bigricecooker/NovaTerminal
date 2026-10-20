import { parseServerMessage, type ClientMessage, type ServerMessage } from '../../../shared/terminal-protocol.ts'

import type { DesktopTerminalApi } from '../../../shared/desktop-api.ts'

type Events = { open: () => void; message: (message: ServerMessage) => void; close: () => void; error: () => void }
export type TerminalTransport = { send: (message: ClientMessage) => void; close: () => void; isOpen: () => boolean; buffered: () => number }

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
  return {
    isOpen: () => ready && !disposed,
    buffered: () => pending,
    send: (message) => {
      if (!id || disposed || !ready) return
      const size = JSON.stringify(message).length
      pending += size
      void api.send(id, message).then((accepted) => { if (!accepted && !disposed) events.error() })
        .catch(() => { if (!disposed) events.error() }).finally(() => { pending -= size })
    },
    close: () => {
      if (disposed) return
      disposed = true; ready = false; unsubscribe()
      if (id) void api.close(id).catch(() => {})
    },
  }
}
