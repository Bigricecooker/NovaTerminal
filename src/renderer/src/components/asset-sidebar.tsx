import { useId, useRef, useState, type DragEvent } from 'react'
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, FolderOpenIcon, FolderPlusIcon, FolderInputIcon, PencilIcon, PlusIcon, SearchIcon, ServerIcon, TrashIcon, XIcon } from 'lucide-react'
import { cn } from 'cn'
import { AssetCreateDialog } from '@/components/asset-create-dialog'
import { AssetActionDialog, type AssetAction } from '@/components/asset-action-dialog'
import { SshConnectionDialog } from '@/components/ssh-connection-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Separator } from '@/components/ui/separator'
import { MAX_ASSETS, MAX_GROUP_DEPTH, appendAsset, assetTree, groupOptions, initialAssetView, loadAssetWorkspace, moveAsset, normalizeAssetView, saveAssetWorkspace, viewAfterAppend, type Asset, type AssetDraft, type AssetNode, type AssetView } from '@/lib/assets'
import type { SshOptions } from '@shared/terminal-protocol'

const ASSET_DRAG = 'application/x-novaterminal-asset'

export function AssetSidebar({ atLimit, onConnect }: { atLimit: boolean; onConnect: (options: SshOptions) => boolean }) {
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
  const [creating, setCreating] = useState<{ kind: Asset['kind']; parentId: string | null } | null>(null)
  const [action, setAction] = useState<AssetAction | null>(null)
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
    setError('')
    return null
  }
  const updateView = (next: AssetView) => {
    const failure = persist(assets, next)
    if (failure) setError(failure)
  }
  const save = (draft: AssetDraft): string | null => {
    const newId = crypto.randomUUID()
    const next = appendAsset(assets, draft, newId)
    if (!next) return `无法保存，请检查所属分组和配置；资产最多 ${MAX_ASSETS} 项。`
    const failure = persist(next, viewAfterAppend(view, draft, newId))
    if (failure) return failure
    setQuery('')
    setStatus(`已保存“${draft.name}”。`)
    return null
  }
  const move = (source: string, parentId: string | null) => {
    const next = moveAsset(assets, source, parentId)
    if (!next) { setError('无法移入该位置：不能移入自身或子分组，分组层级最多 8 层。'); return }
    const failure = persist(next, view)
    if (failure) setError(failure)
    else setStatus(`已移动到${assets.find((asset) => asset.id === parentId)?.name ?? '根目录'}，保留原有排序。`)
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
    const itemId = action?.id
    setCreating(null); setAction(null); dialogPending.current = false
    requestAnimationFrame(() => {
      const target = itemId ? document.querySelector<HTMLElement>(`[data-asset-row="${itemId}"] button`) : null
      const fallback = document.querySelector<HTMLElement>('button[aria-label="添加连接"]')
      const focus = target?.getClientRects().length ? target : fallback
      focus?.focus()
    })
  }
  const startAction = (next: AssetAction) => { dialogPending.current = true; setAction(next) }
  const startCreate = (kind: Asset['kind'], parentId: string | null) => { dialogPending.current = true; setCreating({ kind, parentId }) }
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
                <div data-asset-row={asset.id} draggable={!initial.error} tabIndex={asset.kind === 'connection' && atLimit ? 0 : undefined} className={cn('rounded-lg', dropTarget === asset.id && 'ring-2 ring-ring')}
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
                    <SshConnectionDialog disabled={atLimit} endpoint={asset} onConnect={onConnect} trigger={
                      <Button variant="ghost" className="w-full justify-start gap-2" disabled={atLimit}
                        onClick={() => updateView({ ...view, currentGroupId: asset.parentId })}
                        title={atLimit ? '终端数量已达上限，请先关闭一个标签' : `${asset.name} · ${asset.username}@${asset.host}:${asset.port}`} aria-label={`连接 ${asset.name}`}>
                        <ServerIcon data-icon="inline-start" /><span className="truncate">{asset.name}</span>
                      </Button>
                    } />
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
          <Button variant="ghost" size="icon-sm" aria-label="添加连接" title="添加连接" disabled={!!initial.error || atAssetLimit} onClick={() => startCreate('connection', view.currentGroupId)}><PlusIcon /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="添加分组" title="添加分组" disabled={!!initial.error || atAssetLimit || !canAddGroup(view.currentGroupId)} onClick={() => startCreate('group', view.currentGroupId)}><FolderPlusIcon /></Button>
          <span className="ml-auto truncate text-xs text-muted-foreground" title={assets.find((asset) => asset.id === view.currentGroupId)?.name ?? '根目录'}>{assets.find((asset) => asset.id === view.currentGroupId)?.name ?? '资产'}</span>
        </div>
      </div>
      <Separator />
      <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="连接和分组">
        {!initial.error && <div onDragOver={(event) => dragOver(event, null, 'root:')} onDragLeave={dragLeave} onDrop={(event) => dropAsset(event, null)} className={cn('mb-1 rounded-lg', dropTarget === 'root:' && 'ring-2 ring-ring')}>
          <Button variant="ghost" className="w-full justify-start" aria-label="资产根目录" onClick={() => updateView({ ...view, currentGroupId: null })}><FolderIcon data-icon="inline-start" />根目录</Button>
        </div>}
        {(initial.error || error) && <Alert variant="destructive"><AlertDescription>{initial.error || error}</AlertDescription></Alert>}
        {!initial.error && (nodes.length ? renderNodes(nodes) : <Empty className="px-2 py-8" role="status"><EmptyHeader>
          <EmptyTitle>{searching ? '未找到匹配项' : '暂无连接和分组'}</EmptyTitle>
          <EmptyDescription>{searching ? '尝试其他名称、主机或用户名。' : '使用上方按钮添加连接或分组。'}</EmptyDescription>
        </EmptyHeader></Empty>)}
      </nav>
      <p role="status" className="sr-only">{status}</p>
      {creating && <AssetCreateDialog kind={creating.kind} parentId={creating.parentId} assets={assets} disabled={!!initial.error || atAssetLimit} onSave={save} onClose={closeDialog} />}
      {action && <AssetActionDialog action={action} assets={assets} onSave={(next) => persist(next, view)} onClose={closeDialog} />}
    </aside>
  )
}
