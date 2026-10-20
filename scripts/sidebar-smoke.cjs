const { app } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { once } = require('node:events')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const timeout = setTimeout(() => { console.error('Sidebar smoke timed out'); app.exit(1) }, 90_000)
app.once('quit', () => clearTimeout(timeout))
app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    const page = window.webContents
    const evaluate = (source) => page.executeJavaScript(source)
    const wait = async (source) => {
      const deadline = Date.now() + 8_000
      while (!(await evaluate(source))) { if (Date.now() >= deadline) throw new Error(`Timed out: ${source}`); await delay(30) }
    }
    const row = (id) => `[data-asset-row="${id}"]`
    const group = (id) => `${row(id)} button`
    const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    const stored = (source) => evaluate(`(() => { const data = JSON.parse(localStorage.getItem('novaterminal.assets.v1')); return ${source}; })()`)
    const rect = (selector, fraction = 0.5) => evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({block:'nearest'});
      const r = element.getBoundingClientRect(); return {x:r.left + r.width * ${fraction}, y:r.top + r.height/2};
    })()`)
    const menu = async (id) => {
      window.focus()
      const point = await rect(row(id))
      page.sendInputEvent({type:'mouseDown', ...point, button:'right', clickCount:1})
      page.sendInputEvent({type:'mouseUp', ...point, button:'right', clickCount:1})
      await wait('Boolean(document.querySelector(\'[role="menu"]\'))')
    }
    const choose = async (label) => {
      await evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(item => item.textContent.trim() === ${JSON.stringify(label)}).click()`)
      await wait('!document.querySelector(\'[role="menu"]\')')
    }
    const fill = (fields) => evaluate(`(() => {
      const form = document.querySelector('[role="dialog"] form');
      for (const [key,value] of Object.entries(${JSON.stringify(fields)})) form.elements[key].value = value;
      form.requestSubmit();
    })()`)
    let intercepted
    try {
      await wait('Boolean(document.querySelector(\'button[aria-label="添加连接"]\'))')
      const assets = [
        {kind:'group',id:'prod',name:'生产',parentId:null},
        {kind:'group',id:'branch',name:'子分组',parentId:'prod'},
        {kind:'connection',id:'conn',name:'分组连接',parentId:'branch',host:'example.invalid',port:22,username:'test'},
        {kind:'group',id:'spare',name:'备用',parentId:null},
        ...Array.from({length:8}, (_,i) => ({kind:'group',id:`filler${i}`,name:`分组 ${i}`,parentId:null})),
        {kind:'connection',id:'outside',name:'根连接',parentId:null,host:'example.invalid',port:22,username:'test'},
      ]
      await evaluate(`localStorage.setItem('novaterminal.assets.v1', ${JSON.stringify(JSON.stringify({version:1, assets}))})`)
      let loaded = once(page, 'did-finish-load'); page.reload(); await loaded
      await wait('Boolean(document.querySelector(\'[data-asset-row="prod"]\'))')
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(group('prod'))}).getAttribute('aria-expanded')`), 'false')
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(group('spare'))}).getAttribute('aria-expanded')`), 'false')
      await click(group('prod')); await click(group('branch'))
      await click('button[aria-label="添加分组"]')
      await wait('Boolean(document.querySelector(\'[role="dialog"] form\'))')
      assert.equal(await evaluate('document.querySelector(\'[role="dialog"] select\').value'), 'branch')
      await fill({name:'当前子组'})
      await wait('!document.querySelector(\'[role="dialog"]\')')
      assert.equal(await stored('data.sidebar.expandedIds.includes(data.assets.find(a => a.name === "当前子组").id)'), true)
      await click('button[aria-label="资产根目录"]')
      await click('button[aria-label="添加分组"]')
      await wait('Boolean(document.querySelector(\'[role="dialog"] form\'))')
      await fill({name:'其他层级新增', parentId:'spare'})
      await wait('!document.querySelector(\'[role="dialog"]\')')
      assert.equal(await stored('data.sidebar.expandedIds.includes("spare")'), false)
      assert.equal(await stored('data.sidebar.expandedIds.includes(data.assets.find(a => a.name === "其他层级新增").id)'), false)
      await evaluate(`(() => { const input = document.querySelector('input[type="search"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'其他层级'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
      await wait('document.querySelector(\'[data-asset-row="spare"] button\').getAttribute("aria-expanded") === "true"')
      await click('button[aria-label="清除搜索"]')
      await wait('document.querySelector(\'[data-asset-row="spare"] button\').getAttribute("aria-expanded") === "false"')
      page.debugger.attach('1.3')
      page.debugger.on('message', (_event, method, params) => { if (method === 'Input.dragIntercepted') intercepted = params.data })
      const command = (method, params) => page.debugger.sendCommand(method, params)
      await command('Input.setInterceptDrags', {enabled:true})
      const drag = async (source, target, fraction = 0.5) => {
        window.focus(); intercepted = null
        const from = await rect(source)
        const to = await rect(target, fraction)
        await command('Input.dispatchMouseEvent', {type:'mouseMoved', ...from})
        await command('Input.dispatchMouseEvent', {type:'mousePressed', ...from, button:'left', buttons:1, clickCount:1})
        await command('Input.dispatchMouseEvent', {type:'mouseMoved', x:from.x + 8, y:from.y + 8, button:'left', buttons:1})
        await command('Input.dispatchMouseEvent', {type:'mouseMoved', ...to, button:'left', buttons:1})
        const deadline = Date.now() + 3_000
        while (!intercepted) { if (Date.now() >= deadline) throw new Error('Real mouse input did not start a drag'); await delay(20) }
        for (const type of ['dragEnter','dragOver','drop']) {
          await command('Input.dispatchDragEvent', {type, ...to, data:intercepted})
          await delay(50)
        }
        await command('Input.dispatchMouseEvent', {type:'mouseReleased', ...to, button:'left', buttons:0, clickCount:1})
      }
      await drag(row('outside'), row('spare'))
      assert.equal(await stored('data.assets.find(a => a.id === "outside").parentId'), 'spare')
      assert.equal(await stored('data.sidebar.expandedIds.includes("spare")'), false)
      await drag(row('prod'), row('branch'))
      assert.equal(await stored('data.assets.find(a => a.id === "prod").parentId'), null)
      await drag(row('branch'), row('spare'))
      assert.equal(await stored('data.assets.find(a => a.id === "branch").parentId'), 'spare')
      assert.equal(await stored('data.assets.find(a => a.id === "conn").parentId'), 'branch')
      await click(group('spare'))
      await drag(row('outside'), 'button[aria-label="资产根目录"]')
      assert.equal(await stored('data.assets.find(a => a.id === "outside").parentId'), null)
      const saved = await stored('data.sidebar')
      loaded = once(page, 'did-finish-load'); page.reload(); await loaded
      await wait('Boolean(document.querySelector(\'[data-asset-row="spare"]\'))')
      assert.deepEqual(await stored('data.sidebar'), saved)
      assert.equal(await evaluate('document.querySelector(\'[data-asset-row="branch"]\').closest("[data-asset-id]").parentElement.closest("[data-asset-id]").dataset.assetId'), 'spare')
      window.setSize(720,480)
      await delay(150)
      await menu('filler7')
      await delay(150)
      const bounds = await evaluate('(() => { const r=document.querySelector(\'[role="menu"]\').getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}; })()')
      assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height)
      await fs.mkdir(path.join(__dirname,'../test-results'),{recursive:true})
      await fs.writeFile(path.join(__dirname,'../test-results/sidebar-context-menu.png'),(await page.capturePage()).toPNG())
      await choose('重命名')
      await wait('Boolean(document.querySelector(\'[role="dialog"] form\'))')
      await fill({value:'已重命名'})
      await wait('!document.querySelector(\'[role="dialog"]\')')
      assert.equal(await stored('data.assets.find(a => a.id === "filler7").name'), '已重命名')
      await menu('spare'); await choose('移动到…')
      await wait('Boolean(document.querySelector(\'[role="dialog"] select\'))')
      assert.equal(await evaluate('Boolean(document.querySelector(\'[role="dialog"] option[value="branch"]\'))'), false)
      await click('[role="dialog"] button[type="button"]')
      await wait('!document.querySelector(\'[role="dialog"]\')')
      await evaluate('document.querySelector(\'[data-asset-row="filler7"] button\').focus()')
      page.sendInputEvent({type:'keyDown',keyCode:'F10',modifiers:['shift']})
      page.sendInputEvent({type:'keyUp',keyCode:'F10',modifiers:['shift']})
      await wait('Boolean(document.querySelector(\'[role="menu"]\'))')
      await choose('删除')
      await wait('Boolean(document.querySelector(\'[role="alertdialog"]\'))')
      const beforeDelete = await stored('data')
      await evaluate('window.__originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error("test quota"); }; void 0')
      await click('[data-slot="alert-dialog-action"]')
      await wait('document.querySelector(\'[role="alertdialog"]\').textContent.includes("保存失败")')
      assert.deepEqual(await stored('data'), beforeDelete)
      await evaluate('Storage.prototype.setItem = window.__originalSetItem; void 0')
      await click('[data-slot="alert-dialog-cancel"]')
      await wait('!document.querySelector(\'[role="alertdialog"]\')')
      await menu('spare'); await choose('删除')
      await wait('Boolean(document.querySelector(\'[role="alertdialog"]\'))')
      await click('[data-slot="alert-dialog-action"]')
      await wait('!document.querySelector(\'[role="alertdialog"]\')')
      assert.equal(await stored('data.assets.some(a => ["spare","branch","conn"].includes(a.id))'), false)
      assert.equal(await stored('data.assets.some(a => a.id === "outside")'), true)
      await click('[data-asset-row="outside"] button')
      await wait('Boolean(document.querySelector(\'[role="dialog"] input[name="password"]\'))')
      await evaluate(`document.querySelector('[role="dialog"] input[name="password"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:200}))`)
      assert.equal(await evaluate('Boolean(document.querySelector(\'[role="menu"]\'))'), false)
      await click('[role="dialog"] button[type="button"]')
      await wait('!document.querySelector(\'[role="dialog"]\')')
      window.setSize(1200,800); await delay(100)
      await evaluate('window.__ui = {events:[],output:""}; window.novaTerminal.onEvent(event => { window.__ui.events.push(event); if(event.message?.type === "output") window.__ui.output += event.message.data; }); void 0')
      await click('button[aria-label="新建本地终端"]'); await click('button[aria-label="新建本地终端"]')
      await wait('window.__ui.events.filter(e => e.message?.type === "ready").length === 2')
      await evaluate('window.__ui.closedBefore = window.__ui.events.filter(e => e.closed).length')
      const shellCommand = process.platform === 'win32' ? "$novaMoveValue='NOVA_SESSION_SAVED'; Write-Output $novaMoveValue\r" : "nova_move_value='NOVA_SESSION_SAVED'; echo $nova_move_value\r"
      await evaluate(`window.novaTerminal.send(window.__ui.events.filter(e => e.message?.type === 'ready')[1].id,{type:'input',data:${JSON.stringify(shellCommand)}})`)
      await wait('window.__ui.output.split("NOVA_SESSION_SAVED").length >= 3')
      await evaluate('window.__ui.outputCount = window.__ui.output.split("NOVA_SESSION_SAVED").length')
      await evaluate('window.__firstTerminal = document.querySelector(\'[data-state="inactive"][role="tabpanel"] .xterm\'); void 0')
      await drag('[data-session-tab="local-1"]','[data-session-tab="local-2"]',0.9)
      assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("[data-session-tab]")).map(e => e.dataset.sessionTab)'), ['local-2','local-1'])
      assert.equal(await evaluate('document.querySelector(\'[role="tab"][data-state="active"]\').textContent.trim()'), '本地终端 2')
      assert.equal(await evaluate('document.querySelector(\'[data-state="inactive"][role="tabpanel"] .xterm\') === window.__firstTerminal'), true)
      assert.equal(await evaluate('window.__ui.events.filter(e => e.closed).length === window.__ui.closedBefore'), true)
      assert.equal(await evaluate('window.__ui.events.filter(e => e.message?.type === "ready").length'), 2)
      await evaluate(`window.novaTerminal.send(window.__ui.events.filter(e => e.message?.type === 'ready')[1].id,{type:'input',data:${JSON.stringify(process.platform === 'win32' ? 'Write-Output $novaMoveValue\r' : 'echo $nova_move_value\r')}})`)
      await wait('window.__ui.output.split("NOVA_SESSION_SAVED").length > window.__ui.outputCount')
      await wait('document.querySelector(\'[role="tabpanel"][data-state="active"] .xterm-rows\').textContent.includes("NOVA_SESSION_SAVED")')
      await fs.writeFile(path.join(__dirname,'../test-results/sidebar-tabs.png'),(await page.capturePage()).toPNG())
      await evaluate('document.querySelector(\'[data-session-tab="local-2"] [role="tab"]\').focus()')
      page.sendInputEvent({type:'keyDown',keyCode:'Right',modifiers:['control','shift']})
      page.sendInputEvent({type:'keyUp',keyCode:'Right',modifiers:['control','shift']})
      await wait('document.querySelector("[data-session-tab]").dataset.sessionTab === "local-1"')
      assert.equal(await evaluate('window.__ui.events.filter(e => e.closed).length === window.__ui.closedBefore'), true)
      await click('button[aria-label="关闭本地终端 2"]')
      await wait('document.querySelectorAll("[data-session-tab]").length === 1')
      assert.equal(await evaluate('document.querySelector(\'[role="tab"][data-state="active"]\').textContent.trim()'), '本地终端 1')
      page.debugger.detach()
      console.log('Desktop smoke passed: sidebar expansion, create scope, search, real drag hierarchy, persisted state, menu placement, rename, move, delete, quota failure and live tab reorder.')
      const closed = once(window,'closed'); window.close(); await closed
      if (process.platform === 'darwin') app.quit()
    } catch (error) {
      console.error(error)
      process.exitCode=1
      if (page.debugger.isAttached()) page.debugger.detach()
      await fs.mkdir(path.join(__dirname,'../test-results'),{recursive:true})
      await fs.writeFile(path.join(__dirname,'../test-results/sidebar-failure.png'),(await page.capturePage()).toPNG())
      app.quit()
    }
  })
})
if (process.env.NOVA_TEST_PROFILE) app.setPath('userData',process.env.NOVA_TEST_PROFILE)
require(process.argv[2] || '../out/electron/main.cjs')
