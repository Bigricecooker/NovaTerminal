import { useCallback, useEffect, useRef, useState } from 'react'
import { ShieldCheckIcon } from 'lucide-react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { SSH_START_TIMEOUT, type ClientMessage, type ServerMessage } from '@shared/terminal-protocol'
import { terminalInputChunks } from '@shared/terminal-input'
import { createTerminalTransport } from '@/lib/terminal-transport'
import type { TerminalTarget } from '@/lib/terminal-tabs'
import { FONT_STACKS, type Settings } from '@shared/settings'
import { MAX_COPY, MAX_PASTE, composing, phaseLabels, type Phase } from '@shared/terminal-interactions'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog'

type Session = { phase: Phase; detail: string; shell: string }
type HostKey = Extract<ServerMessage, { type: 'host-key' }>
type Controls = { terminal: Terminal; fit: () => void; trust: (key: HostKey, accept: boolean) => void }

function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const color = (name: string) => style.getPropertyValue(`--terminal-${name}`).trim()
  return {
    background: color('background'), foreground: color('foreground'),
    cursor: color('foreground'), cursorAccent: color('background'),
    selectionBackground: color('selection'),
    black: color('black'), red: color('red'), green: color('green'), yellow: color('yellow'),
    blue: color('blue'), magenta: color('magenta'), cyan: color('cyan'), white: color('white'),
    brightBlack: color('bright-black'), brightRed: color('red'), brightGreen: color('green'),
    brightYellow: color('yellow'), brightBlue: color('blue'), brightMagenta: color('magenta'),
    brightCyan: color('cyan'), brightWhite: color('foreground'),
  }
}

