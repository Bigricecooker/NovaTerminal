const { app, clipboard, dialog, safeStorage, utilityProcess } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { once } = require('node:events')
const ssh2 = require('ssh2')

const shellPids = new Set()
const sshConnections = new Set()
const liveWorkers = new Set()
const originalFork = utilityProcess.fork
utilityProcess.fork = (...args) => {
  const worker = originalFork.apply(utilityProcess, args)
  liveWorkers.add(worker)
  worker.once('exit', () => liveWorkers.delete(worker))
  return worker
}
let sshServer
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const waitWorkers = async (maximum) => {
  const until = Date.now() + 8_000
  while (liveWorkers.size > maximum) { if (Date.now() >= until) throw new Error('Closed session workers did not exit'); await delay(30) }
}
const closeTestServer = async () => {
  for (const connection of sshConnections) connection.end()
  if (sshServer?.listening) await new Promise((done) => sshServer.close(done))
}
const deadline = setTimeout(() => { console.error('Desktop smoke test timed out'); app.exit(1) }, 60_000)
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const evaluate = (source) => window.webContents.executeJavaScript(source)
      const pointerClick = async (selector, clickCount = 1) => {
        window.focus()
        const point = await evaluate(`(() => {
          const element = document.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({block:'nearest'});
          const r = element.getBoundingClientRect(); return {x:Math.round(r.left + r.width/2),y:Math.round(r.top + r.height/2)};
        })()`)
        window.webContents.sendInputEvent({type:'mouseDown', ...point, button:'left', clickCount})
        window.webContents.sendInputEvent({type:'mouseUp', ...point, button:'left', clickCount})
        await delay(60)
      }
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
      if (process.env.NOVA_DEV_SERVER) {
        window.focus()
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F12' })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F12' })
        const toolsDeadline = Date.now() + 5_000
        while (!window.webContents.isDevToolsOpened()) { if (Date.now() >= toolsDeadline) throw new Error('Development shortcut must open DevTools'); await delay(30) }
        window.webContents.closeDevTools()
      }
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
      await wait('Boolean(document.querySelector(\'[role="alertdialog"]\'))')
      await evaluate('document.querySelector(\'[data-slot="alert-dialog-cancel"]\').click()')
      assert.equal(await evaluate('document.querySelectorAll(\'[role="tab"]\').length'), 2)
      await evaluate(`document.querySelector('button[aria-label="关闭本地终端 2"]').click()`)
      await wait('Boolean(document.querySelector(\'[role="alertdialog"]\'))')
      await evaluate('document.querySelector(\'[data-slot="alert-dialog-action"]\').click()')
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
      await evaluate(`document.querySelector('button[aria-label="添加连接"]').click()`)
      await wait('Boolean(document.querySelector(\'[role="dialog"]\'))')
      assert.equal(await evaluate('Boolean(document.querySelector(\'input[name="password"]\'))'), true)
      const readyBeforeSave = await evaluate('window.__smoke.events.filter(e => e.message?.type === "ready").length')
      await evaluate(`(() => {
        const select = document.querySelector('[role="dialog"] select[name="authMethod"]');
        select.value = 'privateKey'; select.dispatchEvent(new Event('change', {bubbles:true}));
      })()`)
      await wait('Boolean(document.querySelector(\'[role="dialog"] textarea[name="privateKey"]\'))')
      window.setSize(720, 480); window.focus()
      await delay(300)
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      assert.equal(await evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]').getBoundingClientRect();
        const button = document.querySelector('[role="dialog"] button[value="connect"]').getBoundingClientRect();
        return dialog.top >= 0 && button.top >= dialog.top && button.bottom <= dialog.bottom && dialog.bottom <= innerHeight;
      })()`), true, 'Connection actions must stay visible at the minimum window size')
      await fs.writeFile(path.join(__dirname, '../test-results/add-connection-small.png'), (await window.webContents.capturePage()).toPNG())
      window.setSize(1000, 700)
      await evaluate(`(() => {
        const form = document.querySelector('[role="dialog"] form');
        form.elements.name.value = '仅保存 SSH'; form.elements.host.value = 'example.invalid'; form.elements.username.value = 'test';
        form.elements.privateKey.value = 'test-only-private-key'; form.elements.passphrase.value = 'test-only-passphrase';
      })()`)
      const vaultDirectory = path.join(app.getPath('userData'), 'ssh-credentials', process.env.NOVA_DEV_SERVER ? 'development' : 'desktop')
      const originalEncryptionAvailable = safeStorage.isEncryptionAvailable
      safeStorage.isEncryptionAvailable = () => false
      try {
        await evaluate('document.querySelector(\'[role="dialog"] form\').requestSubmit(document.querySelector(\'[role="dialog"] button[value="save"]\'))')
        await wait('document.querySelector(\'[role="dialog"]\').textContent.includes("无法安全保存")')
        assert.equal(await evaluate('localStorage.getItem("novaterminal.assets.v1")'), null)
        assert.equal(await fs.stat(vaultDirectory).then(() => true, () => false), false)
      } finally { safeStorage.isEncryptionAvailable = originalEncryptionAvailable }
      await evaluate('window.__originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => {throw new Error("test quota")}; void 0')
      await evaluate('document.querySelector(\'[role="dialog"] form\').requestSubmit(document.querySelector(\'[role="dialog"] button[value="save"]\'))')
      await wait('document.querySelector(\'[role="dialog"]\').textContent.includes("保存失败")')
      assert.deepEqual(await fs.readdir(vaultDirectory), [], 'Failed asset persistence must roll back encrypted credentials')
      await evaluate('Storage.prototype.setItem = window.__originalSetItem; document.querySelector(\'[role="dialog"] form\').requestSubmit(document.querySelector(\'[role="dialog"] button[value="save"]\'))')
      await wait('!document.querySelector(\'[role="dialog"]\')')
      assert.equal(await evaluate('window.__smoke.events.filter(e => e.message?.type === "ready").length'), readyBeforeSave)
      assert.equal(await evaluate('localStorage.getItem("novaterminal.assets.v1").includes("test-only")'), false)
      assert.equal(await evaluate('typeof window.novaCredentials.load'), 'undefined')
      const encryptedPrivateKey = await fs.readFile(path.join(vaultDirectory, (await fs.readdir(vaultDirectory))[0]))
      assert.equal(encryptedPrivateKey.includes(Buffer.from('test-only-private-key')), false)
      assert.equal(encryptedPrivateKey.includes(Buffer.from('test-only-passphrase')), false)
      await evaluate(`document.querySelector('button[aria-label="添加连接"]').click()`)
      await wait('Boolean(document.querySelector(\'[role="dialog"] input[name="password"]\'))')
      window.show(); window.focus()
      await delay(300)
      assert.equal(await evaluate('document.querySelector(\'[role="dialog"]\').getAttribute("data-state")'), 'open')
      await fs.writeFile(path.join(__dirname, '../test-results/add-connection.png'), (await window.webContents.capturePage()).toPNG())
      const hostKey = ssh2.utils.generateKeyPairSync('ed25519')
      const sshInputBytes = []
      let sshStream
      sshServer = new ssh2.Server({ hostKeys: [hostKey.private] }, (connection) => {
        sshConnections.add(connection)
        connection.on('error', () => {})
        connection.on('authentication', (auth) => {
          if (auth.method === 'password' && ['test-user', 'edited-user'].includes(auth.username) && auth.password === 'test-only') auth.accept()
          else auth.reject()
        })
        connection.on('ready', () => connection.on('session', (accept) => {
          const session = accept()
          session.on('pty', (acceptPty) => acceptPty())
          session.on('shell', (acceptShell) => {
            const stream = acceptShell()
            sshStream = stream
            stream.on('error', () => {})
            stream.on('data', (data) => { sshInputBytes.push(data); stream.write(`ECHO:${data.toString('utf8')}`) })
          })
        }))
      })
      sshServer.listen(0, '127.0.0.1')
      await once(sshServer, 'listening')
      const port = sshServer.address().port
      await evaluate(`(() => { const form = document.querySelector('[role="dialog"] form'); form.elements.name.value = '测试 SSH'; form.elements.host.value = '127.0.0.1'; form.elements.port.value = '${port}'; form.elements.username.value = 'test-user'; form.elements.password.value = 'test-only'; form.requestSubmit(form.querySelector('button[value="connect"]')) })()`)
      await wait("window.__smoke.events.some(e => e.message?.type === 'host-key')")
      await wait("document.body.innerText.includes('信任并连接')")
      await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '信任并连接').click()")
      await wait("window.__smoke.events.filter(e => e.message?.type === 'ready').length === 3")
      await evaluate("window.__smoke.ssh = window.__smoke.events.find(e => e.message?.type === 'host-key').id; window.novaTerminal.send(window.__smoke.ssh, {type:'input',data:'NOVA_SSH_ELECTRON_OK'})")
      await wait('window.__smoke.output.includes("ECHO:NOVA_SSH_ELECTRON_OK")')
      await clipboard.writeText('x'.repeat(16383) + '🚀中文_NOVA_PASTE_OK')
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
      const originalReadText = clipboard.readText
      const pasteSynthetic = () => evaluate(`document.querySelector('[role="tabpanel"][data-state="active"] .xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true }))`)
      try {
        const beforeRejectedPaste = Buffer.concat(sshInputBytes).length
        clipboard.readText = () => '\x01'.repeat(65_536)
        await pasteSynthetic()
        await wait('document.body.textContent.includes("输入超过缓冲限制")')
        await delay(100)
        assert.equal(Buffer.concat(sshInputBytes).length, beforeRejectedPaste, 'Rejected paste must send no partial input')
        clipboard.readText = () => 'NOVA_AFTER_REJECT'
        await pasteSynthetic()
        await wait('window.__smoke.output.includes("ECHO:NOVA_AFTER_REJECT")')
        assert.equal(await evaluate('window.__smoke.events.some(e => e.id === window.__smoke.ssh && (e.closed || e.message?.type === "error"))'), false)
      } finally { clipboard.readText = originalReadText }
      window.setSize(1400, 800)
      await wait(`Number(document.querySelector('[role="tabpanel"][data-state="active"] footer span[aria-label]')?.getAttribute('aria-label').split(' ')[0]) > 100`)
      sshStream.write('\x1b[?1000h')
      await wait('window.__smoke.output.includes("\\x1b[?1000h")')
      await delay(150)
      for (const column of [7, 100]) {
        const point = await evaluate(`(() => {
          const panel = document.querySelector('[role="tabpanel"][data-state="active"]');
          const r = panel.querySelector('.xterm-screen').getBoundingClientRect();
          const size = panel.querySelector('footer span[aria-label]').getAttribute('aria-label').split(' ');
          return { x: Math.round(r.x + (${column} - .5) * r.width / Number(size[0])), y: Math.round(r.y + 1.5 * r.height / Number(size[2])) };
        })()`)
        const beforeMouse = Buffer.concat(sshInputBytes).length
        window.focus()
        window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
        window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
        const until = Date.now() + 3_000
        while (Buffer.concat(sshInputBytes).length < beforeMouse + 12) { assert.ok(Date.now() < until, 'Legacy mouse input did not reach SSH'); await delay(20) }
        assert.deepEqual(Buffer.concat(sshInputBytes).subarray(beforeMouse), Buffer.from([27, 91, 77, 32, column + 32, 34, 27, 91, 77, 35, column + 32, 34]))
      }
      sshStream.write('\x1b[?1000l')
      await delay(100)
      window.setSize(1000, 700)
      // Exercise the native picker IPC through its production handler; only the OS dialog is stubbed in this test process.
      assert.equal(await evaluate('Boolean(document.querySelector(\'header button[aria-label="连接 SSH 服务器"]\'))'), false)
      const beforeLocal = await evaluate('localStorage.getItem("novaterminal.assets.v1")')
      assert.ok(beforeLocal.includes('测试 SSH') && !beforeLocal.includes('test-only'))
      const beforeTabs = await evaluate('document.querySelectorAll("[data-session-tab]").length')
      const addLocal = async () => {
        await evaluate('document.querySelector(\'button[aria-label="添加本地连接"]\').click()')
        await wait('!document.querySelector(\'button[aria-label="添加本地连接"]\').disabled')
      }
      const originalDialog = dialog.showOpenDialog
      try {
        dialog.showOpenDialog = async (_owner, options) => {
          assert.deepEqual(options.properties, ['openDirectory'])
          return { canceled: true, filePaths: [] }
        }
        await addLocal()
        assert.equal(await evaluate('localStorage.getItem("novaterminal.assets.v1")'), beforeLocal)
        assert.equal(await evaluate('document.querySelectorAll("[data-session-tab]").length'), beforeTabs)
        const directory = path.join(app.getPath('userData'), '项目 目录')
        await fs.mkdir(directory, { recursive: true })
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
        await evaluate('window.__setItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error("test quota") }; void 0')
        await addLocal()
        assert.equal(await evaluate('localStorage.getItem("novaterminal.assets.v1")'), beforeLocal)
        assert.equal(await evaluate('document.querySelectorAll("[data-session-tab]").length'), beforeTabs)
        await evaluate('Storage.prototype.setItem = window.__setItem; void 0')
        const readyBefore = await evaluate('window.__smoke.events.filter(e => e.message?.type === "ready").length')
        await addLocal()
        await wait(`window.__smoke.events.filter(e => e.message?.type === 'ready').length === ${readyBefore + 1}`)
        const local = await evaluate('JSON.parse(localStorage.getItem("novaterminal.assets.v1")).assets.find(a => a.kind === "local")')
        assert.equal(local.directory, directory)
        assert.equal(local.parentId, null)
        assert.equal(local.name, '项目 目录')
        assert.equal(await evaluate('document.querySelector(\'button[aria-label="连接 项目 目录"]\').closest("li").parentElement.parentElement.matches(\'nav[aria-label="连接和分组"]\')'), true)
        await evaluate('window.__smoke.local = window.__smoke.events.filter(e => e.message?.type === "ready").at(-1).id')
        const checkCwd = process.platform === 'win32'
          ? `if ((Get-Location).Path -eq '${directory.replaceAll("'", "''")}') { [Console]::WriteLine(('NOVA_CWD_' + 'OK')) }\r`
          : `test "$PWD" = '${directory.replaceAll("'", "'\\''")}' && printf 'NOVA_CWD_%s\\n' OK\r`
        await delay(400)
        await evaluate(`window.novaTerminal.send(window.__smoke.local, {type:'input', data:${JSON.stringify(checkCwd)}})`)
        await wait('window.__smoke.output.includes("NOVA_CWD_OK")')
        await evaluate('document.querySelector(\'button[aria-label="关闭项目 目录"]\').click()')
        await wait('Boolean(document.querySelector(\'[role="alertdialog"]\'))')
        await evaluate('document.querySelector(\'[data-slot="alert-dialog-action"]\').click()')
        await wait(`document.querySelectorAll('[data-session-tab]').length === ${beforeTabs}`)
        await waitWorkers(beforeTabs)
        await wait('!document.querySelector(\'[role="alertdialog"]\') && getComputedStyle(document.body).pointerEvents !== "none"')
        await delay(150)
        await pointerClick('button[aria-label="连接 项目 目录"]')
        assert.equal(await evaluate('document.querySelectorAll("[data-session-tab]").length'), beforeTabs, 'A single local asset click must not open a session')
        assert.equal(await evaluate('Boolean(document.querySelector(\'[role="dialog"]\'))'), false)
        await pointerClick('button[aria-label="连接 项目 目录"]', 2)
        await wait(`window.__smoke.events.filter(e => e.message?.type === 'ready').length === ${readyBefore + 2}`)
        assert.equal(await evaluate('document.querySelectorAll("[data-session-tab]").length'), beforeTabs + 1, 'A double click must open exactly one session')
        await evaluate('document.querySelector(\'button[aria-label="连接 项目 目录"]\').focus()')
        await evaluate('document.querySelector(\'button[aria-label="连接 项目 目录"]\').dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",repeat:true,bubbles:true,cancelable:true}))')
        assert.equal(await evaluate('document.querySelectorAll("[data-session-tab]").length'), beforeTabs + 1, 'A repeated key must not open a session even below the session limit')
        window.webContents.sendInputEvent({type:'keyDown', keyCode:'Return'})
        window.webContents.sendInputEvent({type:'keyUp', keyCode:'Return'})
        await wait(`window.__smoke.events.filter(e => e.message?.type === 'ready').length === ${readyBefore + 3}`)
        assert.equal(await evaluate('document.querySelectorAll("[data-session-tab]").length'), beforeTabs + 2)
        assert.equal(await evaluate('document.querySelector(\'button[aria-label="连接 项目 目录"]\').disabled'), true)
        await pointerClick('button[aria-label="连接 项目 目录"]', 2)
        assert.equal(await evaluate('document.querySelectorAll("[data-session-tab]").length'), beforeTabs + 2, 'A disabled asset must not connect at the session limit')
        await fs.writeFile(path.join(__dirname, '../test-results/local-connection.png'), (await window.webContents.capturePage()).toPNG())
        const loaded = once(window.webContents, 'did-finish-load'); window.webContents.reload(); await loaded
        await wait('Boolean(document.querySelector(\'button[aria-label="连接 项目 目录"]\'))')
        await waitWorkers(0)
        assert.equal(await evaluate('Boolean(document.querySelector(\'button[aria-label="资产根目录"]\'))'), false)
        assert.equal(await evaluate('Boolean(document.querySelector(\'button[aria-label="未分组"]\'))'), false)
        assert.equal(await evaluate('document.querySelector(\'button[aria-label="连接 项目 目录"]\').closest("li").parentElement.parentElement.matches(\'nav[aria-label="连接和分组"]\')'), true)
        await evaluate('window.__reopen = []; window.novaTerminal.onEvent(e => window.__reopen.push(e)); void 0')
        await pointerClick('button[aria-label="连接 测试 SSH"]')
        assert.equal(await evaluate('Boolean(document.querySelector(\'[role="dialog"]\'))'), false)
        assert.equal(await evaluate('document.querySelectorAll("[data-session-tab]").length'), 0)
        await pointerClick('button[aria-label="连接 测试 SSH"]', 2)
        await wait('window.__reopen.some(e => e.message?.type === "ready")')
        assert.equal(await evaluate('window.__reopen.filter(e => e.message?.type === "ready").length'), 1)
        assert.equal(await evaluate('Boolean(document.querySelector(\'[role="dialog"]\'))'), false)
        assert.equal(await evaluate('window.__reopen.some(e => ["error","host-key"].includes(e.message?.type))'), false)
        const savedSsh = await evaluate('JSON.parse(localStorage.getItem("novaterminal.assets.v1")).assets.find(a => a.name === "测试 SSH")')
        const encryptedPassword = await fs.readFile(path.join(vaultDirectory, `asset-${savedSsh.id}.bin`))
        assert.equal(encryptedPassword.includes(Buffer.from('test-only')), false)
        assert.equal(await evaluate('document.querySelector(\'[role="tab"][data-state="active"]\').textContent.trim()'), '测试 SSH')
        assert.equal(await evaluate('document.querySelector(\'button[aria-label="连接 测试 SSH"]\').title'), 'test-user@127.0.0.1')
        const editSsh = async () => {
          await evaluate(`document.querySelector('[data-asset-row="${savedSsh.id}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:210}))`)
          await wait('Boolean(document.querySelector(\'[role="menu"]\'))')
          await evaluate('Array.from(document.querySelectorAll(\'[role="menuitem"]\')).find(item => item.textContent.trim() === "编辑").click()')
          await wait('Boolean(document.querySelector(\'[role="dialog"] input[name="host"]\'))')
        }
        await evaluate('window.__runningTerminal = document.querySelector(".xterm"); window.__beforeEditEvents = window.__reopen.length; void 0')
        await editSsh()
        assert.equal(await evaluate('document.querySelector(\'[role="dialog"] input[name="host"]\').value'), '127.0.0.1')
        assert.equal(await evaluate('document.querySelector(\'[role="dialog"] input[name="username"]\').value'), 'test-user')
        assert.equal(await evaluate('Boolean(document.querySelector(\'[role="dialog"] input[name="password"]\'))'), false)
        await evaluate('document.querySelector(\'[role="dialog"] input[name="name"]\').value = "编辑 SSH"; document.querySelector(\'[role="dialog"] form\').requestSubmit()')
        await wait('!document.querySelector(\'[role="dialog"]\')')
        assert.equal(await evaluate('document.querySelector(\'[role="tab"][data-state="active"]\').textContent.trim()'), '编辑 SSH')
        assert.equal(await evaluate('window.__runningTerminal === document.querySelector(".xterm")'), true)
        assert.equal(await evaluate('window.__reopen.length'), await evaluate('window.__beforeEditEvents'))
        await editSsh()
        await evaluate(`(() => { const select = document.querySelector('[role="dialog"] select[name="authMethod"]'); select.value = 'password'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`)
        await wait('Boolean(document.querySelector(\'[role="dialog"] input[name="password"]\'))')
        await evaluate('document.querySelector(\'[role="dialog"] input[name="password"]\').value = "test-only"; document.querySelector(\'[role="dialog"] input[name="username"]\').value = "edited-user"; window.__editBefore = localStorage.getItem("novaterminal.assets.v1"); void 0')
        const beforeRevisionFiles = (await fs.readdir(vaultDirectory)).sort()
        safeStorage.isEncryptionAvailable = () => false
        try {
          await evaluate('document.querySelector(\'[role="dialog"] form\').requestSubmit()')
          await wait('document.querySelector(\'[role="dialog"]\').textContent.includes("无法安全保存")')
          assert.equal(await evaluate('localStorage.getItem("novaterminal.assets.v1") === window.__editBefore'), true)
          assert.deepEqual((await fs.readdir(vaultDirectory)).sort(), beforeRevisionFiles)
        } finally { safeStorage.isEncryptionAvailable = originalEncryptionAvailable }
        await evaluate('window.__editSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error("test quota") }; document.querySelector(\'[role="dialog"] form\').requestSubmit()')
        await wait('document.querySelector(\'[role="dialog"]\').textContent.includes("保存失败")')
        assert.equal(await evaluate('localStorage.getItem("novaterminal.assets.v1") === window.__editBefore'), true)
        assert.deepEqual((await fs.readdir(vaultDirectory)).sort(), beforeRevisionFiles)
        assert.deepEqual(await fs.readFile(path.join(vaultDirectory, `asset-${savedSsh.id}.bin`)), encryptedPassword)
        await evaluate('Storage.prototype.setItem = window.__editSetItem; document.querySelector(\'[role="dialog"] form\').requestSubmit()')
        await wait('!document.querySelector(\'[role="dialog"]\')')
        const editedSsh = await evaluate(`JSON.parse(localStorage.getItem('novaterminal.assets.v1')).assets.find(a => a.id === '${savedSsh.id}')`)
        assert.ok(editedSsh.credentialId && editedSsh.credentialId !== savedSsh.id)
        assert.equal(editedSsh.username, 'edited-user')
        assert.equal(await evaluate('document.querySelector(\'button[aria-label="连接 编辑 SSH"]\').title'), 'edited-user@127.0.0.1')
        assert.equal(await fs.stat(path.join(vaultDirectory, `asset-${savedSsh.id}.bin`)).then(() => true, () => false), false)
        const revision = await fs.readFile(path.join(vaultDirectory, `asset-${editedSsh.credentialId}.bin`))
        assert.equal(revision.includes(Buffer.from('test-only')), false)
        assert.equal(await evaluate('localStorage.getItem("novaterminal.assets.v1").includes("test-only")'), false)
        assert.equal(await evaluate('window.__runningTerminal === document.querySelector(".xterm")'), true)
        const afterEditLoaded = once(window.webContents, 'did-finish-load'); window.webContents.reload(); await afterEditLoaded
        await wait('Boolean(document.querySelector(\'button[aria-label="连接 编辑 SSH"]\'))')
        await waitWorkers(0)
        await evaluate('window.__editedEvents = []; window.novaTerminal.onEvent(e => window.__editedEvents.push(e)); void 0')
        await pointerClick('button[aria-label="连接 编辑 SSH"]', 2)
        await wait('window.__editedEvents.some(e => e.message?.type === "ready")')
        assert.equal(await evaluate('document.querySelector(\'[role="tab"][data-state="active"]\').textContent.trim()'), '编辑 SSH')
        assert.equal(await evaluate('window.__editedEvents.some(e => ["error","host-key"].includes(e.message?.type))'), false)
        await evaluate(`(() => { const row = document.querySelector('[data-asset-row="${savedSsh.id}"]'); row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:210})); })()`)
        await wait('Boolean(document.querySelector(\'[role="menu"]\'))')
        await evaluate('Array.from(document.querySelectorAll(\'[role="menuitem"]\')).find(item => item.textContent.trim() === "删除").click()')
        await wait('Boolean(document.querySelector(\'[role="alertdialog"]\'))')
        await evaluate('document.querySelector(\'[data-slot="alert-dialog-action"]\').click()')
        await wait('!document.querySelector(\'[role="alertdialog"]\')')
        assert.equal(await fs.stat(path.join(vaultDirectory, `asset-${editedSsh.credentialId}.bin`)).then(() => true, () => false), false)
        assert.equal(await evaluate('document.querySelectorAll("[data-session-tab]").length'), 1, 'Deleting an asset must preserve its live session')
      } finally { dialog.showOpenDialog = originalDialog }
      console.log('Desktop smoke passed: unified title bar, window button input, state sync, theme, sandbox, preload, PTY, input, tabs, resize, SSH trust, authentication, Unicode paste, directory picker cancellation, save failure, local cwd, connection editing, credential revision rollback, live tab names and edited SSH reopen.')
      const closed = once(window, 'closed')
      await clickWindowButton('关闭窗口')
      await wait('Boolean(document.querySelector(\'[role="alertdialog"]\'))')
      await evaluate('document.querySelector(\'[data-slot="alert-dialog-cancel"]\').click()')
      assert.equal(window.isDestroyed(), false)
      await wait('!document.querySelector(\'[role="alertdialog"]\') && getComputedStyle(document.body).pointerEvents !== "none"')
      await clickWindowButton('关闭窗口')
      await wait('Boolean(document.querySelector(\'[role="alertdialog"]\'))')
      await evaluate('document.querySelector(\'[data-slot="alert-dialog-action"]\').click()')
      await closed
      if (process.platform === 'darwin') app.quit()
    } catch (error) {
      console.error(error); process.exitCode = 1
      await fs.writeFile(path.join(__dirname, '../test-results/desktop-failure.png'), (await window.webContents.capturePage()).toPNG())
      await closeTestServer(); app.exit(1)
    }
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
