const { app } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { once } = require('node:events')
const ssh2 = require('ssh2')

const shellPids = new Set()
const sshConnections = new Set()
let sshServer
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const closeTestServer = async () => {
  for (const connection of sshConnections) connection.end()
  if (sshServer?.listening) await new Promise((done) => sshServer.close(done))
}
const deadline = setTimeout(() => { console.error('Desktop smoke test timed out'); app.exit(1) }, 60_000)
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const evaluate = (source) => window.webContents.executeJavaScript(source)
      const clickWindowButton = async (label) => {
        window.focus()
        await delay(100)
        const point = await evaluate(`(() => {
          const button = Array.from(document.querySelectorAll('header button')).find(button => button.getAttribute('aria-label') === ${JSON.stringify(label)});
          if (!button) throw new Error('Window button missing');
          const rect = button.getBoundingClientRect();
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        })()`)
        window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
        window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
      }
      const wait = async (source) => {
        const until = Date.now() + 15_000
        while (!(await evaluate(source))) { if (Date.now() >= until) throw new Error(`Timed out: ${source}`); await delay(30) }
      }
      const preferences = window.webContents.getLastWebPreferences()
      assert.equal(preferences.nodeIntegration, false)
      assert.equal(preferences.contextIsolation, true)
      assert.equal(preferences.sandbox, true)
      const visibleDeadline = Date.now() + 5_000
      while (!window.isVisible()) { assert.ok(Date.now() < visibleDeadline, 'Desktop window must become visible'); await delay(30) }
      assert.equal(window.isMinimized(), false)
      await wait('Boolean(document.querySelector(\'button[aria-label="新建本地终端"]\'))')
      assert.equal(await evaluate('typeof require'), 'undefined')
      assert.equal(await evaluate('typeof window.novaTerminal.send'), 'function')
      assert.equal(await evaluate('typeof window.novaWindow.minimize'), 'function')
      assert.equal(await evaluate('Boolean(navigator.windowControlsOverlay?.visible)'), false)
      assert.equal(await evaluate('document.querySelector("header").getBoundingClientRect().height'), 48)
      assert.equal(await evaluate('getComputedStyle(document.querySelector("header")).getPropertyValue("-webkit-app-region")'), 'drag')
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".app-titlebar-actions")).getPropertyValue("-webkit-app-region")'), 'no-drag')
      assert.equal(await evaluate('document.querySelectorAll(\'header [aria-label="窗口控制"] button\').length'), 3)
      assert.ok(await evaluate('document.querySelector(\'header [aria-label="窗口控制"]\').getBoundingClientRect().right <= innerWidth'))
      await fs.mkdir(path.join(__dirname, '../test-results'), { recursive: true })
      await fs.writeFile(path.join(__dirname, '../test-results/titlebar-light.png'), (await window.webContents.capturePage()).toPNG())
      await clickWindowButton('最小化窗口')
      const minimizeDeadline = Date.now() + 5_000
      while (!window.isMinimized()) { if (Date.now() >= minimizeDeadline) throw new Error('Minimize button must minimize the window'); await delay(30) }
      assert.equal(window.isMinimized(), true)
      window.restore()
      window.show()
      await delay(150)
      await clickWindowButton('最大化窗口')
      await wait('Boolean(document.querySelector(\'button[aria-label="还原窗口"]\'))')
      assert.equal(window.isMaximized(), true)
      await clickWindowButton('还原窗口')
      await wait('Boolean(document.querySelector(\'button[aria-label="最大化窗口"]\'))')
      assert.equal(window.isMaximized(), false)
      // Native state changes (including title-bar double click) must update the UI too.
      window.maximize()
      await wait('Boolean(document.querySelector(\'button[aria-label="还原窗口"]\'))')
      window.unmaximize()
      await wait('Boolean(document.querySelector(\'button[aria-label="最大化窗口"]\'))')
      window.show()
      await delay(150)
      await evaluate(`window.__smoke = { events: [], output: '' }; window.novaTerminal.onEvent(event => { window.__smoke.events.push(event); if (event.message?.type === 'output') window.__smoke.output += event.message.data }); document.querySelector('button[aria-label="新建本地终端"]').click()`)
      await wait("window.__smoke.events.some(e => e.message?.type === 'ready')")
      await wait('window.__smoke.output.includes("PS ") || window.__smoke.output.length > 0')
      await evaluate("window.__smoke.first = window.__smoke.events.find(e => e.message?.type === 'ready').id")
      const send = (command) => evaluate("window.novaTerminal.send(window.__smoke.first, {type:'input', data:" + JSON.stringify(command) + "})")
      await send('echo NOVA_ELECTRON_OK\r')
      await wait('window.__smoke.output.split("NOVA_ELECTRON_OK").length >= 3')
      if (process.platform === 'win32') {
        await send("Write-Output ('NOVA_PID_' + $PID)\r")
        await wait('/NOVA_PID_\\d+/.test(window.__smoke.output)')
        shellPids.add(Number(await evaluate('window.__smoke.output.match(/NOVA_PID_(\\d+)/)[1]')))
      }
      await evaluate(`document.querySelector('button[aria-label="新建本地终端"]').click()`)
      await wait("window.__smoke.events.filter(e => e.message?.type === 'ready').length === 2")
      await evaluate(`document.querySelector('button[aria-label="关闭本地终端 2"]').click()`)
      await wait('document.querySelectorAll(\'[role="tab"]\').length === 1')
      await evaluate(`document.querySelector('button[aria-label="切换深色主题"]').click()`)
      await wait('document.documentElement.classList.contains("dark")')
      await wait('getComputedStyle(document.querySelector(\'button[aria-label="关闭窗口"]\')).color === getComputedStyle(document.querySelector("header")).color')
      await delay(200)
      await fs.writeFile(path.join(__dirname, '../test-results/titlebar-dark.png'), (await window.webContents.capturePage()).toPNG())
      window.setSize(1000, 700)
      await delay(150)
      await fs.mkdir(path.join(__dirname, '../test-results'), { recursive: true })
      await fs.writeFile(path.join(__dirname, '../test-results/electron-smoke.png'), (await window.webContents.capturePage()).toPNG())
      await evaluate(`document.querySelector('button[aria-label="连接 SSH 服务器"]').click()`)
      await wait('Boolean(document.querySelector(\'[role="dialog"]\'))')
      assert.equal(await evaluate('Boolean(document.querySelector(\'input[name="password"]\'))'), true)
      const hostKey = ssh2.utils.generateKeyPairSync('ed25519')
      sshServer = new ssh2.Server({ hostKeys: [hostKey.private] }, (connection) => {
        sshConnections.add(connection)
        connection.on('error', () => {})
        connection.on('authentication', (auth) => {
          if (auth.method === 'password' && auth.username === 'test-user' && auth.password === 'test-only') auth.accept()
          else auth.reject()
        })
        connection.on('ready', () => connection.on('session', (accept) => {
          const session = accept()
          session.on('pty', (acceptPty) => acceptPty())
          session.on('shell', (acceptShell) => {
            const stream = acceptShell()
            stream.on('error', () => {})
            stream.on('data', (data) => stream.write(`ECHO:${data.toString('utf8')}`))
          })
        }))
      })
      sshServer.listen(0, '127.0.0.1')
      await once(sshServer, 'listening')
      const port = sshServer.address().port
      await evaluate(`(() => { const form = document.querySelector('[role="dialog"] form'); form.elements.host.value = '127.0.0.1'; form.elements.port.value = '${port}'; form.elements.username.value = 'test-user'; form.elements.password.value = 'test-only'; form.requestSubmit() })()`)
      await wait("window.__smoke.events.some(e => e.message?.type === 'host-key')")
      await wait("document.body.innerText.includes('信任并连接')")
      await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '信任并连接').click()")
      await wait("window.__smoke.events.filter(e => e.message?.type === 'ready').length === 3")
      await evaluate("window.__smoke.ssh = window.__smoke.events.find(e => e.message?.type === 'host-key').id; window.novaTerminal.send(window.__smoke.ssh, {type:'input',data:'NOVA_SSH_ELECTRON_OK'})")
      await wait('window.__smoke.output.includes("ECHO:NOVA_SSH_ELECTRON_OK")')
      await evaluate(`(() => {
        const textarea = document.querySelector('[role="tabpanel"][data-state="active"] .xterm-helper-textarea');
        if (!textarea) throw new Error('Active SSH terminal input not found');
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', 'x'.repeat(16383) + '🚀中文_NOVA_PASTE_OK');
        textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      })()`)
      await wait('window.__smoke.output.includes("🚀中文_NOVA_PASTE_OK")')
      await wait(`document.querySelector('[role="tabpanel"][data-state="active"] .xterm-rows')?.textContent.includes('🚀中文_NOVA_PASTE_OK')`)
      await fs.writeFile(path.join(__dirname, '../test-results/electron-review-unicode.png'), (await window.webContents.capturePage()).toPNG())
      await closeTestServer()
      console.log('Desktop smoke passed: unified title bar, window button input, state sync, theme, sandbox, preload, PTY, input, tabs, resize, SSH trust, authentication and Unicode paste.')
      const closed = once(window, 'closed')
      await clickWindowButton('关闭窗口')
      await closed
      if (process.platform === 'darwin') app.quit()
    } catch (error) { console.error(error); process.exitCode = 1; await closeTestServer(); app.quit() }
  })
})
app.on('quit', () => {
  clearTimeout(deadline)
  for (const connection of sshConnections) connection.end()
  sshServer?.close()
  for (const pid of shellPids) {
    try { process.kill(pid, 0); console.error('Shell remains after shutdown:', pid); process.exitCode = 1 }
    catch { /* Shell correctly exited. */ }
  }
})
if (process.env.NOVA_TEST_PROFILE) app.setPath('userData', process.env.NOVA_TEST_PROFILE)
require(process.argv[2] || '../out/electron/main.cjs')
