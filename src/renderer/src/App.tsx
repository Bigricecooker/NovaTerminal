import { lazy, Suspense, useEffect, useLayoutEffect, useState } from 'react'
import { MoonIcon, SunIcon, SettingsIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { WindowControls } from '@/components/window-controls'
import { SettingsDialog } from '@/components/settings-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { DEFAULT_SETTINGS, type Settings, type SettingsSnapshot } from '@shared/settings'

const TerminalWorkspace = lazy(() => import('@/components/terminal-workspace').then((module) => ({ default: module.TerminalWorkspace })))

export default function App() {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>(() => window.novaSettings?.initial ?? { values: { ...DEFAULT_SETTINGS }, dark: false, platform: 'win32', warning: '' })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [error, setError] = useState(snapshot.warning)
  const dark = snapshot.dark
  const [terminalActions, setTerminalActions] = useState<HTMLDivElement | null>(null)

  useEffect(() => window.novaSettings?.onChange(setSnapshot), [])
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])
  const save = async (values: Settings) => {
    if (!window.novaSettings) throw new Error('设置服务不可用。')
    setSnapshot(await window.novaSettings.save(values))
  }

  if (!window.novaTerminal) return <main className="p-4" role="alert">请通过 NovaTerminal 桌面应用启动。</main>

  return (
    <div className="flex h-dvh min-h-64 flex-col overflow-hidden bg-background text-foreground">
      <header className="app-titlebar shrink-0 bg-background">
        <div className="flex h-full items-center justify-between pl-4">
          <h1 className="text-sm font-medium">NovaTerminal</h1>
          <div className="app-titlebar-actions flex h-full items-center gap-1">
            <div ref={setTerminalActions} className="flex items-center" />
            <Button
              variant="ghost"
              size="icon"
              aria-label={dark ? '切换浅色主题' : '切换深色主题'}
              title={dark ? '切换浅色主题' : '切换深色主题'}
              onClick={() => { void save({ ...snapshot.values, theme: dark ? 'light' : 'dark' }).catch(() => setError('主题保存失败，请检查本机存储权限。')) }}
            >
              {dark ? <SunIcon /> : <MoonIcon />}
            </Button>
            <Button variant="ghost" size="icon" aria-label="设置" title="设置" onClick={() => setSettingsOpen(true)}><SettingsIcon /></Button>
            {window.novaWindow && <Separator orientation="vertical" className="ml-2" />}
            <WindowControls />
          </div>
        </div>
      </header>
      <Separator />
      {error && <Alert variant="destructive"><AlertDescription className="flex items-center justify-between">{error}<Button variant="ghost" size="sm" onClick={() => setError('')}>知道了</Button></AlertDescription></Alert>}
      {settingsOpen && <SettingsDialog snapshot={snapshot} onClose={() => setSettingsOpen(false)} onSave={save} />}
      <main className="flex min-h-0 flex-1 flex-col" aria-label="工作区">
        <Suspense fallback={<p className="p-4 text-sm text-muted-foreground" role="status">正在加载终端…</p>}>
          <TerminalWorkspace dark={dark} settings={snapshot.values} platform={snapshot.platform} onSettings={() => setSettingsOpen(true)} actionContainer={terminalActions} />
        </Suspense>
      </main>
    </div>
  )
}
