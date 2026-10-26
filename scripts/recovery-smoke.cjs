const { app, ipcMain } = require('electron')
const path = require('node:path')
app.setPath('userData', process.env.NOVA_TEST_PROFILE)
let window
let interruptSave = false
let interruptRemove = false
let secondInstances = 0
app.on('second-instance', () => { secondInstances++ })
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, handler) => handle(channel, async (event, ...args) => {
  if (channel === 'credential:remove' && interruptRemove) {
    interruptRemove = false
    window.webContents.forcefullyCrashRenderer()
    throw new Error('Synthetic interruption before old credential removal')
  }
  const result = await handler(event, ...args)
  if (channel === 'credential:save' && interruptSave) {
    interruptSave = false
    window.webContents.forcefullyCrashRenderer()
  }
  return result
})
app.once('browser-window-created', (_event, created) => {
  window = created
  window.webContents.once('did-finish-load', () => process.send({ ready: true, versions: process.versions }))
})
process.on('message', async message => {
  if (!message.id) return
  try {
    let value
    if (message.action === 'minimize') { window.minimize(); value = true }
    if (message.action === 'state') value = { secondInstances, windows: require('electron').BrowserWindow.getAllWindows().length, minimized: window.isMinimized(), visible: window.isVisible() }
    if (message.action === 'evaluate') value = await window.webContents.executeJavaScript(message.source)
    if (message.action === 'reload') {
      await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload() })
      value = true
    }
    if (message.action === 'interrupt') { interruptSave = true; value = true }
    if (message.action === 'interrupt-remove') { interruptRemove = true; value = true }
    if (message.action === 'verify-credential') {
      const reference = await window.webContents.executeJavaScript(`(() => {const a=JSON.parse(localStorage.getItem('novaterminal.assets.v1')).assets[0];return a.credentialId??a.id})()`)
      const file = path.join(app.getPath('userData'), 'ssh-credentials', process.env.NOVA_DEV_SERVER ? 'development' : 'desktop', `asset-${reference}.bin`)
      const record = JSON.parse(require('electron').safeStorage.decryptString(require('node:fs').readFileSync(file)))
      value = record.version === 1 && record.options.auth.password === message.source
    }
    if (message.action === 'seed') {
      const fs = require('node:fs')
      const { safeStorage } = require('electron')
      const directory = path.join(app.getPath('userData'), 'ssh-credentials', process.env.NOVA_DEV_SERVER ? 'development' : 'desktop')
      fs.mkdirSync(directory, { recursive: true })
      const options = { host: 'review.invalid', port: 22, username: 'review', auth: { method: 'password', password: 'synthetic-review-only' } }
      const encrypted = safeStorage.encryptString(JSON.stringify({ version: 1, options }))
      const assets = Array.from({ length: 500 }, (_, i) => {
        fs.writeFileSync(path.join(directory, `asset-review-${i}.bin`), encrypted)
        return { kind: 'connection', id: `review-${i}`, name: `Review ${i}`, parentId: null, host: options.host, port: 22, username: 'review' }
      })
      await window.webContents.executeJavaScript(`localStorage.setItem('novaterminal.assets.v1', ${JSON.stringify(JSON.stringify({version:1,assets}))})`)
      value = fs.readdirSync(directory).filter(name => name.endsWith('.bin')).length
    }
    if (message.action === 'count') value = require('node:fs').readdirSync(path.join(app.getPath('userData'), 'ssh-credentials', process.env.NOVA_DEV_SERVER ? 'development' : 'desktop')).filter(name => name.endsWith('.bin')).length
    process.send({ id: message.id, value })
  } catch (error) { process.send({ id: message.id, error: String(error) }) }
})
require(path.resolve('out/electron/main.cjs'))
