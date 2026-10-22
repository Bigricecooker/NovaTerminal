import { useEffect, useRef, useState } from 'react'
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

type Phase = 'connecting' | 'verifying' | 'running' | 'closed' | 'error'
type Session = { phase: Phase; detail: string; shell: string }
type HostKey = Extract<ServerMessage, { type: 'host-key' }>
type Controls = { terminal: Terminal; fit: () => void; trust: (key: HostKey, accept: boolean) => void }

const phaseLabels: Record<Phase, string> = {
  connecting: '连接中', verifying: '待确认指纹', running: '运行中', closed: '已结束', error: '连接失败',
}

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

export function TerminalSession({ dark, settings, active, label, target }: {
  dark: boolean; settings: Settings; active: boolean; label: string; target: TerminalTarget
}) {
  const container = useRef<HTMLDivElement>(null)
  const controls = useRef<Controls | null>(null)
  const activeRef = useRef(active)
  const [session, setSession] = useState<Session>({ phase: 'connecting', detail: target.kind === 'ssh' ? '正在连接 SSH 服务器…' : '正在启动本地 Shell…', shell: '' })
  const [hostKey, setHostKey] = useState<HostKey | null>(null)
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null)

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
      if (data.length > 65_536 || transport.buffered() > 65_536) {
        stop('error', '输入超过缓冲限制，会话已关闭，请新建终端。')
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
      error: () => stop('error', '无法连接终端会话，请重新打开终端。'),
      close: () => stop('closed', '连接已断开；可通过右上角图标新建终端。'),
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
      <div className="relative min-h-0 flex-1 bg-terminal-background">
        <div ref={container} className="absolute inset-0 overflow-hidden p-3 sm:p-4" aria-label={`${label}输入输出`} />
      </div>
      <footer className="flex min-h-9 shrink-0 items-center justify-between gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
        <div role="status" aria-live="polite" className="flex min-w-0 items-center gap-2">
          <Badge variant={session.phase === 'error' ? 'destructive' : 'secondary'} className="shrink-0">{phaseLabels[session.phase]}</Badge>
          <p className="min-w-0 break-all">{session.shell && `${session.shell} · `}{session.detail}</p>
        </div>
        <div className="flex shrink-0 items-center gap-4 font-mono tabular-nums">
          {size && <span aria-label={`${size.cols} 列 ${size.rows} 行`}>{size.cols} × {size.rows}</span>}
          <span className="hidden sm:inline">UTF-8</span>
        </div>
      </footer>
    </section>
  )
}
