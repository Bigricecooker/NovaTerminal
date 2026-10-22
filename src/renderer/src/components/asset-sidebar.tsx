import { useId, useRef, useState, type DragEvent } from 'react'
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, FolderOpenIcon, FolderPlusIcon, FolderInputIcon, PencilIcon, PlusIcon, SearchIcon, ServerIcon, TerminalIcon, TrashIcon, XIcon, DownloadIcon, UploadIcon } from 'lucide-react'
import { cn } from 'cn'
import { AssetCreateDialog } from '@/components/asset-create-dialog'
import { AssetEditDialog } from '@/components/asset-edit-dialog'
import { AssetActionDialog, type AssetAction } from '@/components/asset-action-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Separator } from '@/components/ui/separator'
import { MAX_ASSETS, MAX_GROUP_DEPTH, appendAsset, assetTree, editConnection, groupOptions, initialAssetView, loadAssetWorkspace, moveAsset, normalizeAssetView, saveAssetWorkspace, viewAfterAppend, type Asset, type AssetConnection, type AssetDraft, type AssetNode, type AssetView, type ConnectionAsset, type ConnectionDraft } from '@/lib/assets'
import { parseLocalDirectory, type SshOptions } from '@shared/terminal-protocol'
import { mergeConnections, type ImportPreview } from '@shared/connection-transfer'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'

const ASSET_DRAG = 'application/x-novaterminal-asset'

