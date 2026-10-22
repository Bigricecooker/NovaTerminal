import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { parseSettings, platformShells, type Settings, type SettingsSnapshot } from '@shared/settings'
import { composing } from '@shared/terminal-interactions'

export function SettingsDialog({ snapshot, onClose, onSave }: {
  snapshot: SettingsSnapshot; onClose: () => void; onSave: (values: Settings) => Promise<void>
}) {
  const [draft, setDraft] = useState(snapshot.values)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
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
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-xl" onEscapeKeyDown={(event) => { if (busy || composing(event)) event.preventDefault() }}>
      <DialogHeader><DialogTitle>设置</DialogTitle><DialogDescription>保存后应用偏好；Shell 与起始目录用于新会话。</DialogDescription></DialogHeader>
      <form className="flex min-h-0 flex-col gap-4" onSubmit={(event) => {
        event.preventDefault()
        if (busy) return
        setError(''); setBusy(true)
        void Promise.resolve().then(() => onSave(parseSettings(draft, snapshot.platform))).then(onClose)
          .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '无法保存设置。')).finally(() => setBusy(false))
      }}>
        <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto px-1">
          <FieldGroup className="min-w-0 [&_fieldset]:min-w-0">
            <FieldSet><FieldLegend>外观</FieldLegend><FieldGroup>
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
            <FieldSet><FieldLegend>终端</FieldLegend><FieldGroup>
              {toggle('copyOnSelect', '选中即复制')}{toggle('confirmMultiline', '多行粘贴确认')}{toggle('confirmClose', '关闭运行中标签确认')}
            </FieldGroup></FieldSet>
            <FieldSet><FieldLegend>会话</FieldLegend><FieldGroup>
              <Field><FieldLabel htmlFor="setting-shell">Shell</FieldLabel><NativeSelect id="setting-shell" value={draft.shell} onChange={(e) => {
                const shell = platformShells(snapshot.platform).find((item) => item === e.target.value); if (shell) patch('shell', shell)
              }}>{platformShells(snapshot.platform).map((shell) => <NativeSelectOption key={shell} value={shell}>{shell === 'default' ? '系统默认' : shell}</NativeSelectOption>)}</NativeSelect></Field>
              <Field><FieldLabel>默认起始目录</FieldLabel><p className="break-all text-sm text-muted-foreground">{draft.directory || '用户主目录'}</p>
                <div className="flex gap-2"><Button type="button" variant="outline" onClick={() => {
                  void window.novaDirectories?.pick().then((directory) => { if (directory) patch('directory', directory) }).catch(() => setError('无法选择目录。'))
                }}>选择目录</Button><Button type="button" variant="ghost" onClick={() => patch('directory', '')}>使用主目录</Button></div></Field>
              {numeric('maxSessions', '最大会话数', 1, 8, 1)}{toggle('confirmExit', '退出确认')}
            </FieldGroup></FieldSet>
          </FieldGroup>
        </div>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>{busy ? '保存中…' : '保存设置'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
