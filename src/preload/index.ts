import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { DESKTOP_CHANNELS, type DesktopEvent, type DesktopTerminalApi } from '../shared/desktop-api.ts'
import { parseClientMessage } from '../shared/terminal-protocol.ts'

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
