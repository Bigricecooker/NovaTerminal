import { useReducer, useRef, useState } from 'react'
import { cn } from 'cn'
import { createPortal } from 'react-dom'
import { ServerIcon, TerminalIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TerminalSession } from '@/components/terminal-session'
import { AssetSidebar } from '@/components/asset-sidebar'
import { MAX_SESSIONS } from '@shared/terminal-protocol'
import type { AssetConnection } from '@/lib/assets'
import { initialTerminalTabs, terminalTabsReducer } from '@/lib/terminal-tabs'

const TAB_DRAG = 'application/x-novaterminal-tab'

export function TerminalWorkspace({ dark, actionContainer }: { dark: boolean; actionContainer: HTMLElement | null }) {
  const [state, dispatch] = useReducer(terminalTabsReducer, initialTerminalTabs)
  const dragging = useRef<string | null>(null)
  const activeBeforeDrag = useRef<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; position: 'before' | 'after' } | null>(null)
  const atLimit = state.tabs.length >= MAX_SESSIONS
  const openLabel = atLimit ? `最多打开 ${MAX_SESSIONS} 个终端，请先关闭一个标签` : '新建本地终端'
  const openSsh = (connection: AssetConnection) => {
    if (atLimit) return false
    const { host, port, username } = connection
    dispatch({ type: 'open', ssh: { host, port, username, assetId: connection.credentialId ?? connection.id }, name: connection.name, assetId: connection.id })
    return true
  }
  const openLocal = (directory: string, name: string, assetId?: string) => {
    if (atLimit) return false
    dispatch({ type: 'open', local: { directory, name }, ...(assetId ? { assetId } : {}) })
    return true
  }

  return (
    <>
      {actionContainer && createPortal(
        <>
          <Button variant="ghost" size="icon" aria-label={openLabel} title={openLabel} disabled={atLimit} onClick={() => dispatch({ type: 'open' })}>
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
          <div className="shrink-0 overflow-x-auto border-b px-3 py-1">
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
                  <TabsTrigger value={tab.id} className="h-full min-w-36 justify-start gap-2 pl-3 pr-10" title="拖动调整顺序；Ctrl+Shift+←/→ 也可移动"
                    onKeyDown={(event) => {
                      if (!event.ctrlKey || !event.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
                      event.preventDefault()
                      const index = state.tabs.findIndex((item) => item.id === tab.id)
                      const target = state.tabs[index + (event.key === 'ArrowLeft' ? -1 : 1)]
                      if (target) dispatch({ type: 'move', id: tab.id, targetId: target.id, position: event.key === 'ArrowLeft' ? 'before' : 'after' })
                    }}>
                    {tab.target.kind === 'ssh' ? <ServerIcon aria-hidden="true" /> : <TerminalIcon aria-hidden="true" />}
                    <span className="max-w-40 truncate">{tab.label}</span>
                  </TabsTrigger>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                    aria-label={`关闭${tab.label}`}
                    title={`关闭${tab.label}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => dispatch({ type: 'close', id: tab.id })}
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
              <TerminalSession dark={dark} active={state.activeId === tab.id} label={tab.label} target={tab.target} />
            </TabsContent>
          ))}
        </Tabs>
      )}
        </div>
      </div>
    </>
  )
}
