import { useId, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { assetSubtreeIds, deleteAsset, groupOptions, moveAsset, renameAsset, type Asset } from '@/lib/assets'

export type AssetAction = { type: 'rename' | 'move' | 'delete'; id: string }

export function AssetActionDialog({ action, assets, onSave, onClose }: {
  action: AssetAction; assets: Asset[]; onSave: (assets: Asset[]) => Promise<string | null>; onClose: () => void
}) {
  const [error, setError] = useState('')
  const id = useId()
  const asset = assets.find((item) => item.id === action.id)
  if (!asset) return null
  const save = async (next: Asset[] | null) => {
    const failure = next ? await onSave(next) : '无法修改，请检查名称、所属分组或层级限制。'
    if (failure) { setError(failure); return }
    onClose()
  }
  if (action.type === 'delete') return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除“{asset.name}”？</AlertDialogTitle>
          <AlertDialogDescription>
            {asset.kind === 'group' ? `将同时删除其中的 ${assetSubtreeIds(assets, asset.id).size - 1} 项连接和分组。` : '将删除这项已保存的连接配置。'}
            此操作无法撤销，已打开的终端会话不受影响。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <FieldError>{error}</FieldError>}
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={(event) => { event.preventDefault(); save(deleteAsset(assets, asset.id)) }}>删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
  const title = action.type === 'rename' ? '重命名' : '移动到分组'
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = new FormData(event.currentTarget).get('value')
    if (typeof value !== 'string') return
    save(action.type === 'rename' ? renameAsset(assets, asset.id, value) : moveAsset(assets, asset.id, value || null))
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{action.type === 'rename' ? `修改“${asset.name}”的名称。` : `移动“${asset.name}”，继续使用原有排序规则。`}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={id}>{action.type === 'rename' ? '名称' : '所属分组'}</FieldLabel>
              {action.type === 'rename' ? <Input id={id} name="value" defaultValue={asset.name} required maxLength={80} autoFocus /> : (
                <NativeSelect id={id} name="value" defaultValue={asset.parentId ?? ''} autoFocus>
                  <NativeSelectOption value="">{asset.kind === 'group' ? '无上级分组' : '未分组'}</NativeSelectOption>
                  {groupOptions(assets).filter((group) => moveAsset(assets, asset.id, group.id) !== null).map((group) => (
                    <NativeSelectOption key={group.id} value={group.id}>{group.label}</NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline" type="button">取消</Button></DialogClose>
            <Button type="submit">保存</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
