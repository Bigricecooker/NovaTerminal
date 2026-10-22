import { spawn } from 'node:child_process'
import { mkdtemp, rm, cp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import WebSocket from 'ws'

if (process.platform !== 'win32') throw new Error('This standalone package check currently targets Windows')
const temporary = await mkdtemp(join(tmpdir(), 'novaterminal-package-test-'))
const packageDirectory = resolve(process.argv[2] || 'release/NovaTerminal-win32-x64')
// Exercise the portable directory outside the working tree, with a fresh profile.
const staged = join(temporary, 'app')
await cp(packageDirectory, staged, { recursive: true })
const probe = createServer()
probe.listen(0, '127.0.0.1')
await once(probe, 'listening')
const port = probe.address().port
await new Promise((done) => probe.close(done))
const env = { ...process.env, APPDATA: join(temporary, 'profile') }
delete env.ELECTRON_RUN_AS_NODE
delete env.NOVA_DEV_SERVER
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') env[key] = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`
const profile = join(temporary, 'profile')
await mkdir(join(profile, 'settings'), { recursive: true })
await writeFile(join(profile, 'settings', 'desktop.json'), JSON.stringify({ version: 1, values: { theme: 'light', fontSize: 19 } }))
const cleanup = async () => {
  if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith('novaterminal-package-test-')) throw new Error('Unexpected package test cleanup path')
  await rm(temporary, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
}
async function run(phase) {
  const child = spawn(join(staged, 'NovaTerminal.exe'), [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], {
    env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: false,
  })
  let stderr = ''
  child.stderr.on('data', (data) => { stderr += data.toString() })
  const exited = new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code) => done(code)) })
  const timeout = setTimeout(() => child.kill(), 45_000)
  let socket
  let shellPid
  const delay = (ms) => new Promise((done) => setTimeout(done, ms))
  try {
    let target
    const until = Date.now() + 15_000
    while (!target) {
      assert.equal(child.exitCode, null, stderr || 'Packaged app exited during startup')
      try {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        target = pages.find((page) => page.type === 'page' && page.url === 'app://novaterminal/index.html')
      } catch { /* Wait for the local debug endpoint. */ }
      assert.ok(Date.now() < until, 'Packaged window did not become ready')
      if (!target) await delay(50)
    }
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await once(socket, 'open')
    let sequence = 0
    const requests = new Map()
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString())
      const pending = requests.get(message.id)
      if (!pending) return
      requests.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    socket.once('close', () => { for (const pending of requests.values()) pending.reject(new Error('Debug connection closed')); requests.clear() })
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence
      requests.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression) => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    const wait = async (expression) => {
      const until = Date.now() + 15_000
      while (!(await evaluate(expression))) { assert.ok(Date.now() < until, `Timed out: ${expression}`); await delay(30) }
    }
    assert.equal(await evaluate('typeof require'), 'undefined')
    assert.equal(await evaluate('typeof window.novaTerminal.send'), 'function')
    assert.equal(await evaluate('window.novaSettings.initial.values.fontSize'), phase === 'corrupt' ? 14 : 19, 'Packaged app must use the explicitly isolated profile')
    await wait('Boolean(document.querySelector(\'button[aria-label="新建本地终端"]\'))')
    if (phase !== 'initial') {
      const snapshot = await evaluate('window.novaSettings.initial')
      if (phase === 'restart') {
        assert.equal(snapshot.values.theme, 'dark')
        assert.equal(snapshot.values.shell, 'cmd')
        assert.equal(snapshot.values.maxSessions, 6)
        assert.equal(snapshot.values.confirmMultiline, true)
        assert.equal(snapshot.warning, '')
        assert.equal(await evaluate('document.documentElement.classList.contains("dark")'), true)
      } else {
        assert.equal(snapshot.values.theme, 'system')
        assert.equal(snapshot.values.shell, 'default')
        assert.equal(snapshot.values.maxSessions, 4)
        assert.equal(snapshot.warning, '设置无法读取，已恢复默认。')
        await wait('document.body.textContent.includes("设置无法读取，已恢复默认。")')
        const backups = (await readdir(join(profile, 'settings'))).filter(name => name.startsWith('settings.corrupt-'))
        assert.equal(backups.length, 1)
        assert.equal(await readFile(join(profile, 'settings', backups[0]), 'utf8'), '{broken-settings')
      }
      child.send({ type: 'app:quit' })
      assert.equal(await exited, 0, stderr)
      console.log(`Packaged settings passed: ${phase}.`)
      return
    }
    await evaluate(`window.__packageTest = {events: [], output: ''}; window.novaTerminal.onEvent(event => { window.__packageTest.events.push(event); if (event.message?.type === 'output') window.__packageTest.output += event.message.data }); document.querySelector('button[aria-label="新建本地终端"]').click()`)
    await wait("window.__packageTest.events.some(e => e.message?.type === 'ready')")
    await evaluate("window.__packageTest.id = window.__packageTest.events.find(e => e.message?.type === 'ready').id; window.novaTerminal.send(window.__packageTest.id, {type:'input',data:\"echo NOVA_PACKAGE_OK\\rWrite-Output ('NOVA_PID_' + $PID)\\r\"})")
    await wait('window.__packageTest.output.split("NOVA_PACKAGE_OK").length >= 3 && /NOVA_PID_\\d+/.test(window.__packageTest.output)')
    shellPid = Number(await evaluate('window.__packageTest.output.match(/NOVA_PID_(\\d+)/)[1]'))
    await evaluate(`document.querySelector('button[aria-label="切换深色主题"]').click()`)
    await wait('document.documentElement.classList.contains("dark")')
    assert.equal(JSON.parse(await readFile(join(profile, 'settings', 'desktop.json'), 'utf8')).values.theme, 'dark')
    await evaluate('window.novaSettings.save({...window.novaSettings.initial.values, theme:"dark", shell:"cmd", maxSessions:6, confirmMultiline:true})')
    const shot = await call('Page.captureScreenshot', { format: 'png' })
    await mkdir('test-results', { recursive: true })
    await writeFile('test-results/electron-package-smoke.png', Buffer.from(shot.data, 'base64'))
    assert.equal(child.connected, true)
    const cancelled = once(child, 'message')
    child.send({ type: 'app:quit' })
    await wait('Boolean(document.querySelector(\'[role="alertdialog"]\'))')
    await evaluate('document.querySelector(\'[data-slot="alert-dialog-cancel"]\').click()')
    assert.deepEqual((await cancelled)[0], { type: 'app:quit-cancelled' })
    assert.equal(child.exitCode, null)
    await wait('!document.querySelector(\'[role="alertdialog"]\')')
    child.send({ type: 'app:quit' })
    await wait('Boolean(document.querySelector(\'[role="alertdialog"]\'))')
    // Return the CDP response before the confirmed close tears down the renderer.
    await evaluate('setTimeout(() => document.querySelector(\'[data-slot="alert-dialog-action"]\').click(), 100); true')
    assert.equal(await exited, 0, stderr)
    let shellAlive = true
    try { process.kill(shellPid, 0) } catch { shellAlive = false }
    assert.equal(shellAlive, false, 'Packaged shell remained after application quit')
    console.log('Packaged executable passed: no system Node.js, local assets, preload, PTY, input, theme, quit cancellation / retry and graceful shell cleanup.')
  } finally {
    clearTimeout(timeout)
    socket?.terminate()
    if (child.exitCode === null) { child.kill(); await exited }
  }
}
try {
  await run('initial')
  await run('restart')
  await writeFile(join(profile, 'settings', 'desktop.json'), '{broken-settings')
  await run('corrupt')
} finally { await cleanup() }
