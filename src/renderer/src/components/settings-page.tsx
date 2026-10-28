import { useState } from 'react'
import { ArrowLeftIcon, PaletteIcon, TerminalIcon, PanelsTopLeftIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { parseSettings, platformShells, type Settings, type SettingsSnapshot } from '@shared/settings'
import { composing } from '@shared/terminal-interactions'

const sections = [
  { value: 'appearance', label: '外观', description: '主题、字体与终端显示。', icon: PaletteIcon },
  { value: 'terminal', label: '终端', description: '复制、粘贴与标签操作。', icon: TerminalIcon },
  { value: 'sessions', label: '会话', description: 'Shell 与起始目录用于新会话。', icon: PanelsTopLeftIcon },
] as const

export function SettingsPage({ snapshot, onClose, onSave }: {
  snapshot: SettingsSnapshot; onClose: () => void; onSave: (values: Settings) => Promise<void>
}) {
  const [draft, setDraft] = useState(snapshot.values)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [section, setSection] = useState('appearance')
  const current = sections.find((item) => item.value === section) ?? sections[0]
  const patch = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const toggle = (key: 'cursorBlink' | 'copyOnSelect' | 'confirmMultiline' | 'confirmClose' | 'confirmExit', label: string) => (
    <Field orientation="horizontal"><FieldLabel htmlFor={`setting-${key}`}>{label}</FieldLabel>
      <Switch id={`setting-${key}`} checked={draft[key]} onCheckedChange={(value) => patch(key, value)} /></Field>
  )
  const numeric = (key: 'fontSize' | 'lineHeight' | 'scrollback' | 'maxSessions', label: string, min: number, max: number, step: number) => (
    <Field><FieldLabel htmlFor={`setting-${key}`}>{label}</FieldLabel>
      <Input id={`setting-${key}`} name={key} type="number" value={Number.isNaN(draft[key]) ? '' : draft[key]} min={min} max={max} step={step}
        onChange={(event) => patch(key, event.target.valueAsNumber)} required /></Field>
  )
  return <section className="flex min-h-0 flex-1" aria-label="设置" onKeyDown={(event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && !busy && !composing(event.nativeEvent)) { event.preventDefault(); onClose() }
  }}>
    <Tabs orientation="vertical" value={section} onValueChange={setSection} className="min-h-0 flex-1 gap-0">
      <aside className="flex w-40 shrink-0 flex-col gap-6 border-r bg-sidebar p-3 sm:w-56 sm:p-4">
        <Button variant="ghost" className="justify-start" disabled={busy} onClick={onClose} autoFocus><ArrowLeftIcon data-icon="inline-start" />返回应用</Button>
        <div className="flex flex-col gap-3">
          <p className="px-3 text-sm text-muted-foreground">设置</p>
          <TabsList className="w-full items-stretch gap-1" aria-label="设置分类">
            {sections.map(({ value, label, icon: Icon }) => <TabsTrigger key={value} value={value} disabled={busy} className="h-10 flex-none justify-start px-3"><Icon />{label}</TabsTrigger>)}
          </TabsList>
        </div>
      </aside>
      <form className="flex min-h-0 min-w-0 flex-1 flex-col" onSubmit={(event) => {
        event.preventDefault()
        if (busy) return
        setError(''); setBusy(true)
        void Promise.resolve().then(() => onSave(parseSettings(draft, snapshot.platform))).then(onClose)
          .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '无法保存设置。')).finally(() => setBusy(false))
      }}>
        <div className="flex shrink-0 flex-col gap-1 px-5 py-5 sm:px-8">
          <h2 className="text-xl font-semibold">{current.label}</h2><p className="text-sm text-muted-foreground">{current.description}</p>
        </div>
        <Separator />
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-6 sm:px-8">
          <TabsContent value="appearance" className="m-0 max-w-2xl">
            <FieldSet disabled={busy}><FieldLegend className="sr-only">外观</FieldLegend><FieldGroup>
              <Field><FieldLabel htmlFor="setting-theme">主题</FieldLabel>
                <NativeSelect id="setting-theme" value={draft.theme} onChange={(e) => {
                  const theme = e.target.value; if (theme === 'light' || theme === 'dark' || theme === 'system') patch('theme', theme)
                }}><NativeSelectOption value="system">跟随系统</NativeSelectOption><NativeSelectOption value="light">浅色</NativeSelectOption><NativeSelectOption value="dark">深色</NativeSelectOption></NativeSelect></Field>
              <Field><FieldLabel htmlFor="setting-font">字体</FieldLabel>
                <NativeSelect id="setting-font" value={draft.fontFamily} onChange={(e) => { if (e.target.value === 'default' || e.target.value === 'system') patch('fontFamily', e.target.value) }}>
                  <NativeSelectOption value="default">默认等宽字体</NativeSelectOption><NativeSelectOption value="system">系统等宽字体</NativeSelectOption></NativeSelect></Field>
              {numeric('fontSize', '字号', 10, 24, 1)}{numeric('lineHeight', '行高', 1, 2, .05)}{numeric('scrollback', '回滚行数', 1000, 50_000, 1000)}
              <Field><FieldLabel htmlFor="setting-cursor">光标样式</FieldLabel>
                <NativeSelect id="setting-cursor" value={draft.cursorStyle} onChange={(e) => {
                  const style = e.target.value; if (style === 'block' || style === 'bar' || style === 'underline') patch('cursorStyle', style)
                }}><NativeSelectOption value="block">块状</NativeSelectOption><NativeSelectOption value="underline">下划线</NativeSelectOption><NativeSelectOption value="bar">竖线</NativeSelectOption></NativeSelect></Field>
              {toggle('cursorBlink', '光标闪烁')}
            </FieldGroup></FieldSet>
          </TabsContent>
          <TabsContent value="terminal" className="m-0 max-w-2xl">
            <FieldSet disabled={busy}><FieldLegend className="sr-only">终端</FieldLegend><FieldGroup>
              {toggle('copyOnSelect', '选中即复制')}{toggle('confirmMultiline', '多行粘贴确认')}{toggle('confirmClose', '关闭运行中标签确认')}
            </FieldGroup></FieldSet>
          </TabsContent>
          <TabsContent value="sessions" className="m-0 max-w-2xl">
            <FieldSet disabled={busy}><FieldLegend className="sr-only">会话</FieldLegend><FieldGroup>
              <Field><FieldLabel htmlFor="setting-shell">Shell</FieldLabel><NativeSelect id="setting-shell" value={draft.shell} onChange={(e) => {
                const shell = platformShells(snapshot.platform).find((item) => item === e.target.value); if (shell) patch('shell', shell)
              }}>{platformShells(snapshot.platform).map((shell) => <NativeSelectOption key={shell} value={shell}>{shell === 'default' ? '系统默认' : shell}</NativeSelectOption>)}</NativeSelect></Field>
              <Field><FieldLabel>默认起始目录</FieldLabel><p className="break-all text-sm text-muted-foreground">{draft.directory || '用户主目录'}</p>
                <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => {
                  void window.novaDirectories?.pick().then((directory) => { if (directory) patch('directory', directory) }).catch(() => setError('无法选择目录。'))
                }}>选择目录</Button><Button type="button" variant="ghost" onClick={() => patch('directory', '')}>使用主目录</Button></div></Field>
              {numeric('maxSessions', '最大会话数', 1, 8, 1)}{toggle('confirmExit', '退出确认')}
            </FieldGroup></FieldSet>
          </TabsContent>
        </div>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <Separator />
        <div className="flex shrink-0 justify-end gap-2 px-5 py-4 sm:px-8"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>{busy ? '保存中…' : '保存设置'}</Button></div>
      </form>
    </Tabs>
  </section>
}
