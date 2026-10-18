import { useCallback, useReducer, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ServerIcon, TerminalIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TerminalSession } from '@/components/terminal-session'
import { SshConnectionDialog } from '@/components/ssh-connection-dialog'
import { AssetSidebar } from '@/components/asset-sidebar'
import { MAX_SESSIONS, type SshOptions } from '@/lib/terminal-protocol'
import { initialTerminalTabs, terminalTabsReducer } from '@/lib/terminal-tabs'

export function TerminalWorkspace({ dark, actionContainer }: { dark: boolean; actionContainer: HTMLElement | null }) {
  const [state, dispatch] = useReducer(terminalTabsReducer, initialTerminalTabs)
  // Secrets are handed to the socket once, never put in tab state or storage.
  const credentials = useRef(new Map<string, SshOptions>())
  const takeSshOptions = useCallback((id: string) => {
    const value = credentials.current.get(id)
    credentials.current.delete(id)
    return value
  }, [])
  const atLimit = state.tabs.length >= MAX_SESSIONS
  const openLabel = atLimit ? `最多打开 ${MAX_SESSIONS} 个终端，请先关闭一个标签` : '新建本地终端'
  const openSsh = (options: SshOptions) => {
    if (atLimit) return false
    credentials.current.set(`ssh-${state.nextId}`, options)
    const { host, port, username } = options
    dispatch({ type: 'open', ssh: { host, port, username } })
    return true
  }

  return (
    <>
      {actionContainer && createPortal(
        <>
          <Button variant="ghost" size="icon" aria-label={openLabel} title={openLabel} disabled={atLimit} onClick={() => dispatch({ type: 'open' })}>
            <TerminalIcon />
          </Button>
          <SshConnectionDialog disabled={atLimit} onConnect={openSsh} />
        </>,
        actionContainer,
      )}
      <div className="flex min-h-0 flex-1">
        <AssetSidebar atLimit={atLimit} onConnect={openSsh} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {state.tabs.length === 0 ? (
        <Empty className="min-h-0 flex-1" aria-label="终端工作区">
          <EmptyHeader>
            <EmptyMedia variant="icon"><TerminalIcon /></EmptyMedia>
            <EmptyTitle>终端</EmptyTitle>
            <EmptyDescription>从左侧资产连接服务器，或通过右上角图标打开本地终端和 SSH 连接。每个标签是独立会话。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Tabs value={state.activeId ?? ''} onValueChange={(id) => dispatch({ type: 'select', id })} className="min-h-0 flex-1 gap-0">
          <div className="shrink-0 overflow-x-auto border-b px-3 py-1">
            <TabsList variant="line" className="h-10 justify-start" aria-label="终端会话">
              {state.tabs.map((tab) => (
                <div key={tab.id} className="relative h-full shrink-0">
                  <TabsTrigger value={tab.id} className="h-full min-w-36 justify-start gap-2 pl-3 pr-10">
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
                    onClick={() => { credentials.current.delete(tab.id); dispatch({ type: 'close', id: tab.id }) }}
                  >
                    <XIcon />
                  </Button>
                </div>
              ))}
            </TabsList>
          </div>
          {state.tabs.map((tab) => (
            // Keep background xterm instances and sockets alive; only closing removes them.
            <TabsContent key={tab.id} value={tab.id} forceMount className="min-h-0 data-[state=active]:flex data-[state=inactive]:hidden">
              <TerminalSession dark={dark} active={state.activeId === tab.id} label={tab.label} id={tab.id} target={tab.target} takeSshOptions={takeSshOptions} />
            </TabsContent>
          ))}
        </Tabs>
      )}
        </div>
      </div>
    </>
  )
}