export function AssetSidebar({ atLimit, onConnect, onOpenLocal, onAssetsChange }: {
  atLimit: boolean; onConnect: (connection: AssetConnection) => boolean; onOpenLocal: (directory: string, name: string, assetId?: string) => boolean
  onAssetsChange: (assets: Asset[]) => void
}) {
  const [initial] = useState(() => {
    try { return loadAssetWorkspace(window.localStorage) }
    catch { return { assets: [], view: initialAssetView, error: '无法访问本机存储，请检查存储权限后刷新页面。' } }
  })
  const [workspace, setWorkspace] = useState({ assets: initial.assets, view: initial.view })
  const { assets, view } = workspace
  const [query, setQuery] = useState('')
  const [searchCollapsed, setSearchCollapsed] = useState(new Set<string>())
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [transferBusy, setTransferBusy] = useState(false)
  const [preview, setPreview] = useState<{ data: ImportPreview; original: Asset[] } | null>(null)
  const [importError, setImportError] = useState('')
  const transferPending = useRef(false)
  const [creating, setCreating] = useState<{ kind: 'group' | 'connection'; parentId: string | null } | null>(null)
  const [picking, setPicking] = useState(false)
  const pickerPending = useRef(false)
  const [action, setAction] = useState<AssetAction | null>(null)
  const [editing, setEditing] = useState<ConnectionAsset | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const dragging = useRef<string | null>(null)
  const dialogPending = useRef(false)
  const id = useId()
  const nodes = assetTree(assets, query)
  const searching = Boolean(query.trim())
  const atAssetLimit = assets.length >= MAX_ASSETS
  const depths = new Map(groupOptions(assets).map((group) => [group.id, group.depth]))
  const canAddGroup = (parentId: string | null) => parentId === null || (depths.get(parentId) ?? MAX_GROUP_DEPTH) < MAX_GROUP_DEPTH

  const persist = (next: Asset[], nextView: AssetView): string | null => {
    if (initial.error) return initial.error
    const safeView = normalizeAssetView(next, nextView)
    try { saveAssetWorkspace(window.localStorage, next, safeView) }
    catch { return '保存失败，请检查本机存储权限或可用空间；原有配置和展开状态保持不变。' }
    setWorkspace({ assets: next, view: safeView })
    onAssetsChange(next)
    setError('')
    return null
  }
  const transfer = async (kind: 'import' | 'export') => {
    if (initial.error || transferPending.current) return
    transferPending.current = true; setTransferBusy(true); setError('')
    try {
      if (!window.novaConnections) throw new Error('连接文件服务不可用。')
      if (kind === 'export') {
        const saved = await window.novaConnections.write(JSON.stringify({ version: 1, assets }))
        if (saved) setStatus('连接配置已导出，不含密码、私钥、口令或凭据引用。')
      } else {
        const result = await window.novaConnections.read()
        if (result) {
          const data = mergeConnections(assets, result.document, () => crypto.randomUUID())
          setImportError(''); setPreview({ data: { ...data, orphaned: result.orphaned }, original: assets })
        }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '连接配置导入 / 导出失败。') }
    finally { transferPending.current = false; setTransferBusy(false) }
  }
  const updateView = (next: AssetView) => {
    const failure = persist(assets, next)
    if (failure) setError(failure)
  }
  const save = async (draft: AssetDraft, ssh?: { options: SshOptions; connect: boolean }, newId = crypto.randomUUID()): Promise<string | null> => {
    const next = appendAsset(assets, draft, newId)
    if (!next) return `无法保存，请检查所属分组和配置；资产最多 ${MAX_ASSETS} 项。`
    if (draft.kind === 'connection') {
      if (!ssh || !window.novaCredentials) return '无法保存 SSH 认证信息，请通过桌面应用重新添加连接。'
      try { await window.novaCredentials.save(newId, ssh.options) }
      catch { return '无法安全保存 SSH 认证信息，请检查系统密钥库是否可用及本机存储权限。' }
    }
    const failure = persist(next, viewAfterAppend(view, draft, newId))
    if (failure) {
      if (draft.kind === 'connection') {
        try { await window.novaCredentials?.remove([newId]) }
        catch { return `${failure} 加密认证信息清理失败，请检查本机存储权限。` }
      }
      return failure
    }
    setQuery('')
    setStatus(`已保存“${draft.name}”。`)
    if (draft.kind === 'connection' && ssh?.connect) onConnect({ ...draft, id: newId })
    return null
  }
  const edit = async (draft: ConnectionDraft, options?: SshOptions): Promise<string | null> => {
    if (!editing) return '连接已不存在，请重新打开编辑。'
    const previous = editing.kind === 'connection' ? editing.credentialId ?? editing.id : null
    const reference = options ? crypto.randomUUID() : previous
    const updated: ConnectionDraft = draft.kind === 'connection' && reference ? { ...draft, credentialId: reference } : draft
    const next = editConnection(assets, editing.id, updated)
    if (!next) return '无法保存，请检查名称、所属分组和连接配置。'
    if (options && reference) {
      if (!window.novaCredentials) return '无法保存 SSH 认证信息，请通过桌面应用编辑连接。'
      try { await window.novaCredentials.save(reference, options) }
      catch { return '无法安全保存 SSH 认证信息，请检查系统密钥库是否可用及本机存储权限。' }
    }
    const failure = persist(next, view)
    if (failure) {
      if (options && reference) {
        try { await window.novaCredentials?.remove([reference]) }
        catch { return `${failure} 新认证信息清理失败，请检查本机存储权限。` }
      }
      return failure
    }
    setQuery('')
    setStatus(`已更新“${draft.name}”。`)
    if (options && previous) {
      try { await window.novaCredentials?.remove([previous]) }
      catch { setError('连接已更新，但旧加密认证信息清理失败，请检查本机存储权限。') }
    }
    return null
  }
  const move = (source: string, parentId: string | null) => {
    const next = moveAsset(assets, source, parentId)
    if (!next) { setError('无法移入该位置：不能移入自身或子分组，分组层级最多 8 层。'); return }
    const failure = persist(next, view)
    if (failure) setError(failure)
    else setStatus(`已移动到${assets.find((asset) => asset.id === parentId)?.name ?? '资产列表顶层'}，保留原有排序。`)
  }
  const addLocal = async () => {
    if (pickerPending.current || atLimit || atAssetLimit || initial.error) return
    pickerPending.current = true; setPicking(true); setError('')
    try {
      if (!window.novaDirectories) throw new Error('Desktop directory API unavailable')
      const selected = await window.novaDirectories.pick()
      if (selected === null) return
      const directory = parseLocalDirectory(selected)
      if (!directory) throw new Error('Invalid directory')
      const name = (directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory).slice(0, 80)
      const localId = crypto.randomUUID()
      const draft = { kind: 'local', name, parentId: null, directory } as const
      const failure = await save(draft, undefined, localId)
      if (failure) { setError(failure); return }
      onOpenLocal(directory, name, localId)
    } catch { setError('无法选择本地目录，请重新尝试。') }
    finally { pickerPending.current = false; setPicking(false) }
  }
  const dragOver = (event: DragEvent<HTMLElement>, parentId: string | null, key: string) => {
    if (!dragging.current || !event.dataTransfer.types.includes(ASSET_DRAG)) return
    event.stopPropagation()
    const valid = moveAsset(assets, dragging.current, parentId) !== null
    event.dataTransfer.dropEffect = valid ? 'move' : 'none'
    if (valid) { event.preventDefault(); setDropTarget(key) }
    else setDropTarget(null)
  }
  const dragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget instanceof Node ? event.relatedTarget : null)) setDropTarget(null)
  }
  const dropAsset = (event: DragEvent<HTMLElement>, parentId: string | null) => {
    if (!dragging.current || !event.dataTransfer.types.includes(ASSET_DRAG)) return
    event.preventDefault(); event.stopPropagation()
    const source = dragging.current
    if (source && event.dataTransfer.getData(ASSET_DRAG) === source) move(source, parentId)
    dragging.current = null; setDropTarget(null)
  }
  const closeDialog = () => {
    const itemId = action?.id ?? editing?.id
    setCreating(null); setAction(null); setEditing(null); dialogPending.current = false
    requestAnimationFrame(() => {
      const target = itemId ? document.querySelector<HTMLElement>(`[data-asset-row="${itemId}"] button`) : null
      const fallback = document.querySelector<HTMLElement>('button[aria-label="添加连接"]')
      const focus = target?.getClientRects().length ? target : fallback
      focus?.focus()
    })
  }
  const startAction = (next: AssetAction) => { dialogPending.current = true; setAction(next) }
  const startCreate = (kind: 'group' | 'connection', parentId: string | null) => { dialogPending.current = true; setCreating({ kind, parentId }) }
  const toggle = (asset: Asset) => {
    if (searching) {
      setSearchCollapsed((current) => { const next = new Set(current); if (next.has(asset.id)) next.delete(asset.id); else next.add(asset.id); return next })
      return
    }
    const expandedIds = new Set(view.expandedIds)
    const open = expandedIds.has(asset.id)
    if (open) expandedIds.delete(asset.id)
    else expandedIds.add(asset.id)
    updateView({ expandedIds: [...expandedIds], currentGroupId: open ? asset.parentId : asset.id })
  }

  const renderNodes = (items: AssetNode[]) => (
    <ul className="flex min-w-0 flex-col gap-0.5">
      {items.map(({ asset, children }) => {
        const open = searching ? !searchCollapsed.has(asset.id) : view.expandedIds.includes(asset.id)
        const childId = `${id}-${asset.id}`
        const parentId = asset.kind === 'group' ? asset.id : asset.parentId
        return (
          <li key={asset.id} className="min-w-0" data-asset-id={asset.id}>
            <ContextMenu onOpenChange={(opened) => { if (opened) updateView({ ...view, currentGroupId: parentId }) }}>
              <ContextMenuTrigger asChild>
                <div data-asset-row={asset.id} draggable={!initial.error} tabIndex={asset.kind !== 'group' && atLimit ? 0 : undefined} className={cn('rounded-lg', dropTarget === asset.id && 'ring-2 ring-ring')}
                  onDragOver={(event) => dragOver(event, parentId, asset.id)} onDragLeave={dragLeave} onDrop={(event) => dropAsset(event, parentId)}
                  onDragStart={(event) => { dragging.current = asset.id; event.dataTransfer.setData(ASSET_DRAG, asset.id); event.dataTransfer.effectAllowed = 'move'; setStatus('') }}
                  onDragEnd={() => { dragging.current = null; setDropTarget(null) }}
                  onKeyDown={(event) => {
                    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
                      event.preventDefault()
                      const rect = event.currentTarget.getBoundingClientRect()
                      event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 16, clientY: rect.bottom }))
                    }
                  }}>
                  {asset.kind === 'connection' ? (
                    <Button variant="ghost" className="w-full justify-start gap-2" disabled={atLimit}
                      onClick={() => updateView({ ...view, currentGroupId: asset.parentId })}
                      onDoubleClick={() => onConnect(asset)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          if (!event.repeat) {
                            updateView({ ...view, currentGroupId: asset.parentId })
                            onConnect(asset)
                          }
                        }
                      }}
                      title={`${asset.username}@${asset.host}`} aria-label={`连接 ${asset.name}`}>
                      <ServerIcon data-icon="inline-start" /><span className="truncate">{asset.name}</span>
                    </Button>
                  ) : asset.kind === 'local' ? (
                    <Button variant="ghost" className="w-full justify-start gap-2" disabled={atLimit} aria-label={`连接 ${asset.name}`}
                      title={asset.directory}
                      onClick={() => updateView({ ...view, currentGroupId: asset.parentId })}
                      onDoubleClick={() => onOpenLocal(asset.directory, asset.name, asset.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          if (!event.repeat) { updateView({ ...view, currentGroupId: asset.parentId }); onOpenLocal(asset.directory, asset.name, asset.id) }
                        }
                      }}>
                      <TerminalIcon data-icon="inline-start" /><span className="truncate">{asset.name}</span>
                    </Button>
                  ) : (
                    <Button variant={view.currentGroupId === asset.id ? 'secondary' : 'ghost'} className="w-full justify-start gap-2" aria-expanded={open} aria-controls={childId} title={asset.name} onClick={() => toggle(asset)}>
                      {open ? <ChevronDownIcon data-icon="inline-start" /> : <ChevronRightIcon data-icon="inline-start" />}
                      {open ? <FolderOpenIcon /> : <FolderIcon />}<span className="truncate">{asset.name}</span>
                    </Button>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent onCloseAutoFocus={(event) => { if (dialogPending.current) event.preventDefault() }} collisionPadding={8}>
                {asset.kind === 'group' && <>
                  <ContextMenuGroup>
                    <ContextMenuItem disabled={atAssetLimit} onSelect={() => startCreate('connection', asset.id)}><PlusIcon />添加连接</ContextMenuItem>
                    <ContextMenuItem disabled={atAssetLimit || !canAddGroup(asset.id)} onSelect={() => startCreate('group', asset.id)}><FolderPlusIcon />添加子分组</ContextMenuItem>
                  </ContextMenuGroup>
                  <ContextMenuSeparator />
                </>}
                <ContextMenuGroup>
                  {asset.kind !== 'group' && <ContextMenuItem onSelect={() => { dialogPending.current = true; setEditing(asset) }}><PencilIcon />编辑</ContextMenuItem>}
                  <ContextMenuItem onSelect={() => startAction({ type: 'rename', id: asset.id })}><PencilIcon />重命名</ContextMenuItem>
                  <ContextMenuItem onSelect={() => startAction({ type: 'move', id: asset.id })}><FolderInputIcon />移动到…</ContextMenuItem>
                </ContextMenuGroup>
                <ContextMenuSeparator />
                <ContextMenuGroup><ContextMenuItem variant="destructive" onSelect={() => startAction({ type: 'delete', id: asset.id })}><TrashIcon />删除</ContextMenuItem></ContextMenuGroup>
              </ContextMenuContent>
            </ContextMenu>
            {asset.kind === 'group' && <div id={childId} hidden={!open} className="ml-4 border-l pl-1">
              {children.length ? renderNodes(children) : <p className="px-3 py-2 text-xs text-muted-foreground">空分组</p>}
            </div>}
          </li>
        )
      })}
    </ul>
  )

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground sm:w-64" aria-label="资产">
      <div className="flex shrink-0 flex-col gap-2 p-3">
        <InputGroup>
          <InputGroupInput type="search" placeholder="搜索连接和分组" aria-label="搜索连接和分组" value={query} maxLength={253} onChange={(event) => { setQuery(event.target.value); setSearchCollapsed(new Set()) }} />
          <InputGroupAddon><SearchIcon aria-hidden="true" /></InputGroupAddon>
          {query && <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" aria-label="清除搜索" onClick={() => setQuery('')}><XIcon /></InputGroupButton></InputGroupAddon>}
        </InputGroup>
        <div className="flex items-center gap-1" aria-label="资产操作">
          <Button variant="ghost" size="icon-sm" aria-label="添加连接" title="添加连接" disabled={!!initial.error || atAssetLimit} onClick={() => startCreate('connection', null)}><PlusIcon /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="添加本地连接" title={atLimit ? '终端数量已达上限，请先关闭一个标签' : '添加本地连接'} disabled={!!initial.error || atAssetLimit || atLimit || picking} onClick={() => { void addLocal() }}><TerminalIcon /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="添加分组" title="添加分组" disabled={!!initial.error || atAssetLimit || !canAddGroup(view.currentGroupId)} onClick={() => startCreate('group', view.currentGroupId)}><FolderPlusIcon /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="导入连接配置" title="导入连接配置" disabled={!!initial.error || transferBusy} onClick={() => { void transfer('import') }}><DownloadIcon /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="导出连接配置" title="导出连接配置（不含认证信息）" disabled={!!initial.error || transferBusy} onClick={() => { void transfer('export') }}><UploadIcon /></Button>
          <span className="ml-auto truncate text-xs text-muted-foreground" title={assets.find((asset) => asset.id === view.currentGroupId)?.name ?? '顶层'}>{assets.find((asset) => asset.id === view.currentGroupId)?.name ?? '顶层'}</span>
        </div>
      </div>
      <Separator />
      <nav className={cn('min-h-0 flex-1 overflow-y-auto p-2', dropTarget === 'top-level:' && 'ring-2 ring-inset ring-ring')} aria-label="连接和分组"
        onClick={(event) => { if (event.target === event.currentTarget) updateView({ ...view, currentGroupId: null }) }}
        onDragOver={(event) => dragOver(event, null, 'top-level:')} onDragLeave={dragLeave} onDrop={(event) => dropAsset(event, null)}>
        {(initial.error || error) && <Alert variant="destructive"><AlertDescription>{initial.error || error}</AlertDescription></Alert>}
        {!initial.error && <>
          {renderNodes(nodes)}
          {!searching && !nodes.length && <Empty className="px-2 py-8" role="status"><EmptyHeader>
            <EmptyTitle>暂无资产</EmptyTitle>
            <EmptyDescription>添加连接、本地连接或分组。</EmptyDescription>
          </EmptyHeader></Empty>}
          {searching && !nodes.length && <Empty className="px-2 py-8" role="status"><EmptyHeader>
            <EmptyTitle>未找到匹配项</EmptyTitle>
            <EmptyDescription>尝试其他名称、目录、主机或用户名。</EmptyDescription>
          </EmptyHeader></Empty>}
        </>}
      </nav>
      <p role="status" className="shrink-0 px-3 py-1 text-xs text-muted-foreground">{status}</p>
      <Dialog open={preview !== null} onOpenChange={(open) => { if (!open) setPreview(null) }}>
        <DialogContent><DialogHeader><DialogTitle>导入连接配置</DialogTitle><DialogDescription>合并到当前配置，不覆盖已有连接。导入不含认证信息，SSH 连接需编辑后补充认证。</DialogDescription></DialogHeader>
          <p>新增 {preview?.data.connections} 个连接、{preview?.data.groups} 个分组，生成 {preview?.data.regenerated} 个新标识。</p>
          {!!preview?.data.orphaned && <p>有 {preview.data.orphaned} 项找不到上级分组，将放到顶层。</p>}
          {importError && <Alert variant="destructive"><AlertDescription>{importError}</AlertDescription></Alert>}
          <DialogFooter><Button variant="outline" onClick={() => setPreview(null)}>取消</Button><Button onClick={() => {
            if (!preview) return
            if (assets !== preview.original) { setImportError('配置已变化，请取消后重新导入。'); return }
            const failure = persist(preview.data.assets, view)
            if (failure) { setImportError(failure); return }
            setStatus(`已导入 ${preview.data.connections} 个连接；SSH 连接请编辑补充认证。`)
            setPreview(null); setQuery('')
          }}>确认导入</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      {creating && <AssetCreateDialog kind={creating.kind} parentId={creating.parentId} assets={assets} disabled={!!initial.error || atAssetLimit} atLimit={atLimit} onSave={save} onClose={closeDialog} />}
      {editing && <AssetEditDialog asset={editing} assets={assets} onSave={edit} onClose={closeDialog} />}
      {action && <AssetActionDialog action={action} assets={assets} onSave={async (next) => {
        const removed = assets.flatMap((asset) => asset.kind === 'connection' && !next.some((item) => item.id === asset.id) ? [asset.credentialId ?? asset.id] : [])
        const failure = persist(next, view)
        if (failure) return failure
        if (removed.length) {
          try {
            if (!window.novaCredentials) throw new Error('Desktop credential API unavailable')
            await window.novaCredentials.remove(removed)
          } catch { setError('资产已删除，但加密认证信息清理失败，请检查本机存储权限。') }
        }
        return null
      }} onClose={closeDialog} />}
    </aside>
  )
}
