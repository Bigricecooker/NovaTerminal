import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { DESKTOP_CHANNELS, WINDOW_CHANNELS, DIRECTORY_CHANNEL, CREDENTIAL_CHANNELS, type DesktopCredentialApi, type DesktopDirectoryApi, type DesktopEvent, type DesktopTerminalApi, type DesktopWindowApi, type WindowState } from '../shared/desktop-api.ts'
import { parseClientMessage } from '../shared/terminal-protocol.ts'
import { SETTINGS_CHANNELS, type DesktopSettingsApi } from '../shared/desktop-api.ts'
import type { SettingsSnapshot } from '../shared/settings.ts'
import { CLIPBOARD_CHANNELS, type DesktopClipboardApi } from '../shared/desktop-api.ts'
import { MAX_COPY } from '../shared/terminal-interactions.ts'
import { EXIT_CHANNELS, type DesktopExitApi } from '../shared/desktop-api.ts'
import { LINK_CHANNEL, type DesktopLinkApi } from '../shared/desktop-api.ts'
import { TRANSFER_CHANNELS, type DesktopTransferApi } from '../shared/desktop-api.ts'

function publicFailure(error: unknown, fallback: string): never {
  const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : ''
  // Known validation messages are localized; filesystem / IPC details stay out of the UI.
  throw new Error(/^[\u4e00-\u9fff]/.test(message) ? message : fallback)
}
const transferApi: DesktopTransferApi = {
  read: () => ipcRenderer.invoke(TRANSFER_CHANNELS.read).catch((error: unknown) => publicFailure(error, '无法读取连接配置文件，请检查文件权限后重试。')),
  write: (document) => typeof document === 'string' && document.length <= 1_048_576
    ? ipcRenderer.invoke(TRANSFER_CHANNELS.write, document).catch((error: unknown) => publicFailure(error, '连接配置导出失败，请重试。')) : Promise.reject(new Error('导出配置过大。')),
}
contextBridge.exposeInMainWorld('novaConnections', transferApi)

const linksApi: DesktopLinkApi = { open: (url) => ipcRenderer.invoke(LINK_CHANNEL, url) }
contextBridge.exposeInMainWorld('novaLinks', linksApi)

const exitApi: DesktopExitApi = {
  reply: (id, action) => ipcRenderer.invoke(EXIT_CHANNELS.reply, id, action),
  onRequest: (listener) => {
    const handler = (_event: IpcRendererEvent, id: number) => listener(id)
    ipcRenderer.on(EXIT_CHANNELS.request, handler)
    return () => { ipcRenderer.removeListener(EXIT_CHANNELS.request, handler) }
  },
}
contextBridge.exposeInMainWorld('novaExit', exitApi)

const clipboardApi: DesktopClipboardApi = {
  read: () => ipcRenderer.invoke(CLIPBOARD_CHANNELS.read),
  write: (text) => typeof text === 'string' && text.length <= MAX_COPY
    ? ipcRenderer.invoke(CLIPBOARD_CHANNELS.write, text) : Promise.reject(new Error('复制内容超过上限。')),
}
contextBridge.exposeInMainWorld('novaClipboard', clipboardApi)

const settingsApi: DesktopSettingsApi = {
  initial: ipcRenderer.sendSync(SETTINGS_CHANNELS.initial),
  save: (values) => ipcRenderer.invoke(SETTINGS_CHANNELS.save, JSON.stringify(values)).catch((error: unknown) => publicFailure(error, '设置保存失败，请重试。')),
  onChange: (listener) => {
    const handler = (_event: IpcRendererEvent, snapshot: SettingsSnapshot) => listener(snapshot)
    ipcRenderer.on(SETTINGS_CHANNELS.event, handler)
    return () => { ipcRenderer.removeListener(SETTINGS_CHANNELS.event, handler) }
  },
}
contextBridge.exposeInMainWorld('novaSettings', settingsApi)

const pending = new Map<string, number>()
const api: DesktopTerminalApi = {
  open: () => ipcRenderer.invoke(DESKTOP_CHANNELS.open),
  send: async (id, message) => {
    const raw = JSON.stringify(message)
    const size = raw.length
    const total = (pending.get(id) ?? 0) + size
    if (total > 262_144 || !parseClientMessage(raw)) throw new Error('Terminal input limit exceeded')
    pending.set(id, total)
    try { return await ipcRenderer.invoke(DESKTOP_CHANNELS.send, id, raw) }
    finally {
      const remaining = (pending.get(id) ?? 0) - size
      if (remaining > 0) pending.set(id, remaining)
      else pending.delete(id)
    }
  },
  close: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.close, id),
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, value: DesktopEvent) => listener(value)
    ipcRenderer.on(DESKTOP_CHANNELS.event, handler)
    return () => { ipcRenderer.removeListener(DESKTOP_CHANNELS.event, handler) }
  },
}
contextBridge.exposeInMainWorld('novaTerminal', api)
const windowApi: DesktopWindowApi = {
  minimize: () => ipcRenderer.invoke(WINDOW_CHANNELS.action, 'minimize'),
  toggleMaximize: () => ipcRenderer.invoke(WINDOW_CHANNELS.action, 'toggle-maximize'),
  close: () => ipcRenderer.invoke(WINDOW_CHANNELS.action, 'close'),
  getState: () => ipcRenderer.invoke(WINDOW_CHANNELS.state),
  onState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: WindowState) => listener(state)
    ipcRenderer.on(WINDOW_CHANNELS.event, handler)
    return () => { ipcRenderer.removeListener(WINDOW_CHANNELS.event, handler) }
  },
}
contextBridge.exposeInMainWorld('novaWindow', windowApi)
const directoryApi: DesktopDirectoryApi = { pick: () => ipcRenderer.invoke(DIRECTORY_CHANNEL) }
contextBridge.exposeInMainWorld('novaDirectories', directoryApi)
const credentialApi: DesktopCredentialApi = {
  save: (id, options) => {
    const raw = JSON.stringify(options)
    if (raw.length > 262_144) return Promise.reject(new Error('SSH credential size limit exceeded'))
    return ipcRenderer.invoke(CREDENTIAL_CHANNELS.save, id, raw)
  },
  remove: (ids) => ipcRenderer.invoke(CREDENTIAL_CHANNELS.remove, ids),
}
contextBridge.exposeInMainWorld('novaCredentials', credentialApi)
