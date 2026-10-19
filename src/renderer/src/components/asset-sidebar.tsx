import { useId, useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, FolderOpenIcon, SearchIcon, ServerIcon, XIcon } from 'lucide-react'
import { AssetCreateDialog } from '@/components/asset-create-dialog'
import { SshConnectionDialog } from '@/components/ssh-connection-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Separator } from '@/components/ui/separator'
import { MAX_ASSETS, appendAsset, assetTree, loadAssets, saveAssets, type AssetDraft, type AssetNode } from '@/lib/assets'
import type { SshOptions } from '@shared/terminal-protocol'

export function AssetSidebar({ atLimit, onConnect }: { atLimit: boolean; onConnect: (options: SshOptions) => boolean }) {
  const [initial] = useState(() => {
    try { return loadAssets(window.localStorage) }
    catch { return { assets: [], error: '无法访问浏览器存储，请检查存储权限后刷新页面。' } }
  })
  const [assets, setAssets] = useState(initial.assets)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const id = useId()
  const nodes = assetTree(assets, query)
  const save = (draft: AssetDraft): string | null => {
    const next = appendAsset(assets, draft, crypto.randomUUID())
    if (!next) return `无法保存，请检查所属分组和配置；资产最多 ${MAX_ASSETS} 项。`
    try { saveAssets(window.localStorage, next) }
    catch { return '保存失败，请检查浏览器存储权限或可用空间，配置尚未保存。' }
    setAssets(next)
    setCollapsed(new Set())
    setQuery('')
    return null
  }

  const renderNodes = (items: AssetNode[]) => (
    <ul className="flex min-w-0 flex-col gap-0.5">
      {items.map(({ asset, children }) => {
        if (asset.kind === 'connection') return (
          <li key={asset.id} className="min-w-0">
            <SshConnectionDialog disabled={atLimit} endpoint={asset} onConnect={onConnect} trigger={
              <Button variant="ghost" className="w-full justify-start gap-2" disabled={atLimit}
                title={atLimit ? '终端数量已达上限，请先关闭一个标签' : `${asset.name} · ${asset.username}@${asset.host}:${asset.port}`}
                aria-label={`连接 ${asset.name}`}>
                <ServerIcon data-icon="inline-start" />
                <span className="truncate">{asset.name}</span>
              </Button>
            } />
          </li>
        )
        const open = !collapsed.has(asset.id)
        const childId = `${id}-${asset.id}`
        return (
          <li key={asset.id} className="min-w-0">
            <Button variant="ghost" className="w-full justify-start gap-2" aria-expanded={open} aria-controls={childId} title={asset.name}
              onClick={() => setCollapsed((current) => {
                const next = new Set(current)
                if (next.has(asset.id)) next.delete(asset.id)
                else next.add(asset.id)
                return next
              })}>
              {open ? <ChevronDownIcon data-icon="inline-start" /> : <ChevronRightIcon data-icon="inline-start" />}
              {open ? <FolderOpenIcon /> : <FolderIcon />}
              <span className="truncate">{asset.name}</span>
            </Button>
            <div id={childId} hidden={!open} className="ml-4 border-l pl-1">
              {children.length > 0 ? renderNodes(children) : <p className="px-3 py-2 text-xs text-muted-foreground">空分组</p>}
            </div>
          </li>
        )
      })}
    </ul>
  )

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground sm:w-64" aria-label="资产">
      <div className="flex shrink-0 flex-col gap-2 p-3">
        <InputGroup>
          <InputGroupInput type="search" placeholder="搜索连接和分组" aria-label="搜索连接和分组" value={query} maxLength={253}
            onChange={(event) => { setQuery(event.target.value); setCollapsed(new Set()) }} />
          <InputGroupAddon><SearchIcon aria-hidden="true" /></InputGroupAddon>
          {query && <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" aria-label="清除搜索" onClick={() => setQuery('')}><XIcon /></InputGroupButton></InputGroupAddon>}
        </InputGroup>
        <div className="flex items-center gap-1" aria-label="资产操作">
          <AssetCreateDialog kind="connection" assets={assets} disabled={!!initial.error || assets.length >= MAX_ASSETS} onSave={save} />
          <AssetCreateDialog kind="group" assets={assets} disabled={!!initial.error || assets.length >= MAX_ASSETS} onSave={save} />
          <span className="ml-auto text-xs text-muted-foreground">资产</span>
        </div>
      </div>
      <Separator />
      <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="连接和分组">
        {initial.error ? <Alert variant="destructive"><AlertDescription>{initial.error}</AlertDescription></Alert>
          : nodes.length > 0 ? renderNodes(nodes) : (
            <Empty className="px-2 py-8" role="status">
              <EmptyHeader>
                <EmptyTitle>{query.trim() ? '未找到匹配项' : '暂无连接和分组'}</EmptyTitle>
                <EmptyDescription>{query.trim() ? '尝试其他名称、主机或用户名。' : '使用上方按钮添加连接或分组。'}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
      </nav>
    </aside>
  )
}
