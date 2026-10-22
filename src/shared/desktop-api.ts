import type { ClientMessage, ServerMessage, SshOptions } from './terminal-protocol.ts'
import type { Settings, SettingsSnapshot } from './settings.ts'

export const SETTINGS_CHANNELS = { initial: 'settings:initial', save: 'settings:save', event: 'settings:event' } as const
export type DesktopSettingsApi = {
  initial: SettingsSnapshot
  save: (values: Settings) => Promise<SettingsSnapshot>
  onChange: (listener: (snapshot: SettingsSnapshot) => void) => () => void
}
export const CLIPBOARD_CHANNELS = { read: 'clipboard:read', write: 'clipboard:write' } as const
export type DesktopClipboardApi = { read: () => Promise<string>; write: (text: string) => Promise<void> }
export const LINK_CHANNEL = 'link:open'
export type DesktopLinkApi = { open: (url: string) => Promise<void> }
export const EXIT_CHANNELS = { request: 'exit:request', reply: 'exit:reply' } as const
export type DesktopExitApi = {
  onRequest: (listener: (id: number) => void) => () => void
  reply: (id: number, action: 'ack' | 'cancel' | 'exit') => Promise<void>
}

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

export type WindowAction = 'minimize' | 'toggle-maximize' | 'close'
export type WindowState = { maximized: boolean }
export type DesktopWindowApi = {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  getState: () => Promise<WindowState>
  onState: (listener: (state: WindowState) => void) => () => void
}
export const WINDOW_CHANNELS = { action: 'window:action', state: 'window:state', event: 'window:event' } as const

export const DIRECTORY_CHANNEL = 'directory:pick'
export type DesktopDirectoryApi = { pick: () => Promise<string | null> }
export const CREDENTIAL_CHANNELS = { save: 'credential:save', remove: 'credential:remove' } as const
export type DesktopCredentialApi = { save: (assetId: string, options: SshOptions) => Promise<void>; remove: (assetIds: string[]) => Promise<void> }

declare global {
  interface Window { novaLinks?: DesktopLinkApi; novaExit?: DesktopExitApi; novaClipboard?: DesktopClipboardApi; novaSettings?: DesktopSettingsApi; novaTerminal?: DesktopTerminalApi; novaWindow?: DesktopWindowApi; novaDirectories?: DesktopDirectoryApi; novaCredentials?: DesktopCredentialApi }
}