export function TerminalSession({ dark, settings, active, label, target, onPhase, onReconnect }: {
  dark: boolean; settings: Settings; active: boolean; label: string; target: TerminalTarget
  onPhase: (phase: Phase) => void; onReconnect: () => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const controls = useRef<Controls | null>(null)
  const activeRef = useRef(active)
  const settingsRef = useRef(settings)
  useEffect(() => { settingsRef.current = settings }, [settings])
  const [notice, setNotice] = useState('')
  const [selection, setSelection] = useState(false)
  const [pastePreview, setPastePreview] = useState<{ lines: number; length: number } | null>(null)
  const pasteApproval = useRef<((accept: boolean) => void) | null>(null)
  const copyAction = useRef<() => void>(() => {})
  const pasteAction = useRef<() => void>(() => {})
  const [session, setSession] = useState<Session>({ phase: 'connecting', detail: target.kind === 'ssh' ? '正在连接 SSH 服务器…' : '正在启动本地 Shell…', shell: '' })
  const [hostKey, setHostKey] = useState<HostKey | null>(null)
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null)
  const clearSearch = useCallback(() => { controls.current?.terminal.clearSelection() }, [])
  useEffect(() => { onPhase(session.phase) }, [onPhase, session.phase])

  useEffect(() => {
    if (!container.current) return
    const element = container.current
    const terminal = new Terminal({
      cursorBlink: true, fontFamily: 'Cascadia Mono, Consolas, Menlo, monospace',
      fontSize: 14, lineHeight: 1.25, scrollback: 5_000,
      theme: terminalTheme(), allowProposedApi: false,
      allowTransparency: false, disableStdin: true,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element)
    let disposed = false
    let ended = false
    let started = false
    let ready = false
    let frame = 0
    let timeout = 0
    let selecting = false
    let selectionTimer = 0
    let pasting = false
    const copy = async () => {
      if (disposed || !activeRef.current || !terminal.hasSelection()) return
      const text = terminal.getSelection()
      if (text.length > MAX_COPY) { setNotice('复制内容超过 1 MiB 上限。'); return }
      try {
        if (!window.novaClipboard) throw new Error('剪贴板不可用。')
        await window.novaClipboard.write(text)
        if (!disposed) setNotice('已复制。')
      } catch { if (!disposed) setNotice('复制失败，请检查剪贴板是否可用。') }
    }
    const paste = async () => {
      if (disposed || !activeRef.current || !ready || pasting) return
      pasting = true
      try {
        if (!window.novaClipboard) throw new Error('剪贴板不可用。')
        const text = await window.novaClipboard.read()
        if (disposed || !activeRef.current || !ready || !text) return
        if (text.length > MAX_PASTE) { setNotice('粘贴超过 64 KiB，请分段粘贴。'); return }
        if (settingsRef.current.confirmMultiline && /[\r\n]/.test(text)) {
          setPastePreview({ lines: text.split(/\r\n|\r|\n/).length, length: text.length })
          const accepted = await new Promise<boolean>((resolve) => { pasteApproval.current = resolve })
          pasteApproval.current = null
          setPastePreview(null)
          if (!accepted) return
        }
        if (!disposed && activeRef.current && ready) { terminal.paste(text); terminal.focus() }
      } catch (error) { if (!disposed) setNotice(error instanceof Error && error.message.includes('64 KiB') ? '粘贴超过 64 KiB，请分段粘贴。' : '无法读取剪贴板。') }
      finally { pasting = false }
    }
    copyAction.current = () => { void copy() }
    pasteAction.current = () => { void paste() }
    const nativePaste = (event: ClipboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); void paste() }
    element.addEventListener('paste', nativePaste, true)
    const startSelection = () => { selecting = true }
    const finishSelection = () => { const wasSelecting = selecting; selecting = false; if (wasSelecting && settingsRef.current.copyOnSelect) void copy() }
    element.addEventListener('pointerdown', startSelection)
    window.addEventListener('pointerup', finishSelection)
    const selectionSubscription = terminal.onSelectionChange(() => {
      setSelection(terminal.hasSelection())
      clearTimeout(selectionTimer)
      if (!selecting && settingsRef.current.copyOnSelect) selectionTimer = window.setTimeout(() => { void copy() }, 180)
    })
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || composing(event)) return true
      const mac = window.novaSettings?.initial.platform === 'darwin'
      const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      const key = event.key.toLowerCase()
      if (primary && !event.altKey && key === 'c' && (event.shiftKey || terminal.hasSelection())) {
        event.preventDefault(); void copy(); return false
      }
      if (primary && !event.altKey && key === 'v' && (mac || event.shiftKey)) {
        event.preventDefault(); void paste(); return false
      }
      return true
    })
    const send = (message: ClientMessage) => {
      if (!disposed && transport.isOpen()) transport.send(message)
    }
    const stop = (phase: 'closed' | 'error', detail: string) => {
      if (disposed || ended) return
      ended = true
      ready = false
      clearTimeout(timeout)
      terminal.options.disableStdin = true
      setHostKey(null)
      setSession((current) => ({ ...current, phase, detail }))
      transport.close()
    }
    const fitTerminal = () => {
      if (disposed) return
      const visible = element.clientWidth > 0 && element.clientHeight > 0
      // A newly opened tab may already be in the background when its session opens.
      // Start it with xterm's initial dimensions; fit once it becomes visible.
      if (visible) fit.fit()
      // FitAddon can propose dimensions beyond our protocol limits on very large displays.
      const cols = Math.max(2, Math.min(500, terminal.cols))
      const rows = Math.max(2, Math.min(300, terminal.rows))
      if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows)
      setSize({ cols, rows })
      if (!transport.isOpen() || ended) return
      if (!started) {
        started = true
        if (target.kind === 'ssh') {
          send({ type: 'start', cols, rows, savedSsh: { assetId: target.assetId, host: target.host, port: target.port, username: target.username } })
        } else send({ type: 'start', cols, rows, ...(target.cwd ? { cwd: target.cwd } : {}) })
      } else if (ready && visible) {
        send({ type: 'resize', cols, rows })
      }
    }
    const scheduleFit = () => {
      if (disposed) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fitTerminal)
    }
    const observer = new ResizeObserver(scheduleFit)
    observer.observe(element)
    void document.fonts.ready.then(scheduleFit)
    window.addEventListener('resize', scheduleFit)
    const input = terminal.onData((data) => {
      if (!ready || ended) return
      // Bound a single paste so it cannot enqueue an unlimited amount of input.
      // Bracketed paste adds 12 units around a bounded clipboard payload.
      if (data.length > MAX_PASTE + 12 || transport.buffered() + data.length > 131_072) {
        setNotice('输入超过缓冲限制，请稍后分段粘贴。')
        return
      }
      for (const chunk of terminalInputChunks(data)) {
        send({ type: 'input', data: chunk })
      }
    })
    timeout = window.setTimeout(() => stop('error', '终端连接超时，请检查服务和网络后新建终端。'), target.kind === 'ssh' ? SSH_START_TIMEOUT + 5_000 : 12_000)
    const receiveMessage = (message: ServerMessage) => {
      if (disposed || ended) return
      switch (message.type) {
        case 'host-key':
          if (target.kind !== 'ssh' || message.host !== target.host || message.port !== target.port || ready) {
            stop('error', 'SSH 主机指纹消息与会话不匹配。'); return
          }
          setHostKey(message)
          setSession({ phase: 'verifying', detail: '请向服务器管理员核对主机指纹。', shell: '' })
          break
        case 'ready':
          clearTimeout(timeout)
          ready = true
          terminal.options.disableStdin = false
          setHostKey(null)
          setSession({ phase: 'running', detail: target.kind === 'ssh' ? `SSH · ${target.host}:${target.port}` : target.cwd ?? '本地会话', shell: message.shell })
          fitTerminal()
          if (activeRef.current && !document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) terminal.focus()
          break
        case 'output':
          // Confirm UTF-16 code units only after xterm has consumed the chunk.
          terminal.write(message.data, () => {
            if (!ended) send({ type: 'ack', count: message.data.length })
          })
          break
        case 'exit': stop('closed', `Shell 已退出，退出码 ${message.code}。`); break
        case 'error': stop('error', message.message); break
      }
    }
    const transport = createTerminalTransport({
      open: fitTerminal, message: receiveMessage,
      error: () => stop('error', '无法连接终端会话，可能已达会话上限或上个会话仍在清理，请稍后重新连接。'),
      close: () => stop('closed', '连接已断开，可手动重新连接。'),
    }, window.novaTerminal)
    controls.current = {
      terminal,
      fit: scheduleFit,
      trust: (key, accept) => {
        send({ type: 'host-key-response', fingerprint: key.fingerprint, accept })
        setHostKey(null)
        if (accept) setSession({ phase: 'connecting', detail: '正在验证 SSH 身份…', shell: '' })
        else stop('closed', '已拒绝主机指纹，连接已取消。')
      },
    }

    return () => {
      disposed = true
      pasteApproval.current?.(false)
      pasteApproval.current = null
      clearTimeout(selectionTimer)
      selectionSubscription.dispose()
      element.removeEventListener('paste', nativePaste, true)
      element.removeEventListener('pointerdown', startSelection)
      window.removeEventListener('pointerup', finishSelection)
      clearTimeout(timeout)
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', scheduleFit)
      transport.close()
      input.dispose()
      terminal.dispose()
      controls.current = null
    }
  }, [target])

  useEffect(() => {
    activeRef.current = active
    if (!active) return
    const frame = requestAnimationFrame(() => {
      controls.current?.fit()
      controls.current?.terminal.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active])

  useEffect(() => {
    if (controls.current) {
      const terminal = controls.current.terminal
      terminal.options.fontFamily = FONT_STACKS[settings.fontFamily]
      terminal.options.fontSize = settings.fontSize
      terminal.options.lineHeight = settings.lineHeight
      terminal.options.scrollback = settings.scrollback
      terminal.options.cursorStyle = settings.cursorStyle
      terminal.options.cursorBlink = settings.cursorBlink
      controls.current.fit()
    }
  }, [settings])

  useEffect(() => {
    // App updates the root theme before paint; defer reading CSS tokens one frame.
    const frame = requestAnimationFrame(() => {
      if (controls.current) controls.current.terminal.options.theme = terminalTheme()
    })
    return () => cancelAnimationFrame(frame)
  }, [dark])

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={label}>
      <AlertDialog open={pastePreview !== null} onOpenChange={(open) => { if (!open) pasteApproval.current?.(false) }}>
        <AlertDialogContent onEscapeKeyDown={(event) => { if (composing(event)) event.preventDefault() }}>
          <AlertDialogHeader><AlertDialogTitle>确认多行粘贴</AlertDialogTitle><AlertDialogDescription>即将粘贴 {pastePreview?.lines} 行、{pastePreview?.length} 个字符，可能执行多条命令。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel onClick={() => pasteApproval.current?.(false)}>取消</AlertDialogCancel><AlertDialogAction onClick={() => pasteApproval.current?.(true)}>粘贴</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {hostKey && (
        <div className="shrink-0 p-4">
          <Alert>
            <ShieldCheckIcon />
            <AlertTitle>首次连接 {hostKey.host}:{hostKey.port}</AlertTitle>
            <AlertDescription className="flex flex-col gap-3">
              <p>请通过可信渠道核对服务器的 SHA-256 主机指纹，确认后记录并连接。</p>
              <code className="break-all select-all">{hostKey.fingerprint}</code>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => controls.current?.trust(hostKey, false)}>拒绝连接</Button>
                <Button size="sm" onClick={() => controls.current?.trust(hostKey, true)}>信任并连接</Button>
              </div>
            </AlertDescription>
          </Alert>
        </div>
      )}
      <ContextMenu><ContextMenuTrigger asChild>
      <div className="relative min-h-0 flex-1 bg-terminal-background">
        <div ref={container} className="absolute inset-0 overflow-hidden p-3 sm:p-4" aria-label={`${label}输入输出`} />
      </div>
      </ContextMenuTrigger><ContextMenuContent onCloseAutoFocus={(event) => { event.preventDefault(); if (!pasteApproval.current) controls.current?.terminal.focus() }}>
        <ContextMenuGroup>
          <ContextMenuItem disabled={!selection} onSelect={() => copyAction.current()}>复制</ContextMenuItem>
          <ContextMenuItem disabled={session.phase !== 'running'} onSelect={() => pasteAction.current()}>粘贴</ContextMenuItem>
          <ContextMenuItem onSelect={() => controls.current?.terminal.selectAll()}>全选</ContextMenuItem>
        </ContextMenuGroup><ContextMenuSeparator /><ContextMenuGroup>
          <ContextMenuItem onSelect={() => { clearSearch(); controls.current?.terminal.clear() }}>清屏</ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent></ContextMenu>
      {notice && <div className="flex shrink-0 items-center justify-between gap-2 px-4 text-xs" role="status">{notice}<Button variant="ghost" size="xs" onClick={() => setNotice('')}>关闭提示</Button></div>}
      <footer className="flex min-h-9 shrink-0 items-center justify-between gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
        <div role="status" aria-live="polite" className="flex min-w-0 items-center gap-2">
          <Badge variant={session.phase === 'error' ? 'destructive' : 'secondary'} className="shrink-0">{phaseLabels[session.phase]}</Badge>
          <p className="min-w-0 break-all">{session.shell && `${session.shell} · `}{session.detail}</p>
        </div>
        <div className="flex shrink-0 items-center gap-4 font-mono tabular-nums">
          {(session.phase === 'error' || session.phase === 'closed') && <Button size="xs" variant="outline" onClick={onReconnect}>重新连接</Button>}
          {size && <span aria-label={`${size.cols} 列 ${size.rows} 行`}>{size.cols} × {size.rows}</span>}
          <span className="hidden sm:inline">UTF-8</span>
        </div>
      </footer>
    </section>
  )
}
