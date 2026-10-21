import { useId, useRef, useState, type FormEvent } from 'react'
import { SshConnectionFields } from '@/components/ssh-connection-fields'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { groupOptions, type Asset, type ConnectionAsset, type ConnectionDraft } from '@/lib/assets'
import { sshOptionsFromForm } from '@/lib/ssh-form'
import { parseLocalDirectory, parseSshEndpoint, type SshOptions } from '@shared/terminal-protocol'

export function AssetEditDialog({ asset, assets, onSave, onClose }: {
  asset: ConnectionAsset; assets: Asset[]
  onSave: (draft: ConnectionDraft, options?: SshOptions) => Promise<string | null>
  onClose: () => void
}) {
  const id = useId()
  const pending = useRef(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending.current) return
    const form = event.currentTarget
    const data = new FormData(form)
    const text = (name: string) => { const value = data.get(name); return typeof value === 'string' ? value.trim() : '' }
    const base = { name: text('name'), parentId: text('parentId') || null }
    let draft: ConnectionDraft
    let options: SshOptions | undefined
    if (asset.kind === 'local') {
      const directory = parseLocalDirectory(data.get('directory'))
      if (!directory) { setError('请输入有效的绝对目录路径。'); return }
      draft = { ...base, kind: 'local', directory }
    } else {
      const endpoint = parseSshEndpoint({ host: text('host'), port: Number(text('port')), username: text('username') })
      if (!endpoint) { setError('请检查主机、端口和用户名。'); return }
      if (text('authMethod') !== 'keep') {
        options = sshOptionsFromForm(data) ?? undefined
        if (!options) { setError('请检查密码或私钥认证信息。'); return }
      } else if (endpoint.host !== asset.host || endpoint.port !== asset.port || endpoint.username !== asset.username) {
        setError('修改主机、端口或用户名后，请重新填写密码或私钥。'); return
      }
      draft = { ...base, kind: 'connection', ...endpoint }
    }
    pending.current = true; setSaving(true)
    try {
      const failure = await onSave(draft, options)
      if (failure) { setError(failure); return }
      form.reset(); onClose()
    } catch { setError('保存连接失败，请检查系统安全存储和本机存储后重试。') }
    finally { pending.current = false; setSaving(false) }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending.current) onClose() }}>
      <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>编辑连接</DialogTitle>
          <DialogDescription>保存后更新连接配置和名称；已打开的会话继续使用原配置，新配置用于下次连接。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} autoComplete="off" className="flex min-h-0 flex-col gap-5">
          <FieldGroup className="-mx-1 min-h-0 overflow-y-auto px-1 py-1">
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>名称</FieldLabel>
              <Input id={`${id}-name`} name="name" defaultValue={asset.name} required maxLength={80} autoFocus />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-parent`}>所属分组</FieldLabel>
              <NativeSelect id={`${id}-parent`} name="parentId" defaultValue={asset.parentId ?? ''}>
                <NativeSelectOption value="">未分组</NativeSelectOption>
                {groupOptions(assets).map((group) => <NativeSelectOption key={group.id} value={group.id}>{group.label}</NativeSelectOption>)}
              </NativeSelect>
            </Field>
            {asset.kind === 'connection' ? <SshConnectionFields endpoint={asset} allowKeepAuth /> : <Field>
              <FieldLabel htmlFor={`${id}-directory`}>起始目录</FieldLabel>
              <Input id={`${id}-directory`} name="directory" defaultValue={asset.directory} required maxLength={4096} spellCheck={false} />
            </Field>}
          </FieldGroup>
          {error && <FieldError className="shrink-0">{error}</FieldError>}
          <DialogFooter className="shrink-0">
            <DialogClose asChild><Button type="button" variant="outline" disabled={saving}>取消</Button></DialogClose>
            <Button type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
