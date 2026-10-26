import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, protocol, safeStorage, shell, utilityProcess } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { open as openFile } from 'node:fs/promises'
import { DESKTOP_CHANNELS, WINDOW_CHANNELS, DIRECTORY_CHANNEL, CREDENTIAL_CHANNELS, SETTINGS_CHANNELS, CLIPBOARD_CHANNELS, LINK_CHANNEL, EXIT_CHANNELS, TRANSFER_CHANNELS } from '../shared/desktop-api.ts'
import { createCredentialStore } from './credential-store.ts'
import { parseLocalDirectory } from '../shared/terminal-protocol.ts'
import { APP_URL, DEV_URL, assetPath, trustedFrame, windowAction } from './security.ts'
import { createDesktopSessions } from './sessions.ts'
import { atomicWrite, createSettingsStore } from './settings-store.ts'
import type { Platform, SettingsSnapshot } from '../shared/settings.ts'
import { MAX_COPY, MAX_PASTE, externalUrl } from '../shared/terminal-interactions.ts'
import { createExitCoordinator } from './exit-coordinator.ts'
import { MAX_TRANSFER_BYTES, exportConnections, parseConnectionImport } from '../shared/connection-transfer.ts'
import { parseAssetDocument } from '../shared/assets.ts'

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
app.setName('NovaTerminal')
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.exit(0)
const dev = !app.isPackaged && process.env.NOVA_DEV_SERVER === DEV_URL
const rendererUrl = dev ? DEV_URL : APP_URL
let window: BrowserWindow | null = null
let quitting = false
let pickingDirectory = false
let transferring = false
let credentialsRecovered = false
const platform: Platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
let settings: ReturnType<typeof createSettingsStore>
function settingsSnapshot(): SettingsSnapshot {
  const values = settings.get()
  return { values, platform, warning: settings.warning(), dark: values.theme === 'dark' || values.theme === 'system' && nativeTheme.shouldUseDarkColors }
}
function publishSettings() {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(SETTINGS_CHANNELS.event, settingsSnapshot())
}
const credentialStore = () => createCredentialStore(join(app.getPath('userData'), 'ssh-credentials', dev ? 'development' : 'desktop'), {
  available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())),
  encrypt: (value) => safeStorage.encryptString(value), decrypt: (value) => safeStorage.decryptString(value),
})
const sessions = createDesktopSessions(
  () => utilityProcess.fork(join(__dirname, 'session-worker.cjs'), [], { stdio: 'ignore', serviceName: 'NovaTerminal Session' }),
  (owner, event) => {
    if (window && !window.isDestroyed() && window.webContents.id === owner && !window.webContents.isDestroyed()) {
      window.webContents.send(DESKTOP_CHANNELS.event, event)
    }
  },
  (reference) => credentialStore().load(reference),
  () => settings.get(),
)
const exit = createExitCoordinator((id) => {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(EXIT_CHANNELS.request, id)
}, () => {
  quitting = true
  void sessions.shutdown().finally(() => app.quit())
})
function requestExit() {
  exit.begin(Boolean(settings?.get().confirmExit && window && !window.isDestroyed() && !window.webContents.isDestroyed()))
}

function authorize(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): number {
  if (!window || window.isDestroyed() || !event.senderFrame
    || !trustedFrame(event.sender.id, window.webContents.id, event.senderFrame === event.sender.mainFrame, event.senderFrame.url, rendererUrl)) {
    throw new Error('Untrusted terminal request')
  }
  return event.sender.id
}

async function createWindow() {
  const current = new BrowserWindow({
    title: 'NovaTerminal', width: 1200, height: 800, minWidth: 720, minHeight: 480, show: false,
    backgroundColor: settingsSnapshot().dark ? '#171717' : '#ffffff', frame: false,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  })
  window = current
  const publishState = () => {
    if (!current.webContents.isDestroyed()) current.webContents.send(WINDOW_CHANNELS.event, { maximized: current.isMaximized() })
  }
  current.on('maximize', publishState)
  current.on('unmaximize', publishState)
  if (dev) current.webContents.on('before-input-event', (event, input) => {
    const shortcut = input.key === 'F12' || input.key.toLowerCase() === 'i'
      && (process.platform === 'darwin' ? input.meta && input.alt : input.control && input.shift)
    if (input.type === 'keyDown' && shortcut) { event.preventDefault(); current.webContents.toggleDevTools() }
  })
  current.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  current.webContents.session.setPermissionCheckHandler(() => false)
  current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  current.webContents.on('will-navigate', (event) => { if (event.url !== rendererUrl) event.preventDefault() })
  current.webContents.on('will-attach-webview', (event) => event.preventDefault())
  current.webContents.on('render-process-gone', () => { sessions.closeOwner(current.webContents.id); exit.unavailable() })
  current.webContents.on('did-start-loading', () => { credentialsRecovered = false; sessions.closeOwner(current.webContents.id) })
  current.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    requestExit()
  })
  current.on('query-session-end', () => { exit.begin(false) })
  current.on('closed', () => { if (window === current) window = null })
  current.once('ready-to-show', () => current.show())
  await current.loadURL(rendererUrl)
}

