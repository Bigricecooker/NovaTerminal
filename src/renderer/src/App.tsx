import { lazy, Suspense, useEffect, useState } from 'react'
import { MoonIcon, SunIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

const TerminalWorkspace = lazy(() => import('@/components/terminal-workspace').then((module) => ({ default: module.TerminalWorkspace })))

export default function App() {
  const [dark, setDark] = useState(false)
  const [terminalActions, setTerminalActions] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])

  return (
    <div className="flex h-dvh min-h-64 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <h1 className="text-sm font-medium">NovaTerminal</h1>
        <div className="flex items-center gap-1">
          <div ref={setTerminalActions} className="flex items-center" />
          <Button
            variant="ghost"
            size="icon"
            aria-label={dark ? '切换浅色主题' : '切换深色主题'}
            title={dark ? '切换浅色主题' : '切换深色主题'}
            onClick={() => setDark((current) => !current)}
          >
            {dark ? <SunIcon /> : <MoonIcon />}
          </Button>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col" aria-label="工作区">
        <Suspense fallback={<p className="p-4 text-sm text-muted-foreground" role="status">正在加载终端…</p>}>
          <TerminalWorkspace dark={dark} actionContainer={terminalActions} />
        </Suspense>
      </main>
    </div>
  )
}
