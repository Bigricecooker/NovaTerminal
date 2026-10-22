const { app, clipboard, shell } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
assert.equal(process.platform, 'win32', 'Extended acceptance currently targets Windows shells')
const delay = ms => new Promise(done => setTimeout(done, ms))
const deadline = setTimeout(() => { console.error('Acceptance timed out'); app.exit(1) }, 120_000)
app.once('quit', () => clearTimeout(deadline))
app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    const page = window.webContents
    const evaluate = source => page.executeJavaScript(source)
    const wait = async source => {
      const end = Date.now() + 10_000
      while (!await evaluate(source)) { assert.ok(Date.now() < end, `Timed out: ${source}`); await delay(30) }
    }
    const textArea = '[role="tabpanel"][data-state="active"] .xterm-helper-textarea'
    const focus = () => evaluate(`document.querySelector(${JSON.stringify(textArea)}).focus()`)
    const key = async (keyCode, modifiers = []) => {
      window.focus(); page.sendInputEvent({type:'keyDown',keyCode,modifiers});page.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(100)
    }
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    const command = async text => { await evaluate(`window.novaTerminal.send(window.__id,{type:'input',data:${JSON.stringify(text+'\r')}})`); await delay(150) }
    const save = values => evaluate(`window.novaSettings.save({...window.novaSettings.initial.values,...${JSON.stringify(values)}})`)
    const open = async () => {
      await evaluate('window.__events=[];window.__output=""')
      await click('button[aria-label="新建本地终端"]')
      await wait('window.__events.some(e=>e.message?.type==="ready" || e.message?.type==="error")')
      await evaluate('window.__id=window.__events.find(e=>e.message?.type==="ready" || e.message?.type==="error").id')
      await delay(350)
    }
    const close = async () => {
      await evaluate('document.querySelector(\'[role="tab"][data-state="active"]\').parentElement.querySelector("button[aria-label^=关闭]").click()')
      await delay(400)
    }
    const menu = async name => {
      const point = await evaluate(`(() => {const r=document.querySelector('[role="tabpanel"][data-state="active"] .xterm-screen').getBoundingClientRect();return {x:Math.round(r.x+20),y:Math.round(r.y+20)}})()`)
      page.sendInputEvent({type:'mouseDown',...point,button:'right',clickCount:1});page.sendInputEvent({type:'mouseUp',...point,button:'right',clickCount:1})
      await wait('Boolean(document.querySelector(\'[role="menu"]\'))')
      await evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.trim()===${JSON.stringify(name)}).click()`)
      await wait('!document.querySelector(\'[role="menu"]\')')
      await delay(180)
    }
    const rowPoint = async text => evaluate(`(() => {
      const rows=Array.from(document.querySelectorAll('[role="tabpanel"][data-state="active"] .xterm-rows>div'));
      const row=rows.find(r=>r.textContent.includes(${JSON.stringify(text)}));if(!row)throw new Error('Missing output row');
      const r=row.getBoundingClientRect();const span=row.querySelector('span');const s=span.getBoundingClientRect();
      return {x:Math.round(r.x+3),y:Math.round(r.y+r.height/2),width:s.width/Math.max(span.textContent.length,1)};
    })()`)
    let originalClipboard, originalWrite = clipboard.writeText, copyWrites = [], server
    const results=[], observations=[]
    const passed = name => { results.push(name); console.log(`Acceptance passed: ${name}`) }
    try {
      await wait('Boolean(document.querySelector(\'button[aria-label="新建本地终端"]\'))')
      await evaluate('window.__events=[];window.__output="";window.novaTerminal.onEvent(e=>{window.__events.push(e);if(e.message?.type==="output")window.__output+=e.message.data});true')
      originalClipboard = await clipboard.readText()
      clipboard.writeText = async text => { copyWrites.push(text); return originalWrite.call(clipboard,text) }
      await save({confirmClose:false,confirmExit:false,copyOnSelect:true})
      await open()
      await command("Write-Output ('DRAG_' + 'COPY_SAMPLE')")
      await wait('window.__output.includes("DRAG_COPY_SAMPLE")')
      await originalWrite.call(clipboard,'UNCHANGED_DURING_DRAG')
      copyWrites=[]
      const point = await rowPoint('DRAG_COPY_SAMPLE')
      page.sendInputEvent({type:'mouseDown',x:point.x,y:point.y,button:'left',clickCount:1})
      page.sendInputEvent({type:'mouseMove',x:Math.round(point.x+4*point.width),y:point.y,modifiers:['leftButtonDown']})
      await delay(250)
      assert.equal(copyWrites.length,0,'Dragging must not repeatedly write clipboard')
      page.sendInputEvent({type:'mouseMove',x:Math.round(point.x+16*point.width),y:point.y,modifiers:['leftButtonDown']})
      page.sendInputEvent({type:'mouseUp',x:Math.round(point.x+16*point.width),y:point.y,button:'left',clickCount:1})
      await delay(300)
      assert.ok((await clipboard.readText()).includes('DRAG_COPY_SAMPLE'))
      assert.equal(copyWrites.length,1)
      passed('Electron mouse drag copies once on release')
      await save({confirmClose:false,confirmExit:false})
      await command("Write-Output ('SLEEP_' + 'START'); Start-Sleep -Seconds 30")
      await wait('window.__output.includes("SLEEP_START")')
      await menu('全选'); copyWrites=[]; await focus();await key('C',['control'])
      assert.equal(copyWrites.length,1,'Selected Ctrl+C must copy')
      await command("Write-Output ('AFTER_' + 'INTERRUPT')")
      assert.equal(await evaluate('window.__output.includes("AFTER_INTERRUPT")'),false,'Selected Ctrl+C must not interrupt running command')
      await menu('清屏');await focus();copyWrites=[];await key('C',['control'])
      assert.equal(copyWrites.length,0,'Clear must remove the selection before unselected Ctrl+C')
      await command("Write-Output ('INTERRUPT_' + 'OK')")
      await wait('window.__output.includes("INTERRUPT_OK")')
      assert.equal(copyWrites.length,0,'Unselected Ctrl+C must reach Shell')
      passed('Ctrl+C selection copies without interrupt; no selection interrupts real running command')
      await originalWrite.call(clipboard,"Write-Output ('PASTE_' + '中文😀')")
      await menu('粘贴');await focus();await key('Enter')
      await wait('window.__output.includes("PASTE_中文😀")')
      passed('context-menu clipboard paste preserves Chinese and emoji')
      await command("Write-Output ('FIND_' + 'Alpha_ONE'); Write-Output ('FIND_' + 'Alpha_TWO')")
      await wait('window.__output.includes("FIND_Alpha_TWO")')
      await focus();await key('F',['control'])
      await wait('Boolean(document.querySelector(\'input[aria-label="终端搜索"]\'))')
      const query=async value=>{
        await evaluate(`(() => {const e=document.querySelector('input[aria-label="终端搜索"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
        await delay(200)
      }
      await query('FIND_Alpha')
      await wait('document.querySelector(\'[role="search"]\').textContent.includes("已选中匹配项")')
      const selectionRect=()=>evaluate('document.querySelector(".xterm-selection div")?.getBoundingClientRect().y')
      const firstMatch=await selectionRect()
      await key('Enter');const nextMatch=await selectionRect()
      assert.notEqual(nextMatch,firstMatch)
      await key('Enter',['shift']);assert.equal(await selectionRect(),firstMatch)
      await key('T',['control','shift']);assert.equal(await evaluate('document.querySelectorAll("[data-session-tab]").length'),1)
      await click('button[aria-label="区分大小写"]');await query('find_alpha')
      await wait('document.querySelector(\'[role="search"]\').textContent.includes("没有匹配项")')
      await click('button[aria-label="正则"]');await query('FIND_Alpha_(ONE|TWO)')
      await wait('document.querySelector(\'[role="search"]\').textContent.includes("已选中匹配项")')
      await query('[');await wait('document.querySelector(\'[role="search"]\').textContent.includes("正则表达式无效")')
      await key('Escape');await wait('!document.querySelector(\'[role="search"]\')')
      passed('search next/previous, case, regex validation and input shortcut isolation')
      await command("Write-Output ('https://example.' + 'invalid/nova-acceptance')")
      await wait('window.__output.includes("https://example.invalid/nova-acceptance")')
      const opened=[], originalExternal=shell.openExternal
      shell.openExternal=async uri=>{opened.push(uri)}
      const linkPoint=await rowPoint('https://example.invalid/nova-acceptance')
      const linkClick=async modifiers=>{
        page.sendInputEvent({type:'mouseMove',x:linkPoint.x+20,y:linkPoint.y});await delay(100)
        page.sendInputEvent({type:'mouseDown',x:linkPoint.x+20,y:linkPoint.y,button:'left',clickCount:1,modifiers})
        page.sendInputEvent({type:'mouseUp',x:linkPoint.x+20,y:linkPoint.y,button:'left',clickCount:1,modifiers});await delay(200)
      }
      await linkClick([])
      assert.deepEqual(opened,['https://example.invalid/nova-acceptance'])
      await command("[Console]::Write(([char]27)+'[?1000h')")
      // Output shifts as commands are entered; rediscover the visible link position.
      Object.assign(linkPoint,await rowPoint('https://example.invalid/nova-acceptance'))
      await linkClick([]);assert.equal(opened.length,1)
      await linkClick(['control']);assert.equal(opened.length,2)
      await command("[Console]::Write(([char]27)+'[?1000l')")
      shell.openExternal=originalExternal
      passed('actual rendered link click and mouse-reporting Ctrl modifier')
      if(process.env.NOVA_ACCEPT_BROWSER==='1') {
        let requests=0
        server=http.createServer((req,res)=>{if(req.url==='/nova-acceptance'){requests++;res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<title>NovaTerminal 验收</title><h1>NovaTerminal 外链验收通过</h1>')}else{res.writeHead(404);res.end()}})
        await new Promise(done=>server.listen(0,'127.0.0.1',done))
        await evaluate(`window.novaLinks.open('http://127.0.0.1:${server.address().port}/nova-acceptance')`)
        const until=Date.now()+8000
        while(!requests && Date.now()<until)await delay(100)
        assert.ok(requests>0,'System browser must request the local verification page')
        passed('real system browser opened loopback verification page')
      }
      await close()
      if(process.platform==='win32' && process.env.NOVA_ACCEPT_WSL==='1') {
        await save({confirmClose:false,confirmExit:false,shell:'wsl'})
        await open();await delay(2000)
        if(!await evaluate('window.__events.some(e=>e.message?.type==="exit" || e.message?.type==="error")')) {
          await command("printf 'WSL_%s\\n' ACCEPTANCE_OK")
          await delay(1000)
        }
        const observation={scope:'wsl',status:'observation-only',...await evaluate('({output:window.__output,events:window.__events.filter(e=>e.message?.type!=="output")})')}
        observations.push(observation)
        console.log('WSL observation:',JSON.stringify(observation))
        await close()
      }
      await save({confirmClose:false,confirmExit:false,shell:'cmd'})
      await open();await command('echo CMD_ACCEPTANCE_OK')
      await wait('window.__output.split("CMD_ACCEPTANCE_OK").length>=3')
      assert.ok(await evaluate('document.body.textContent.includes("cmd.exe")'))
      passed('configured cmd starts and executes real command')
      await close();await save({confirmClose:false,confirmExit:false,shell:'pwsh'})
      await open()
      if(await evaluate('window.__events.some(e=>e.message?.type==="error")')) {
        assert.ok(await evaluate('document.body.textContent.includes("Shell 不可用")'))
        passed('unavailable PowerShell 7 reports error without fallback')
      }else passed('installed PowerShell 7 starts')
      await close()
      await save({confirmClose:false,confirmExit:false,directory:path.join(app.getPath('userData'),'missing-directory')})
      await open();assert.ok(await evaluate('document.body.textContent.includes("无法打开本地目录")'))
      passed('missing default directory fails without falling back to home')
      await close()
      await fs.mkdir(path.join(__dirname,'../test-results'),{recursive:true})
      await fs.writeFile(path.join(__dirname,'../test-results/p0-acceptance.json'),JSON.stringify({date:new Date().toISOString(),platform:process.platform,electron:process.versions.electron,results,observations},null,2))
      console.log('Desktop smoke passed: extended P0 acceptance.')
      await originalWrite.call(clipboard,originalClipboard)
      window.close()
    } catch(error) {
      console.error(error)
      if(!window.isDestroyed()) { console.error(await evaluate('({text:document.body.innerText,output:window.__output?.slice(-3000)})'));await fs.mkdir(path.join(__dirname,'../test-results'),{recursive:true});await fs.writeFile(path.join(__dirname,'../test-results/p0-acceptance-failure.png'),(await page.capturePage()).toPNG()) }
      if(originalClipboard!==undefined)await originalWrite.call(clipboard,originalClipboard)
      app.exit(1)
    } finally {clipboard.writeText=originalWrite;server?.close()}
  })
})
if(process.env.NOVA_TEST_PROFILE)app.setPath('userData',process.env.NOVA_TEST_PROFILE)
require(process.argv[2] || '../out/electron/main.cjs')
