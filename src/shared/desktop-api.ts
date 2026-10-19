import type { ClientMessage, ServerMessage } from './terminal-protocol.ts'

export type DesktopEvent = { id: string; message: ServerMessage } | { id: string; closed: true }

export type DesktopTerminalApi = {
  open: () => Promise<string>
  send: (id: string, message: ClientMessage) => Promise<boolean>
  close: (id: string) => Promise<void>
  onEvent: (listener: (event: DesktopEvent) => void) => () => void
}

export const DESKTOP_CHANNELS = {
  open: 'terminal:open', send: 'terminal:send', close: 'terminal:close', event: 'terminal:event',
} as const

declare global {
  interface Window { novaTerminal?: DesktopTerminalApi }
}
