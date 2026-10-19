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

export type WindowAppearance = { background: string; foreground: string }
export type DesktopWindowApi = { setAppearance: (appearance: WindowAppearance) => Promise<void> }
export const WINDOW_APPEARANCE_CHANNEL = 'window:appearance'

declare global {
  interface Window { novaTerminal?: DesktopTerminalApi; novaWindow?: DesktopWindowApi }
}
