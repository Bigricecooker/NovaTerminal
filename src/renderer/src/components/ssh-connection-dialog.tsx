import { useState, type FormEvent, type ReactElement } from 'react'
import { sshOptionsFromForm } from '@/lib/ssh-form'
import { SshConnectionFields } from '@/components/ssh-connection-fields'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { FieldError, FieldGroup } from '@/components/ui/field'
import type { SshEndpoint, SshOptions } from '@shared/terminal-protocol'

export function SshConnectionDialog({ disabled, onConnect, endpoint, trigger }: {
  disabled: boolean
  onConnect: (options: SshOptions) => boolean
  endpoint: SshEndpoint
  trigger: ReactElement
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const options = sshOptionsFromForm(data)
    if (!options) { setError('请检查主机、端口、用户名及认证信息。主机只填写域名或 IP，不包含 ssh:// 或路径。'); return }
    if (!onConnect(options)) { setError('终端数量已达上限，请先关闭一个标签。'); return }
    form.reset()
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={(value) => { setOpen(value); setError('') }}>
      <DialogTrigger asChild>
        {trigger}
      </DialogTrigger>
      <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-lg"
        // Portal events must not activate the asset row's drag or context menu handlers.
        onContextMenu={(event) => event.stopPropagation()}
        onDragStart={(event) => event.stopPropagation()}
        onDragOver={(event) => event.stopPropagation()}
        onDrop={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') event.stopPropagation() }}>
        <DialogHeader className="shrink-0">
          <DialogTitle>连接 SSH 服务器</DialogTitle>
          <DialogDescription>新建独立远端终端。首次连接需核对主机指纹，密码和私钥不会保存。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} autoComplete="off" className="flex min-h-0 flex-col gap-5">
          <FieldGroup className="-mx-1 min-h-0 overflow-y-auto px-1 py-1">
            <SshConnectionFields endpoint={endpoint} />
          </FieldGroup>
          {error && <FieldError className="shrink-0">{error}</FieldError>}
          <DialogFooter className="shrink-0">
            <DialogClose asChild><Button type="button" variant="outline">取消</Button></DialogClose>
            <Button type="submit" disabled={disabled}>连接</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
