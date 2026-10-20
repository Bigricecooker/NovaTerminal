import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage, utilityProcess } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DESKTOP_CHANNELS, WINDOW_CHANNELS, DIRECTORY_CHANNEL, CREDENTIAL_CHANNELS } from '../shared/desktop-api.ts'
import { createCredentialStore } from './credential-store.ts'
import { parseLocalDirectory } from '../shared/terminal-protocol.ts'
import { APP_URL, DEV_URL, assetPath, trustedFrame, windowAction } from './security.ts'
import { createDesktopSessions } from './sessions.ts'

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
app.setName('NovaTerminal')
const dev = !app.isPackaged && process.env.NOVA_DEV_SERVER === DEV_URL
const rendererUrl = dev ? DEV_URL : APP_URL
let window: BrowserWindow | null = null
let quitting = false
let pickingDirectory = false
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
)

function authorize(event: Electron.IpcMainInvokeEvent): number {
  if (!window || window.isDestroyed() || !event.senderFrame
    || !trustedFrame(event.sender.id, window.webContents.id, event.senderFrame === event.sender.mainFrame, event.senderFrame.url, rendererUrl)) {
    throw new Error('Untrusted terminal request')
  }
  return event.sender.id
}

async function createWindow() {
  const current = new BrowserWindow({
    title: 'NovaTerminal', width: 1200, height: 800, minWidth: 720, minHeight: 480, show: false,
    backgroundColor: '#ffffff', frame: false,
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
  current.webContents.on('render-process-gone', () => sessions.closeOwner(current.webContents.id))
  current.webContents.on('did-start-loading', () => sessions.closeOwner(current.webContents.id))
  current.on('close', () => sessions.closeOwner(current.webContents.id))
  current.on('closed', () => { if (window === current) window = null })
  current.once('ready-to-show', () => current.show())
  await current.loadURL(rendererUrl)
}

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'; frame-ancestors 'none'"
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
    if (typeof raw !== 'string' || raw.length > 262_144) throw new Error('无效的 SSH 认证配置。')
    let options: unknown
    try { options = JSON.parse(raw) } catch { throw new Error('无效的 SSH 认证配置。') }
    credentialStore().save(id, options)
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
  quitting = true
  void sessions.shutdown().finally(() => app.quit())
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
process.on('message', (message: unknown) => {
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'app:quit') app.quit()
})
process.once('disconnect', () => app.quit())
