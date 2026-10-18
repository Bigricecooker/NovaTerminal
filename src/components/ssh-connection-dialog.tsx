import { useId, useState, type FormEvent, type ReactElement } from 'react'
import { ServerIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { parseSshOptions, type SshEndpoint, type SshOptions } from '@/lib/terminal-protocol'

export function SshConnectionDialog({ disabled, onConnect, endpoint, trigger }: {
  disabled: boolean
  onConnect: (options: SshOptions) => boolean
  endpoint?: SshEndpoint
  trigger?: ReactElement
}) {
  const [open, setOpen] = useState(false)
  const [method, setMethod] = useState('password')
  const [error, setError] = useState('')
  const id = useId()

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const text = (name: string) => { const value = data.get(name); return typeof value === 'string' ? value : '' }
    const options = parseSshOptions({
      host: text('host').trim(), port: Number(text('port')), username: text('username').trim(),
      auth: method === 'password'
        ? { method, password: text('password') }
        : { method, privateKey: text('privateKey').trim(), passphrase: text('passphrase') },
    })
    if (!options) { setError('请检查主机、端口、用户名及认证信息。主机只填写域名或 IP，不包含 ssh:// 或路径。'); return }
    if (!onConnect(options)) { setError('终端数量已达上限，请先关闭一个标签。'); return }
    form.reset()
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={(value) => { setOpen(value); setError(''); setMethod('password') }}>
      <DialogTrigger asChild>
        {trigger ?? <Button variant="ghost" size="icon" disabled={disabled} aria-label="连接 SSH 服务器" title="连接 SSH 服务器">
          <ServerIcon />
        </Button>}
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>连接 SSH 服务器</DialogTitle>
          <DialogDescription>新建独立远端终端。首次连接需核对主机指纹，密码和私钥不会保存。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} autoComplete="off" className="flex flex-col gap-5">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-host`}>主机</FieldLabel>
              <Input id={`${id}-host`} name="host" required maxLength={253} defaultValue={endpoint?.host ?? ''} placeholder="域名或 IP 地址" autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-port`}>端口</FieldLabel>
              <Input id={`${id}-port`} name="port" type="number" required min={1} max={65535} defaultValue={endpoint?.port ?? 22} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-username`}>用户名</FieldLabel>
              <Input id={`${id}-username`} name="username" required maxLength={128} defaultValue={endpoint?.username ?? ''} autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-method`}>认证方式</FieldLabel>
              <NativeSelect id={`${id}-method`} value={method} onChange={(event) => { setMethod(event.target.value); setError('') }}>
                <NativeSelectOption value="password">密码</NativeSelectOption>
                <NativeSelectOption value="privateKey">私钥</NativeSelectOption>
              </NativeSelect>
            </Field>
            {method === 'password' ? (
              <Field>
                <FieldLabel htmlFor={`${id}-password`}>密码</FieldLabel>
                <Input id={`${id}-password`} name="password" type="password" required maxLength={4096} autoComplete="off" />
              </Field>
            ) : (
              <>
                <Field>
                  <FieldLabel htmlFor={`${id}-privateKey`}>私钥内容</FieldLabel>
                  <Textarea id={`${id}-privateKey`} name="privateKey" required maxLength={65536} rows={5} spellCheck={false} autoCapitalize="none" />
                  <FieldDescription>粘贴完整私钥内容，包括 BEGIN / END 行；不填写本机文件路径。</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-passphrase`}>私钥口令（可选）</FieldLabel>
                  <Input id={`${id}-passphrase`} name="passphrase" type="password" maxLength={4096} autoComplete="off" />
                </Field>
              </>
            )}
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline">取消</Button></DialogClose>
            <Button type="submit" disabled={disabled}>连接</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
