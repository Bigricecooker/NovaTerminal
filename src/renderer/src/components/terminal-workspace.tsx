import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { cn } from 'cn'
import { createPortal } from 'react-dom'
import { ServerIcon, TerminalIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TerminalSession } from '@/components/terminal-session'
import { AssetSidebar } from '@/components/asset-sidebar'
import type { Settings, Platform } from '@shared/settings'
import { loadAssetWorkspace, type AssetConnection } from '@/lib/assets'
import { initialTerminalTabs, terminalTabsReducer } from '@/lib/terminal-tabs'
import { activePhase, composing, phaseLabels, workspaceKey, type Phase } from '@shared/terminal-interactions'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog'

const TAB_DRAG = 'application/x-novaterminal-tab'

export function TerminalWorkspace({ dark, settings, platform, onSettings, actionContainer }: { dark: boolean; settings: Settings; platform: Platform; onSettings: () => void; actionContainer: HTMLElement | null }) {
  const [state, dispatch] = useReducer(terminalTabsReducer, initialTerminalTabs)
  const dragging = useRef<string | null>(null)
  const activeBeforeDrag = useRef<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; position: 'before' | 'after' } | null>(null)
  const [phases, setPhases] = useState<Record<string, Phase>>({})
  const [confirm, setConfirm] = useState<{ kind: 'tab'; id: string } | { kind: 'exit'; id: number } | null>(null)
  const [notice, setNotice] = useState('')
  const tabsContainer = useRef<HTMLDivElement>(null)
  const reportPhase = useCallback((id: string, phase: Phase) => {
    setPhases((current) => current[id] === phase ? current : { ...current, [id]: phase })
  }, [])
  const activeCount = state.tabs.filter((tab) => activePhase(phases[tab.id] ?? 'connecting')).length
  const closeTab = useCallback((id: string) => {
    dispatch({ type: 'close', id })
    setPhases((current) => { const next = { ...current }; delete next[id]; return next })
  }, [])
  const requestClose = useCallback((id: string) => {
    if (settings.confirmClose && activePhase(phases[id] ?? 'connecting')) setConfirm((current) => current ?? { kind: 'tab', id })
    else closeTab(id)
  }, [settings.confirmClose, phases, closeTab])
  useEffect(() => window.novaExit?.onRequest((id) => {
    void window.novaExit?.reply(id, activeCount ? 'ack' : 'exit')
    if (activeCount) setConfirm((current) => current?.kind === 'exit' && current.id === id ? current : { kind: 'exit', id })
  }), [activeCount])
  useEffect(() => {
    const active = tabsContainer.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [state.activeId, state.tabs.length])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4_000)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.repeat || composing(event) || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return
      const target = event.target
      const inTerminal = target instanceof Element && Boolean(target.closest('.xterm'))
      if (!inTerminal && state.tabs.length > 0) return
      if (target instanceof Element && !inTerminal && target.closest('input, textarea, select, [contenteditable="true"]')) return
      const action = workspaceKey(event, platform === 'darwin')
      if (action === null) return
      event.preventDefault(); event.stopImmediatePropagation()
      if (action === 'settings') onSettings()
      else if (action === 'new') {
        if (state.tabs.length >= settings.maxSessions) setNotice(`最多打开 ${settings.maxSessions} 个终端，请先关闭一个标签。`)
        else dispatch({ type: 'open', limit: settings.maxSessions })
      } else if (action === 'close' && state.activeId) requestClose(state.activeId)
      else {
        const index = typeof action === 'number' ? action
          : (state.tabs.findIndex((tab) => tab.id === state.activeId) + (action === 'previous' ? -1 : 1) + state.tabs.length) % state.tabs.length
        const tab = state.tabs[index]
        if (tab) dispatch({ type: 'select', id: tab.id })
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [state, settings.maxSessions, platform, onSettings, requestClose])
  const reconnect = (id: string) => {
    const tab = state.tabs.find((item) => item.id === id)
    if (!tab || activePhase(phases[id] ?? 'connecting')) return
    let target = tab.target
    if (tab.assetId) {
      const document = loadAssetWorkspace(window.localStorage)
      const asset = document.assets.find((item) => item.id === tab.assetId)
      if (document.error || !asset || asset.kind === 'group') { setNotice('原连接已删除或无法读取，请从侧栏重新打开连接。'); return }
      if (target.kind === 'ssh') {
        if (asset.kind !== 'connection' || asset.host !== target.host || asset.port !== target.port || asset.username !== target.username) {
          setNotice('连接端点已变化，请从侧栏重新打开连接。'); return
        }
        target = { ...target, assetId: asset.credentialId ?? asset.id }
      } else if (asset.kind === 'local') target = { kind: 'local', cwd: asset.directory }
    }
    reportPhase(id, 'connecting')
    dispatch({ type: 'reconnect', id, target })
  }
  const atLimit = state.tabs.length >= settings.maxSessions
  const openLabel = atLimit ? `最多打开 ${settings.maxSessions} 个终端，请先关闭一个标签` : '新建本地终端'
  const openSsh = (connection: AssetConnection) => {
    if (connection.needsAuthentication) { setNotice('该连接缺少认证信息，请编辑连接补充。'); return false }
    if (atLimit) return false
    const { host, port, username } = connection
    dispatch({ type: 'open', limit: settings.maxSessions, ssh: { host, port, username, assetId: connection.credentialId ?? connection.id }, name: connection.name, assetId: connection.id })
    return true
  }
  const openLocal = (directory: string, name: string, assetId?: string) => {
    if (atLimit) return false
    dispatch({ type: 'open', limit: settings.maxSessions, local: { directory, name }, ...(assetId ? { assetId } : {}) })
    return true
  }

  return (
    <>
      <AlertDialog open={confirm !== null} onOpenChange={(open) => {
        if (!open) { if (confirm?.kind === 'exit') void window.novaExit?.reply(confirm.id, 'cancel'); setConfirm(null) }
      }}>
        <AlertDialogContent onEscapeKeyDown={(event) => { if (composing(event)) event.preventDefault() }}
          onCloseAutoFocus={(event) => { event.preventDefault(); document.querySelector<HTMLTextAreaElement>('[role="tabpanel"][data-state="active"] .xterm-helper-textarea')?.focus() }}>
          <AlertDialogHeader><AlertDialogTitle>{confirm?.kind === 'exit' ? '退出 NovaTerminal？' : '关闭运行中的会话？'}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.kind === 'exit' ? `仍有 ${activeCount} 个会话活动，退出会断开全部会话。` : '关闭会断开此会话并清除终端输出，已保存的连接不受影响。'}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => {
            if (confirm?.kind === 'tab') closeTab(confirm.id)
            else if (confirm) void window.novaExit?.reply(confirm.id, 'exit')
            setConfirm(null)
          }}>{confirm?.kind === 'exit' ? '退出' : '关闭会话'}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {actionContainer && createPortal(
        <>
          <Button variant="ghost" size="icon" aria-label={openLabel} title={openLabel} disabled={atLimit} onClick={() => dispatch({ type: 'open', limit: settings.maxSessions })}>
            <TerminalIcon />
          </Button>
        </>,
        actionContainer,
      )}
      <div className="flex min-h-0 flex-1">
        <AssetSidebar atLimit={atLimit} onConnect={openSsh} onOpenLocal={openLocal} onAssetsChange={(assets) => dispatch({ type: 'sync-assets', assets })} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {state.tabs.length === 0 ? (
        <Empty className="min-h-0 flex-1" aria-label="终端工作区">
          <EmptyHeader>
            <EmptyMedia variant="icon"><TerminalIcon /></EmptyMedia>
            <EmptyTitle>终端</EmptyTitle>
            <EmptyDescription>从左侧添加 SSH 或本地连接，也可通过右上角图标打开本地终端。每个标签是独立会话。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Tabs value={state.activeId ?? ''} onValueChange={(id) => dispatch({ type: 'select', id })} className="min-h-0 flex-1 gap-0">
          <div ref={tabsContainer} className="terminal-tabs-scroll shrink-0 scroll-px-3 overflow-x-auto border-b px-3 py-1">
            <TabsList variant="line" className="h-10 justify-start" aria-label="终端会话">
              {state.tabs.map((tab) => (
                <div key={tab.id} data-session-tab={tab.id} draggable className={cn('relative h-full shrink-0', drop?.id === tab.id && (drop.position === 'before' ? 'border-l-2 border-ring' : 'border-r-2 border-ring'))}
                  onMouseDownCapture={() => { activeBeforeDrag.current = state.activeId }}
                  onDragStart={(event) => {
                    dragging.current = tab.id
                    event.dataTransfer.setData(TAB_DRAG, tab.id); event.dataTransfer.effectAllowed = 'move'
                    if (activeBeforeDrag.current) dispatch({ type: 'select', id: activeBeforeDrag.current })
                  }}
                  onDragOver={(event) => {
                    if (!dragging.current || dragging.current === tab.id || !event.dataTransfer.types.includes(TAB_DRAG)) return
                    event.preventDefault(); event.dataTransfer.dropEffect = 'move'
                    const rect = event.currentTarget.getBoundingClientRect()
                    setDrop({ id: tab.id, position: event.clientX < rect.left + rect.width / 2 ? 'before' : 'after' })
                  }}
                  onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget instanceof Node ? event.relatedTarget : null)) setDrop(null) }}
                  onDrop={(event) => {
                    event.preventDefault()
                    const source = dragging.current
                    if (source && event.dataTransfer.getData(TAB_DRAG) === source && drop?.id === tab.id) dispatch({ type: 'move', id: source, targetId: tab.id, position: drop.position })
                    dragging.current = null; setDrop(null)
                  }}
                  onDragEnd={() => { dragging.current = null; setDrop(null) }}>
                  <TabsTrigger value={tab.id} className="h-full min-w-36 justify-start gap-2 pl-3 pr-10" title={`${tab.label} · ${phaseLabels[phases[tab.id] ?? 'connecting']}；拖动或 Ctrl+Shift+←/→ 调整顺序`}
                    onKeyDown={(event) => {
                      if (composing(event.nativeEvent) || !event.ctrlKey || !event.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
                      event.preventDefault()
                      const index = state.tabs.findIndex((item) => item.id === tab.id)
                      const target = state.tabs[index + (event.key === 'ArrowLeft' ? -1 : 1)]
                      if (target) dispatch({ type: 'move', id: tab.id, targetId: target.id, position: event.key === 'ArrowLeft' ? 'before' : 'after' })
                    }}>
                    {tab.target.kind === 'ssh' ? <ServerIcon aria-hidden="true" /> : <TerminalIcon aria-hidden="true" />}
                    <span className="session-status size-2 shrink-0 rounded-full" data-phase={phases[tab.id] ?? 'connecting'} role="img" aria-label={phaseLabels[phases[tab.id] ?? 'connecting']} title={phaseLabels[phases[tab.id] ?? 'connecting']} />
                    <span className="max-w-40 truncate">{tab.label}</span>
                  </TabsTrigger>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                    aria-label={`关闭${tab.label}`}
                    title={`关闭${tab.label}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => requestClose(tab.id)}
                  >
                    <XIcon />
                  </Button>
                </div>
              ))}
            </TabsList>
          </div>
          {state.tabs.map((tab) => (
            // Keep background xterm instances and sessions alive; only closing removes them.
            <TabsContent key={tab.id} value={tab.id} forceMount className="min-h-0 data-[state=active]:flex data-[state=inactive]:hidden">
              <TerminalSession key={`${tab.id}-${tab.generation ?? 0}`} dark={dark} settings={settings} active={state.activeId === tab.id} label={tab.label} target={tab.target}
                onPhase={(phase) => reportPhase(tab.id, phase)} onReconnect={() => reconnect(tab.id)} />
            </TabsContent>
          ))}
        </Tabs>
      )}
        </div>
      </div>
      {notice && <p role="status" className="shrink-0 border-t px-4 py-2 text-sm">{notice}</p>}
    </>
  )
}
