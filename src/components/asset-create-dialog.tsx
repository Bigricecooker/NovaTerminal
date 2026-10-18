import { useId, useState, type FormEvent } from 'react'
import { FolderPlusIcon, PlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { MAX_GROUP_DEPTH, groupOptions, type Asset, type AssetDraft } from '@/lib/assets'
import { parseSshEndpoint } from '@/lib/terminal-protocol'

export function AssetCreateDialog({ kind, assets, disabled, onSave }: {
  kind: Asset['kind']; assets: Asset[]; disabled: boolean
  onSave: (draft: AssetDraft) => string | null
}) {
  const [open, setOpen] = useState(false)
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
    let draft: AssetDraft
    if (kind === 'group') draft = { ...base, kind }
    else {
      const endpoint = parseSshEndpoint({ host: text('host'), port: Number(text('port')), username: text('username') })
      if (!endpoint) { setError('请检查主机、端口和用户名。主机只填写域名或 IP。'); return }
      draft = { ...base, kind, ...endpoint }
    }
    const failure = onSave(draft)
    if (failure) { setError(failure); return }
    form.reset()
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={(value) => { setOpen(value); setError('') }}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" title={title} aria-label={title} disabled={disabled}>
          {kind === 'group' ? <FolderPlusIcon /> : <PlusIcon />}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{kind === 'group' ? '使用分组整理连接，也可以创建子分组。' : '保存连接配置，连接时再填写密码或私钥。'}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-5" autoComplete="off">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>名称</FieldLabel>
              <Input id={`${id}-name`} name="name" required maxLength={80} autoFocus />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-parent`}>所属分组</FieldLabel>
              <NativeSelect id={`${id}-parent`} name="parentId" defaultValue="">
                <NativeSelectOption value="">根目录</NativeSelectOption>
                {groups.map((group) => <NativeSelectOption key={group.id} value={group.id}>{group.label}</NativeSelectOption>)}
              </NativeSelect>
            </Field>
            {kind === 'connection' && <>
              <Field>
                <FieldLabel htmlFor={`${id}-host`}>主机</FieldLabel>
                <Input id={`${id}-host`} name="host" placeholder="域名或 IP 地址" required maxLength={253} autoCapitalize="none" spellCheck={false} />
                <FieldDescription>不包含 ssh://、用户名或路径。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-port`}>端口</FieldLabel>
                <Input id={`${id}-port`} name="port" type="number" min={1} max={65535} defaultValue={22} required />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-username`}>用户名</FieldLabel>
                <Input id={`${id}-username`} name="username" required maxLength={128} autoCapitalize="none" spellCheck={false} />
              </Field>
            </>}
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline">取消</Button></DialogClose>
            <Button type="submit" disabled={disabled}>保存</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
