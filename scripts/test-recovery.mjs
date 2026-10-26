import { spawn } from 'node:child_process'
import electron from 'electron'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
const dev = process.argv.includes('--dev')
let server
if (dev) { server = await createServer({ logLevel: 'error' }); await server.listen() }
const temporary = await mkdtemp(join(tmpdir(), 'novaterminal-recovery-'))
const children = []
const results = []
async function launch(profile, secondary = false) {
  const env = { ...process.env, NOVA_TEST_PROFILE: profile, APPDATA: temporary, XDG_CONFIG_HOME: temporary }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NOVA_DEV_SERVER
  if (dev) env.NOVA_DEV_SERVER = 'http://127.0.0.1:5180/'
  const child = spawn(electron, ['scripts/recovery-smoke.cjs'], {env, stdio:['ignore','pipe','pipe','ipc'], windowsHide:false})
  children.push(child)
  child.stderr.on('data', data => { const text = String(data); if (!text.includes('CONSOLE')) process.stderr.write(text) })
  const pending = new Map()
  let sequence = 0
  const ready = new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('Launch timed out')), 15000)
    child.on('message', message => {
      if (message.ready) { clearTimeout(timeout); done(message.versions) }
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id); pending.delete(message.id)
        clearTimeout(request.timeout)
        if (message.error) request.reject(new Error(message.error)); else request.done(message.value)
      }
    })
    child.once('error', reject)
    child.once('exit', code => { clearTimeout(timeout); if (secondary) done({ exitCode: code }); else reject(new Error(`Early exit: ${code}`)) })
  })
  const versions = await ready
  if (secondary) return versions
  const call = (action, source, timeoutMs = 12000) => new Promise((done, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Probe timed out: ${action}`)) }, timeoutMs)
    pending.set(id, {done,reject,timeout}); child.send({id,action,source})
  })
  const evaluate = source => call('evaluate', source)
  const wait = async source => { const until = Date.now()+12000; while (!await evaluate(source)) { assert.ok(Date.now()<until,source); await delay(30) } }
  await wait(`Boolean(document.querySelector('button[aria-label="添加分组"]'))`)
  return {call,evaluate,wait,versions,child}
}
const group = async (page, name) => {
  await page.evaluate(`document.querySelector('button[aria-label="添加分组"]').click()`)
  await page.wait(`Boolean(document.querySelector('[role="dialog"] form'))`)
  await page.evaluate(`(() => {const f=document.querySelector('[role="dialog"] form');f.elements.name.value=${JSON.stringify(name)};f.requestSubmit()})()`)
  await page.wait(`!document.querySelector('[role="dialog"]')`)
}
const editPassword = async page => {
  await page.evaluate(`(() => {const e=document.querySelector('[data-asset-row="review-0"]');const r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.x+10,clientY:r.y+10}))})()`)
  await page.wait(`Boolean(document.querySelector('[role="menu"]'))`)
  await page.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.trim()==='编辑').click()`)
  await page.wait(`Boolean(document.querySelector('select[name="authMethod"]'))`)
  await page.evaluate(`(() => {const e=document.querySelector('select[name="authMethod"]');e.value='password';e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await page.wait(`Boolean(document.querySelector('input[name="password"]'))`)
  await page.evaluate(`(() => {const f=document.querySelector('[role="dialog"] form');f.elements.password.value='synthetic-replacement';f.requestSubmit()})()`)
}
try {
  const a = await launch(join(temporary,'shared'))
  await group(a,'Review A')
  await a.evaluate(`window.novaSettings.save({...window.novaSettings.initial.values,fontSize:19})`)
  await a.call('minimize')
  const b = await launch(join(temporary,'shared'), true)
  assert.equal(b.exitCode, 0)
  const state = await a.call('state')
  assert.deepEqual(state, { secondInstances: 1, windows: 1, minimized: false, visible: true })
  const settings = JSON.parse(await readFile(join(temporary,'shared','settings',dev?'development.json':'desktop.json'),'utf8'))
  assert.equal(settings.values.fontSize, 19)
  results.push({probe:'single-instance',electron:a.versions.electron,...state})
  a.child.send({type:'app:quit'})
  await new Promise(done => a.child.once('exit', done))
  const restored = await launch(join(temporary,'shared'))
  assert.deepEqual(await restored.evaluate(`JSON.parse(localStorage.getItem('novaterminal.assets.v1')).assets.map(a=>a.name)`), ['Review A'])
  assert.equal(await restored.evaluate(`window.novaSettings.initial.values.fontSize`), 19)
  results.push({probe:'two-instances-restart',assets:await restored.evaluate(`JSON.parse(localStorage.getItem('novaterminal.assets.v1')).assets.map(a=>a.name)`),fontSize:await restored.evaluate(`window.novaSettings.initial.values.fontSize`)})
  restored.child.send({type:'app:quit'})
  await new Promise(done => restored.child.once('exit', done))
  const p = await launch(join(temporary,'single'))
  assert.equal(await p.call('seed'),500)
  await p.call('reload')
  await p.wait(`Boolean(document.querySelector('[data-asset-row="review-0"]'))`)
  await p.call('interrupt')
  await editPassword(p)
  await delay(500)
  assert.equal(await p.call('count'),501)
  await p.call('reload')
  await p.wait(`Boolean(document.querySelector('[data-asset-row="review-0"]'))`)
  assert.equal(await p.call('count'), 500)
  assert.equal(await p.call('verify-credential', 'synthetic-review-only'), true)
  await editPassword(p)
  await p.wait(`!document.querySelector('[role="dialog"]')`)
  assert.equal(await p.call('count'), 500)
  assert.notEqual(await p.evaluate(`JSON.parse(localStorage.getItem('novaterminal.assets.v1')).assets[0].credentialId`), undefined)
  results.push({probe:'interrupted-credential-revision',records:await p.call('count'),assets:await p.evaluate(`JSON.parse(localStorage.getItem('novaterminal.assets.v1')).assets.length`)})
  const priorReference = await p.evaluate(`JSON.parse(localStorage.getItem('novaterminal.assets.v1')).assets[0].credentialId`)
  await p.call('interrupt-remove')
  await editPassword(p)
  await delay(500)
  assert.equal(await p.call('count'), 501)
  await p.call('reload')
  await p.wait(`Boolean(document.querySelector('[data-asset-row="review-0"]'))`)
  assert.equal(await p.call('count'), 500)
  assert.notEqual(await p.evaluate(`JSON.parse(localStorage.getItem('novaterminal.assets.v1')).assets[0].credentialId`), priorReference)
  assert.equal(await p.call('verify-credential', 'synthetic-replacement'), true)
  const committedDocument = await p.evaluate(`localStorage.getItem('novaterminal.assets.v1')`)
  await p.evaluate(`localStorage.setItem('novaterminal.assets.v1','{broken')`)
  await p.call('reload')
  await p.wait(`document.body.textContent.includes('无法读取本机资产配置')`)
  assert.equal(await p.call('count'), 500, 'Unreadable asset documents must never trigger credential deletion')
  await p.evaluate(`localStorage.setItem('novaterminal.assets.v1',${JSON.stringify(committedDocument)})`)
  await p.call('reload')
  await p.wait(`Boolean(document.querySelector('[data-asset-row="review-0"]'))`)
  results.push({probe:'committed-revision-and-corrupt-document',records:await p.call('count'),preserved:true})
  await p.evaluate(`window.__events=[];window.__out='';window.novaTerminal.onEvent(e=>{window.__events.push(e);if(e.message?.type==='output')window.__out+=e.message.data});document.querySelector('button[aria-label="新建本地终端"]').click()`)
  await p.wait(`window.__events.some(e=>e.message?.type==='ready')`)
  const command = process.platform === 'win32' ? "Write-Output ('a'*40+'!')\r" : `printf '%s\\n' '${'a'.repeat(40)}!'\r`
  await p.evaluate(`window.__id=window.__events.find(e=>e.message?.type==='ready').id;window.novaTerminal.send(window.__id,{type:'input',data:${JSON.stringify(command)}})`)
  await p.wait(`window.__out.includes('a'.repeat(40)+'!')`)
  await p.evaluate(`document.querySelector('[role="tabpanel"][data-state="active"] .xterm-screen').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:500,clientY:200}))`)
  await p.wait(`Boolean(document.querySelector('[role="menu"]'))`)
  await p.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.trim()==='搜索').click()`)
  await p.wait(`Boolean(document.querySelector('input[aria-label="终端搜索"]'))`)
  await p.evaluate(`document.querySelector('button[aria-label="正则"]').click()`)
  await p.evaluate(`setTimeout(()=>{const e=document.querySelector('input[aria-label="终端搜索"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'(a+)+$');e.dispatchEvent(new Event('input',{bubbles:true}))},10);true`)
  await p.wait(`document.querySelector('[role="search"]').textContent.includes('正则搜索超时')`)
  assert.equal(await p.call('evaluate','1+1',2000),2)
  await p.evaluate(`(() => {const e=document.querySelector('input[aria-label="终端搜索"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'a{40}!');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await p.wait(`document.querySelector('[role="search"]').textContent.includes('已选中匹配项')`)
  results.push({probe:'regex-timeout-and-recovery',pattern:'(a+)+$',output:'a x 40 plus !',rendererResponsive:true})
  const clipboardBefore = await p.evaluate('window.novaClipboard.read()')
  try {
    const columns = await p.evaluate(`Number(document.querySelector('[role="tabpanel"][data-state="active"] footer [aria-label$=" 行"]').getAttribute('aria-label').match(/^(\\d+)/)[1])`)
    const expected = 'w'.repeat(columns - 1) + '中😀e\u0301_WRAP_END'
    const unicodeCommand = process.platform === 'win32' ? `Write-Output ('w'*${columns-1}+[char]0x4e2d+[char]::ConvertFromUtf32(0x1f600)+'e'+[char]0x301+'_WRAP_END')\r` : `printf '%s\\n' '${expected}'\r`
    await p.evaluate(`window.novaTerminal.send(window.__id,{type:'input',data:${JSON.stringify(unicodeCommand)}})`)
    await p.wait(`window.__out.includes(${JSON.stringify(expected)})`)
    for (const [query, selected] of [[`w{${columns-1}}中😀e\u0301_WRAP_END`, expected], ['中😀', '中😀'], ['\u0301', 'e\u0301']]) {
      await p.evaluate(`(() => {const e=document.querySelector('input[aria-label="终端搜索"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(query)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
      await delay(250)
      await p.wait(`document.querySelector('[role="search"]').textContent.includes('已选中匹配项')`)
      await p.evaluate(`window.novaClipboard.write('NOVA_SELECTION_SENTINEL')`)
      await p.evaluate(`document.querySelector('[role="tabpanel"][data-state="active"] .xterm-screen').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:500,clientY:200}))`)
      await p.wait(`Boolean(document.querySelector('[role="menu"]'))`)
      await p.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.trim()==='复制').click()`)
      await p.wait(`window.novaClipboard.read().then(text=>text!=='NOVA_SELECTION_SENTINEL')`)
      assert.equal(await p.evaluate('window.novaClipboard.read()'), selected)
    }
    results.push({probe:'regex-selection',softWrap:true,wideCharacter:true,emoji:true,combiningMark:true})
  } finally { await p.evaluate(`window.novaClipboard.write(${JSON.stringify(clipboardBefore)})`) }
  await p.evaluate(`window.novaSettings.save({...window.novaSettings.initial.values,confirmExit:false})`)
  process.stdout.write(JSON.stringify(results,null,2)+'\n')
} finally {
  for (const child of children) {
    if (child.exitCode===null && child.signalCode===null) {
      if (child.connected) child.send({type:'app:quit'})
      else child.kill()
      await Promise.race([new Promise(done=>child.once('exit',done)),delay(6000)])
      if(child.exitCode===null && child.signalCode===null){child.kill();await new Promise(done=>child.once('exit',done))}
    }
  }
  assert.equal(dirname(resolve(temporary)),resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('novaterminal-recovery-'))
  await rm(temporary,{recursive:true,force:true,maxRetries:4,retryDelay:150})
  await server?.close()
}
