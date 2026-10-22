const { app, clipboard, dialog, nativeTheme, shell } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { once } = require('node:events')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const deadline = setTimeout(() => { console.error('P0 smoke timed out'); app.exit(1) }, 120_000)
app.once('quit', () => clearTimeout(deadline))
app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    const page = window.webContents
    const evaluate = (source) => page.executeJavaScript(source).catch(error => { console.error('P0 failed evaluation:', source); throw error })
    const wait = async (source) => {
      const until = Date.now() + 12_000
      while (!(await evaluate(source))) { if (Date.now() >= until) throw new Error(`Timed out: ${source}`); await delay(30) }
    }
    const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    const setInput = (selector, value) => evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event('input', {bubbles:true}));
    })()`)
    const key = async (keyCode, modifiers = []) => {
      window.focus(); page.sendInputEvent({type:'keyDown', keyCode, modifiers}); page.sendInputEvent({type:'keyUp', keyCode, modifiers}); await delay(80)
    }
    const pointer = async (selector, button = 'left', clickCount = 1) => {
      window.focus()
      const point = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`)
      page.sendInputEvent({type:'mouseDown',...point,button,clickCount}); page.sendInputEvent({type:'mouseUp',...point,button,clickCount}); await delay(80)
    }
    const activeTextarea = '[role="tabpanel"][data-state="active"] .xterm-helper-textarea'
    const focusTerminal = () => evaluate(`document.querySelector(${JSON.stringify(activeTextarea)}).focus()`)
    const chooseMenu = async (name) => {
      await wait('Boolean(document.querySelector(\'[role="menu"]\'))')
      await evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.trim()===${JSON.stringify(name)}).click()`)
      await wait('!document.querySelector(\'[role="menu"]\')')
    }
    const originalOpen = dialog.showOpenDialog, originalSave = dialog.showSaveDialog, originalExternal = shell.openExternal
    try {
      while (!window.isVisible()) await delay(20)
      assert.equal(window.isMinimized(), false)
      await wait('Boolean(document.querySelector(\'button[aria-label="设置"]\'))')
      await evaluate('window.__p0={events:[],output:""}; window.novaTerminal.onEvent(e=>{window.__p0.events.push(e);if(e.message?.type==="output")window.__p0.output+=e.message.data}); window.__prefs=window.novaSettings.initial.values')
      nativeTheme.themeSource = 'dark'
      await wait('document.documentElement.classList.contains("dark")')
      nativeTheme.themeSource = 'light'
      await wait('!document.documentElement.classList.contains("dark")')
      await wait('Boolean(document.querySelector(\'button[aria-label="新建本地终端"]\'))')
      await click('button[aria-label="新建本地终端"]')
      await wait('window.__p0.events.some(e=>e.message?.type==="ready")')
      await evaluate('window.__p0.id=window.__p0.events.find(e=>e.message?.type==="ready").id; window.__p0.terminal=document.querySelector(".xterm")')
      await click('button[aria-label="设置"]')
      await wait('Boolean(document.querySelector("#setting-fontSize"))')
      await setInput('#setting-fontSize', '18')
      await evaluate('Array.from(document.querySelectorAll(\'[role="dialog"] button\')).find(b=>b.textContent==="取消").click()')
      assert.equal(await evaluate('window.novaSettings.initial.values.fontSize'), 14)
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".xterm-rows")).fontSize'), '14px')
      await click('button[aria-label="设置"]')
      await wait('Boolean(document.querySelector("#setting-fontSize"))')
      await setInput('#setting-fontSize', '18')
      await setInput('#setting-maxSessions', '2')
      window.setSize(720, 480); await delay(250)
      assert.ok(await evaluate(`(() => {const d=document.querySelector('[role="dialog"]').getBoundingClientRect();const b=document.querySelector('[role="dialog"] button[type="submit"]').getBoundingClientRect();return d.top>=0 && d.bottom<=innerHeight && b.bottom<=d.bottom;})()`))
      await fs.mkdir(path.join(__dirname, '../test-results'), {recursive:true})
      await fs.writeFile(path.join(__dirname, '../test-results/p0-settings-small.png'), (await page.capturePage()).toPNG())
      await click('[role="dialog"] button[type="submit"]')
      await wait('!document.querySelector(\'[role="dialog"]\')')
      await wait('getComputedStyle(document.querySelector(".xterm-rows")).fontSize==="18px"')
      assert.equal(await evaluate('window.__p0.terminal===document.querySelector(".xterm")'), true)
      assert.equal(await evaluate('window.__p0.events.filter(e=>e.message?.type==="ready").length'), 1)
      const settingsFile = path.join(app.getPath('userData'), 'settings', process.env.NOVA_DEV_SERVER ? 'development.json' : 'desktop.json')
      assert.equal(JSON.parse(await fs.readFile(settingsFile,'utf8')).values.fontSize,18)
      await focusTerminal(); await key('T', ['control','shift'])
      await wait('window.__p0.events.filter(e=>e.message?.type==="ready").length===2')
      await focusTerminal(); await key('T', ['control','shift'])
      assert.equal(await evaluate('document.querySelectorAll("[data-session-tab]").length'),2)
      await focusTerminal(); await key('1',['control'])
      await wait('document.querySelector(\'[role="tab"][data-state="active"]\').textContent.includes("本地终端 1")')
      const command = process.platform === 'win32' ? "Write-Output ('NOVA_' + 'P0_SEARCH')\r" : "printf 'NOVA_%s\\n' P0_SEARCH\r"
      await evaluate(`window.novaTerminal.send(window.__p0.id,{type:'input',data:${JSON.stringify(command)}})`)
      await wait('window.__p0.output.includes("NOVA_P0_SEARCH")')
      await focusTerminal(); await key('F',['control'])
      await wait('Boolean(document.querySelector(\'input[aria-label="终端搜索"]\'))')
      await setInput('input[aria-label="终端搜索"]','NOVA_P0_SEARCH')
      await wait('document.querySelector(\'[role="search"]\').textContent.includes("已选中匹配项")')
      await setInput('input[aria-label="终端搜索"]','')
      await wait('!document.querySelector(".xterm-selection")?.children.length')
      await setInput('input[aria-label="终端搜索"]','NOVA_P0_SEARCH')
      await wait('document.querySelector(\'[role="search"]\').textContent.includes("已选中匹配项")')
      await click('[role="search"] button[aria-label="正则"]')
      await setInput('input[aria-label="终端搜索"]','[')
      await wait('document.querySelector(\'[role="search"]\').textContent.includes("正则表达式无效")')
      await evaluate('document.querySelector(\'input[aria-label="终端搜索"]\').focus()'); await key('Escape')
      await wait('!document.querySelector(\'[role="search"]\')')
      assert.equal(await evaluate('document.activeElement.classList.contains("xterm-helper-textarea")'),true)
      await pointer('[role="tabpanel"][data-state="active"] .xterm-screen','right')
      await chooseMenu('全选')
      await focusTerminal(); await key('C',['control'])
      const until = Date.now()+3000
      while (!(await clipboard.readText()).includes('NOVA_P0_SEARCH')) { assert.ok(Date.now()<until,'Copy must use xterm selection'); await delay(30) }
      await clipboard.writeText('x'.repeat(65_537)); await focusTerminal(); await key('V',['control','shift'])
      await wait('document.body.textContent.includes("粘贴超过 64 KiB")')
      assert.equal(await evaluate('document.querySelectorAll("[data-session-tab]").length'),2)
      await evaluate('window.novaSettings.save({...window.__prefs,fontSize:18,maxSessions:2,confirmMultiline:true})')
      await clipboard.writeText('NO_SEND_ONE\nNO_SEND_TWO')
      await focusTerminal(); await key('V',['control','shift'])
      await wait('document.querySelector(\'[role="alertdialog"]\')?.textContent.includes("确认多行粘贴")')
      assert.equal(await evaluate('document.querySelector(\'[role="alertdialog"]\').textContent.includes("NO_SEND")'),false)
      await click('[data-slot="alert-dialog-cancel"]')
      await delay(100)
      assert.equal(await evaluate('window.__p0.output.includes("NO_SEND_ONE")'),false)
      // Real shell exit followed by explicit reconnect must keep the tab and clear its terminal.
      await evaluate('window.novaTerminal.send(window.__p0.id,{type:"input",data:"exit\\r"})')
      await wait('document.querySelector(\'[role="tabpanel"][data-state="active"]\').textContent.includes("重新连接")')
      await delay(300)
      await evaluate('Array.from(document.querySelectorAll(\'[role="tabpanel"][data-state="active"] button\')).find(b=>b.textContent==="重新连接").click()')
      await wait('window.__p0.events.filter(e=>e.message?.type==="ready").length===3')
      assert.equal(await evaluate('document.querySelectorAll("[data-session-tab]").length'),2)
      assert.equal(await evaluate('document.querySelector(\'[role="tabpanel"][data-state="active"] .xterm-rows\').textContent.includes("NOVA_P0_SEARCH")'),false)
      // Exercise external-link validation without launching a browser from the test.
      const opened=[]; shell.openExternal=async url=>{opened.push(url)}
      await evaluate('window.novaLinks.open("https://example.invalid/test")')
      assert.deepEqual(opened,['https://example.invalid/test'])
      for (const url of ['file:///test','javascript:alert(1)','https://user:secret@example.invalid']) {
        assert.equal(await evaluate(`window.novaLinks.open(${JSON.stringify(url)}).then(()=>false,()=>true)`),true)
      }
      assert.equal(opened.length,1)
      const transferFile=path.join(app.getPath('userData'),'connections.json')
      const document={format:'novaterminal.connections',version:1,exportedAt:new Date().toISOString(),groups:[{kind:'group',id:'g',name:'导入分组',parentId:null}],connections:[{kind:'connection',id:'c',name:'导入 SSH',parentId:'g',host:'example.invalid',port:22,username:'user',credentialId:'discard-me',password:'discard-secret'}]}
      await fs.writeFile(transferFile,JSON.stringify(document))
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[transferFile]})
      await click('button[aria-label="导入连接配置"]')
      await wait('document.querySelector(\'[role="dialog"]\')?.textContent.includes("生成 2 个新标识")')
      await evaluate('window.__originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=()=>{throw new Error("quota")};void 0')
      await evaluate('Array.from(document.querySelectorAll(\'[role="dialog"] button\')).find(b=>b.textContent==="确认导入").click()')
      await wait('document.querySelector(\'[role="dialog"]\').textContent.includes("保存失败")')
      assert.equal(await evaluate('localStorage.getItem("novaterminal.assets.v1")'),null)
      await evaluate('Storage.prototype.setItem=window.__originalSetItem; Array.from(document.querySelectorAll(\'[role="dialog"] button\')).find(b=>b.textContent==="确认导入").click()')
      await wait('!document.querySelector(\'[role="dialog"]\')')
      const saved=JSON.parse(await evaluate('localStorage.getItem("novaterminal.assets.v1")'))
      assert.ok(saved.assets.every(a=>!['c','g'].includes(a.id)))
      assert.equal(saved.assets.find(a=>a.kind==='connection').needsAuthentication,true)
      assert.ok(!JSON.stringify(saved).includes('discard-'))
      const exportedFile=path.join(app.getPath('userData'),'exported.json')
      dialog.showSaveDialog=async()=>({canceled:false,filePath:exportedFile})
      await click('button[aria-label="导出连接配置"]')
      await wait('document.body.textContent.includes("连接配置已导出")')
      const exported=await fs.readFile(exportedFile,'utf8')
      assert.ok(!exported.includes('credentialId') && !exported.includes('needsAuthentication') && !exported.includes('password'))
      await fs.writeFile(transferFile,'{broken')
      const before=await evaluate('localStorage.getItem("novaterminal.assets.v1")')
      await click('button[aria-label="导入连接配置"]')
      await wait('document.body.textContent.includes("有效的 JSON")')
      assert.equal(await evaluate('localStorage.getItem("novaterminal.assets.v1")'),before)
      // At minimum width, new and explicitly selected tabs must be wholly visible.
      await evaluate('window.novaSettings.save({...window.__prefs,fontSize:18,maxSessions:4})')
      for (let count=3;count<=4;count++) {
        await focusTerminal(); await key('T',['control','shift'])
        await wait(`document.querySelectorAll('[data-session-tab]').length===${count}`)
      }
      await wait('window.__p0.events.filter(e=>e.message?.type==="ready").length===5')
      const activeVisible = `(() => {const a=document.querySelector('[role="tab"][data-state="active"]').getBoundingClientRect();const s=document.querySelector('.terminal-tabs-scroll').getBoundingClientRect();return a.left>=s.left && a.right<=s.right;})()`
      await wait(activeVisible)
      await focusTerminal(); await key('1',['control']); await wait(activeVisible)
      await evaluate('window.novaSettings.save({...window.__prefs,fontSize:18,maxSessions:1})')
      assert.equal(await evaluate('document.querySelectorAll("[data-session-tab]").length'),4)
      await focusTerminal(); await key('T',['control','shift'])
      assert.equal(await evaluate('document.querySelectorAll("[data-session-tab]").length'),4)
      window.setSize(1000,700)
      await fs.writeFile(path.join(__dirname,'../test-results/p0-workspace.png'),(await page.capturePage()).toPNG())
      window.close(); window.close()
      await wait('document.querySelector(\'[role="alertdialog"]\')?.textContent.includes("退出 NovaTerminal")')
      assert.equal(await evaluate('document.querySelectorAll(\'[role="alertdialog"]\').length'),1)
      await delay(5500)
      assert.equal(window.isDestroyed(),false,'Human confirmation must not time out')
      await click('[data-slot="alert-dialog-cancel"]')
      assert.equal(window.isDestroyed(),false)
      await wait('!document.querySelector(\'[role="alertdialog"]\')')
      const closed=once(window,'closed'); window.close()
      await wait('Boolean(document.querySelector(\'[role="alertdialog"]\'))')
      console.log('Desktop smoke passed: P0 settings persistence, system theme, small layout, live font, limits, shortcuts, search, clipboard, oversized paste, multiline cancel, real PTY reconnect, file import rollback/export, URL IPC and exit cancellation/deduplication.')
      await click('[data-slot="alert-dialog-action"]'); await closed
    } catch(error) {
      console.error(error)
      if(!window.isDestroyed()) console.error(await evaluate(`(() => {const a=document.querySelector('[role="tab"][data-state="active"]');const s=document.querySelector('.terminal-tabs-scroll');return {active:a?.getBoundingClientRect().toJSON(),scroll:s?.getBoundingClientRect().toJSON(),scrollLeft:s?.scrollLeft};})()`))
      if(!window.isDestroyed()) { await fs.mkdir(path.join(__dirname,'../test-results'),{recursive:true}); await fs.writeFile(path.join(__dirname,'../test-results/p0-failure.png'),(await page.capturePage()).toPNG()) }
      app.exit(1)
    } finally { dialog.showOpenDialog=originalOpen;dialog.showSaveDialog=originalSave;shell.openExternal=originalExternal }
  })
})
if(process.env.NOVA_TEST_PROFILE) app.setPath('userData',process.env.NOVA_TEST_PROFILE)
require(process.argv[2] || '../out/electron/main.cjs')