app.on('second-instance', () => {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
})

if (primaryInstance) void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  settings = createSettingsStore(join(app.getPath('userData'), 'settings', dev ? 'development.json' : 'desktop.json'), platform)
  ipcMain.on(SETTINGS_CHANNELS.initial, (event) => {
    try { authorize(event); event.returnValue = settingsSnapshot() } catch { event.returnValue = null }
  })
  ipcMain.handle(SETTINGS_CHANNELS.save, (event, raw: unknown) => {
    authorize(event)
    if (typeof raw !== 'string' || raw.length > 65_536) throw new Error('设置格式无效。')
    settings.save(JSON.parse(raw))
    publishSettings()
    return settingsSnapshot()
  })
  nativeTheme.on('updated', publishSettings)
  ipcMain.handle(TRANSFER_CHANNELS.read, async (event) => {
    authorize(event)
    const owner = window
    if (!owner || transferring) return null
    transferring = true
    try {
      const chosen = await dialog.showOpenDialog(owner, { title: '导入连接配置', properties: ['openFile'], filters: [{ name: 'NovaTerminal 连接配置', extensions: ['json'] }] })
      if (chosen.canceled || !chosen.filePaths[0] || owner.isDestroyed() || owner !== window) return null
      authorize(event)
      const file = await openFile(chosen.filePaths[0], 'r')
      let raw: unknown
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > MAX_TRANSFER_BYTES) throw new Error('导入文件须为不超过 1 MiB 的 JSON 文件。')
        const buffer = Buffer.alloc(MAX_TRANSFER_BYTES + 1)
        let length = 0
        while (length < buffer.length) {
          const result = await file.read(buffer, length, buffer.length - length, null)
          if (!result.bytesRead) break
          length += result.bytesRead
        }
        if (length > MAX_TRANSFER_BYTES) throw new Error('导入文件超过 1 MiB。')
        try { raw = JSON.parse(buffer.subarray(0, length).toString('utf8')) } catch { throw new Error('导入文件不是有效的 JSON。') }
      } finally { await file.close() }
      authorize(event)
      const parsed = parseConnectionImport(raw)
      return { document: exportConnections(parsed.assets), orphaned: parsed.orphaned }
    } finally { transferring = false }
  })
  ipcMain.handle(TRANSFER_CHANNELS.write, async (event, raw: unknown) => {
    authorize(event)
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_TRANSFER_BYTES) throw new Error('导出配置超过 1 MiB。')
    const assets = parseAssetDocument(JSON.parse(raw))
    if (!assets) throw new Error('导出配置无效。')
    const text = JSON.stringify(exportConnections(assets), null, 2)
    if (Buffer.byteLength(text) > MAX_TRANSFER_BYTES) throw new Error('导出文件超过 1 MiB。')
    const owner = window
    if (!owner || transferring) return false
    transferring = true
    try {
      const chosen = await dialog.showSaveDialog(owner, { title: '导出连接配置（不含认证信息）', defaultPath: `novaterminal-connections-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (chosen.canceled || !chosen.filePath || owner.isDestroyed() || owner !== window) return false
      authorize(event)
      try { atomicWrite(chosen.filePath, text) } catch { throw new Error('导出保存失败，请检查目标目录权限和磁盘空间。') }
      return true
    } finally { transferring = false }
  })
  ipcMain.handle(LINK_CHANNEL, async (event, raw: unknown) => {
    authorize(event)
    const url = externalUrl(raw)
    if (!url) throw new Error('仅允许有效的 http/https 链接。')
    try { await shell.openExternal(url) } catch { throw new Error('无法打开系统浏览器。') }
  })
  ipcMain.handle(EXIT_CHANNELS.reply, (event, id: unknown, action: unknown) => {
    authorize(event)
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || !['ack', 'cancel', 'exit'].includes(String(action))) throw new Error('无效的退出响应。')
    if (action === 'ack' || action === 'cancel' || action === 'exit') {
      exit.reply(id, action)
      if (action === 'cancel' && process.connected) process.send?.({ type: 'app:quit-cancelled' })
    }
  })
  ipcMain.handle(CLIPBOARD_CHANNELS.read, async (event) => {
    authorize(event)
    const text = await clipboard.readText()
    authorize(event)
    if (text.length > MAX_PASTE) throw new Error('粘贴超过 64 KiB，请分段粘贴。')
    return text
  })
  ipcMain.handle(CLIPBOARD_CHANNELS.write, async (event, text: unknown) => {
    authorize(event)
    if (typeof text !== 'string' || text.length > MAX_COPY) throw new Error('复制内容超过 1 MiB 上限。')
    await clipboard.writeText(text)
  })
  const csp = "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'; frame-ancestors 'none'"
  protocol.handle('app', async (request) => {
    const file = assetPath(join(__dirname, '../../dist'), request.url)
    if (!file || request.method !== 'GET') return new Response(null, { status: 403 })
    try {
      const response = await net.fetch(pathToFileURL(file).href)
      const headers = new Headers(response.headers)
      headers.set('Content-Security-Policy', csp)
      return new Response(response.body, { status: response.status, headers })
    } catch { return new Response(null, { status: 404 }) }
  })
  ipcMain.handle(DESKTOP_CHANNELS.open, (event) => sessions.open(authorize(event)))
  ipcMain.handle(DESKTOP_CHANNELS.send, (event, id: unknown, message: unknown) => sessions.send(authorize(event), id, message))
  ipcMain.handle(DESKTOP_CHANNELS.close, (event, id: unknown) => sessions.close(authorize(event), id))
  ipcMain.handle(CREDENTIAL_CHANNELS.save, (event, id: unknown, raw: unknown) => {
    authorize(event)
    if (!credentialsRecovered) throw new Error('认证存储恢复尚未完成，请刷新后重试。')
    if (typeof raw !== 'string' || raw.length > 262_144) throw new Error('无效的 SSH 认证配置。')
    let options: unknown
    try { options = JSON.parse(raw) } catch { throw new Error('无效的 SSH 认证配置。') }
    credentialStore().save(id, options)
  })
  ipcMain.handle(CREDENTIAL_CHANNELS.recover, (event, raw: unknown) => {
    authorize(event)
    // One recovery per loaded document, before any new credential can be staged.
    if (credentialsRecovered) return
    if (typeof raw !== 'string' || raw.length > 524_288) throw new Error('资产配置无效，未清理认证信息。')
    let document: unknown
    try { document = JSON.parse(raw) } catch { throw new Error('资产配置无效，未清理认证信息。') }
    credentialStore().recover(document)
    credentialsRecovered = true
  })
  ipcMain.handle(CREDENTIAL_CHANNELS.remove, (event, ids: unknown) => {
    authorize(event)
    credentialStore().remove(ids)
  })
  ipcMain.handle(DIRECTORY_CHANNEL, async (event) => {
    authorize(event)
    const owner = window
    if (!owner || pickingDirectory) return null
    pickingDirectory = true
    try {
      const result = await dialog.showOpenDialog(owner, { title: '添加本地连接', properties: ['openDirectory'] })
      if (result.canceled || owner.isDestroyed() || window !== owner) return null
      authorize(event)
      return parseLocalDirectory(result.filePaths[0])
    } finally { pickingDirectory = false }
  })
  ipcMain.handle(WINDOW_CHANNELS.state, (event) => {
    authorize(event)
    return { maximized: window?.isMaximized() ?? false }
  })
  ipcMain.handle(WINDOW_CHANNELS.action, (event, raw: unknown) => {
    authorize(event)
    const action = windowAction(raw)
    if (!action) throw new Error('Invalid window action')
    if (window && !window.isDestroyed()) {
      if (action === 'minimize') window.minimize()
      else if (action === 'toggle-maximize') {
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
      } else window.close()
    }
  })
  await createWindow()
  app.on('activate', () => { if (!window) void createWindow() })
}).catch(() => { console.error('NovaTerminal 桌面启动失败。'); app.quit() })
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  requestExit()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
process.on('message', (message: unknown) => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'app:quit') app.quit()
})
process.once('disconnect', () => app.quit())
