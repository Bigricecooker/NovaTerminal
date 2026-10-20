import { useId, useState, type FormEvent } from 'react'
import { sshOptionsFromForm } from '@/lib/ssh-form'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { SshConnectionFields } from '@/components/ssh-connection-fields'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { MAX_GROUP_DEPTH, groupOptions, type Asset, type AssetDraft } from '@/lib/assets'
import { parseSshEndpoint, type SshOptions } from '@shared/terminal-protocol'

export function AssetCreateDialog({ kind, assets, disabled, atLimit, onConnect, onSave, parentId, onClose }: {
  kind: 'group' | 'connection'; assets: Asset[]; disabled: boolean; atLimit: boolean
  onConnect: (options: SshOptions) => boolean
  onSave: (draft: AssetDraft) => string | null
  parentId: string | null; onClose: () => void
}) {
  const [error, setError] = useState('')
  const id = useId()
  const title = kind === 'group' ? '添加分组' : '添加连接'
  const groups = groupOptions(assets).filter((group) => kind !== 'group' || group.depth < MAX_GROUP_DEPTH)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const text = (name: string) => { const value = data.get(name); return typeof value === 'string' ? value.trim() : '' }
    const name = text('name')
    if (!name || Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) { setError('请输入有效名称。'); return }
    const base = { name, parentId: text('parentId') || null }
    const connecting = kind === 'connection' && (event.nativeEvent instanceof SubmitEvent && event.nativeEvent.submitter?.getAttribute('value') !== 'save')
    const options = connecting ? sshOptionsFromForm(data) : null
    if (connecting && !options) { setError('请检查主机、端口、用户名及认证信息。'); return }
    if (connecting && atLimit) { setError('终端数量已达上限，请先关闭一个标签，或仅保存配置。'); return }
    let draft: AssetDraft
    if (kind === 'group') draft = { ...base, kind }
    else {
      const endpoint = parseSshEndpoint({ host: text('host'), port: Number(text('port')), username: text('username') })
      if (!endpoint) { setError('请检查主机、端口和用户名。主机只填写域名或 IP。'); return }
      draft = { ...base, kind, ...endpoint }
    }
    const failure = onSave(draft)
    if (failure) { setError(failure); return }
    if (options) onConnect(options)
    form.reset()
    onClose()
  }

  return (
    <Dialog open onOpenChange={(value) => { if (!value) onClose() }}>
      <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{kind === 'group' ? '使用分组整理连接，也可以创建子分组。' : '保存 SSH 配置并打开远端终端。首次连接需核对主机指纹，密码和私钥不会保存；也可仅保存配置。'}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-col gap-5" autoComplete="off">
          <FieldGroup className="-mx-1 min-h-0 overflow-y-auto px-1 py-1">
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>名称</FieldLabel>
              <Input id={`${id}-name`} name="name" required maxLength={80} autoFocus />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-parent`}>{kind === 'group' ? '上级分组' : '所属分组'}</FieldLabel>
              <NativeSelect id={`${id}-parent`} name="parentId" defaultValue={parentId ?? ''}>
                <NativeSelectOption value="">{kind === 'group' ? '无上级分组' : '未分组'}</NativeSelectOption>
                {groups.map((group) => <NativeSelectOption key={group.id} value={group.id}>{group.label}</NativeSelectOption>)}
              </NativeSelect>
            </Field>
            {kind === 'connection' && <SshConnectionFields required={false} />}
          </FieldGroup>
          {error && <FieldError className="shrink-0">{error}</FieldError>}
          <DialogFooter className="shrink-0">
            <DialogClose asChild><Button type="button" variant="outline">取消</Button></DialogClose>
            <Button className="sm:order-last" type="submit" value="connect" disabled={disabled || kind === 'connection' && atLimit}>{kind === 'group' ? '保存' : '保存并连接'}</Button>
            {kind === 'connection' && <Button type="submit" value="save" variant="outline" disabled={disabled}>仅保存</Button>}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
