import { lazy, Suspense, useEffect, useState } from 'react'
import { MoonIcon, SunIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

const TerminalWorkspace = lazy(() => import('@/components/terminal-workspace').then((module) => ({ default: module.TerminalWorkspace })))

export default function App() {
  const [dark, setDark] = useState(false)
  const [terminalActions, setTerminalActions] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    if (window.novaWindow) {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const context = canvas.getContext('2d')
      if (context) {
        // Convert CSS colors (including OKLCH tokens) into Electron's RGB format.
        const rgb = (color: string) => {
          context.fillStyle = color
          context.fillRect(0, 0, 1, 1)
          return `#${Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3), (value) => value.toString(16).padStart(2, '0')).join('')}`
        }
        const colors = getComputedStyle(document.body)
        void window.novaWindow.setAppearance({ background: rgb(colors.backgroundColor), foreground: rgb(colors.color) }).catch(() => {})
      }
    }
  }, [dark])

  return (
    <div className="flex h-dvh min-h-64 flex-col overflow-hidden bg-background text-foreground">
      <header className="app-titlebar shrink-0 bg-background" data-desktop={window.novaWindow ? 'true' : undefined}>
        <div className="app-titlebar-content flex items-center justify-between px-4">
          <h1 className="text-sm font-medium">NovaTerminal</h1>
          <div className="app-titlebar-actions flex h-full items-center gap-1">
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
            {window.novaWindow && <Separator orientation="vertical" className="ml-2" />}
          </div>
        </div>
      </header>
      <Separator />
      <main className="flex min-h-0 flex-1 flex-col" aria-label="工作区">
        <Suspense fallback={<p className="p-4 text-sm text-muted-foreground" role="status">正在加载终端…</p>}>
          <TerminalWorkspace dark={dark} actionContainer={terminalActions} />
        </Suspense>
      </main>
    </div>
  )
}
