import { parseLocalDirectory, parseSshEndpoint, type SshEndpoint } from './terminal-protocol.ts'

export const ASSET_STORAGE_KEY = 'novaterminal.assets.v1'
export const MAX_ASSETS = 500
export const MAX_GROUP_DEPTH = 8
const MAX_DOCUMENT_SIZE = 524_288
export type AssetGroup = { kind: 'group'; id: string; name: string; parentId: string | null }
export type AssetConnection = { kind: 'connection'; id: string; name: string; parentId: string | null; credentialId?: string } & SshEndpoint
export type AssetLocalConnection = { kind: 'local'; id: string; name: string; parentId: string | null; directory: string }
export type Asset = AssetGroup | AssetConnection | AssetLocalConnection
export type AssetDraft = Omit<AssetGroup, 'id'> | Omit<AssetConnection, 'id'> | Omit<AssetLocalConnection, 'id'>
export type ConnectionAsset = AssetConnection | AssetLocalConnection
export type ConnectionDraft = Omit<AssetConnection, 'id'> | Omit<AssetLocalConnection, 'id'>
export type AssetNode = { asset: Asset; children: AssetNode[] }
export type AssetView = { expandedIds: string[]; currentGroupId: string | null }
export const initialAssetView: AssetView = { expandedIds: [], currentGroupId: null }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value)
}

// Reconstruct only public configuration fields; never retain credentials or unknown keys.
export function parseAssetDocument(value: unknown): Asset[] | null {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.assets) || value.assets.length > MAX_ASSETS) return null
  const assets: Asset[] = []
  for (const item of value.assets) {
    if (!record(item) || !validId(item.id) || typeof item.name !== 'string'
      || !item.name.trim() || item.name.length > 80
      || Array.from(item.name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      || (item.parentId !== null && !validId(item.parentId))) return null
    const base = { id: item.id, name: item.name.trim(), parentId: item.parentId }
    if (item.kind === 'group') assets.push({ ...base, kind: 'group' })
    else if (item.kind === 'connection') {
      const endpoint = parseSshEndpoint(item)
      if (!endpoint || item.credentialId !== undefined && !validId(item.credentialId)) return null
      assets.push({ ...base, kind: 'connection', ...endpoint, ...(item.credentialId !== undefined ? { credentialId: item.credentialId } : {}) })
    } else if (item.kind === 'local') {
      const directory = parseLocalDirectory(item.directory)
      if (!directory) return null
      assets.push({ ...base, kind: 'local', directory })
    } else return null
  }
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  if (byId.size !== assets.length) return null
  const references = assets.filter((asset) => asset.kind === 'connection').map((asset) => asset.credentialId ?? asset.id)
  if (new Set(references).size !== references.length) return null
  for (const asset of assets) {
    let current: Asset = asset
    const visited = new Set([asset.id])
    let depth = asset.kind === 'group' ? 1 : 0
    while (current.parentId !== null) {
      const parent = byId.get(current.parentId)
      if (!parent || parent.kind !== 'group' || visited.has(parent.id) || ++depth > MAX_GROUP_DEPTH) return null
      visited.add(parent.id)
      current = parent
    }
  }
  return assets
}

export function appendAsset(assets: Asset[], draft: AssetDraft, id: string): Asset[] | null {
  return parseAssetDocument({ version: 1, assets: [...assets, { ...draft, id }] })
}

export function renameAsset(assets: Asset[], id: string, name: string): Asset[] | null {
  if (!assets.some((asset) => asset.id === id)) return null
  return parseAssetDocument({ version: 1, assets: assets.map((asset) => asset.id === id ? { ...asset, name } : asset) })
}

export function editConnection(assets: Asset[], id: string, draft: ConnectionDraft): Asset[] | null {
  const original = assets.find((asset) => asset.id === id)
  if (!original || original.kind === 'group' || original.kind !== draft.kind) return null
  return parseAssetDocument({ version: 1, assets: assets.map((asset) => asset.id === id ? { ...draft, id } : asset) })
}

export function moveAsset(assets: Asset[], id: string, parentId: string | null): Asset[] | null {
  if (!assets.some((asset) => asset.id === id)) return null
  // Validate the entire subtree at its new depth; array order remains creation order.
  return parseAssetDocument({ version: 1, assets: assets.map((asset) => asset.id === id ? { ...asset, parentId } : asset) })
}

export function assetSubtreeIds(assets: Asset[], id: string): Set<string> {
  const ids = new Set<string>()
  const visit = (parent: string) => {
    if (ids.has(parent)) return
    ids.add(parent)
    for (const asset of assets) if (asset.parentId === parent) visit(asset.id)
  }
  if (assets.some((asset) => asset.id === id)) visit(id)
  return ids
}

export function deleteAsset(assets: Asset[], id: string): Asset[] | null {
  const ids = assetSubtreeIds(assets, id)
  return ids.size ? assets.filter((asset) => !ids.has(asset.id)) : null
}

export function normalizeAssetView(assets: Asset[], value: unknown): AssetView {
  const groups = new Set(assets.filter((asset) => asset.kind === 'group').map((asset) => asset.id))
  if (!record(value)) return { ...initialAssetView, expandedIds: [] }
  const expandedIds = Array.isArray(value.expandedIds) && value.expandedIds.length <= MAX_ASSETS
    ? [...new Set(value.expandedIds.filter((id): id is string => typeof id === 'string' && groups.has(id)))] : []
  return { expandedIds, currentGroupId: typeof value.currentGroupId === 'string' && groups.has(value.currentGroupId) ? value.currentGroupId : null }
}

export function viewAfterAppend(view: AssetView, draft: AssetDraft, id: string): AssetView {
  if (draft.parentId !== view.currentGroupId) return view
  const expandedIds = new Set(view.expandedIds)
  if (draft.parentId !== null) expandedIds.add(draft.parentId)
  if (draft.kind === 'group') expandedIds.add(id)
  return { ...view, expandedIds: [...expandedIds] }
}

export function assetTree(assets: Asset[], query: string): AssetNode[] {
  const term = query.trim().toLocaleLowerCase()
  const children = new Map<string | null, Asset[]>()
  for (const asset of assets) children.set(asset.parentId, [...(children.get(asset.parentId) ?? []), asset])
  const visit = (parentId: string | null, includeAll: boolean): AssetNode[] => {
    const result: AssetNode[] = []
    // Stable ordering: folders first, then connections, preserving creation order within each.
    const siblings = (children.get(parentId) ?? []).toSorted((a, b) => Number(b.kind === 'group') - Number(a.kind === 'group'))
    for (const asset of siblings) {
      const text = asset.kind === 'group' ? asset.name : asset.kind === 'local' ? `${asset.name} ${asset.directory}` : `${asset.name} ${asset.host} ${asset.username} ${asset.port}`
      const matches = includeAll || text.toLocaleLowerCase().includes(term)
      const nested = asset.kind === 'group' ? visit(asset.id, matches) : []
      if (matches || nested.length > 0) result.push({ asset, children: nested })
    }
    return result
  }
  return visit(null, !term)
}

export function groupOptions(assets: Asset[]): { id: string; label: string; depth: number }[] {
  const result: { id: string; label: string; depth: number }[] = []
  const visit = (nodes: AssetNode[], path: string[], depth: number) => {
    for (const { asset, children } of nodes) {
      if (asset.kind !== 'group') continue
      const names = [...path, asset.name]
      result.push({ id: asset.id, label: names.join(' / '), depth })
      visit(children, names, depth + 1)
    }
  }
  visit(assetTree(assets, ''), [], 1)
  return result
}

export function loadAssets(storage: Pick<Storage, 'getItem'>): { assets: Asset[]; error: string } {
  const { assets, error } = loadAssetWorkspace(storage)
  return { assets, error }
}

export function loadAssetWorkspace(storage: Pick<Storage, 'getItem'>): { assets: Asset[]; view: AssetView; error: string } {
  try {
    const raw = storage.getItem(ASSET_STORAGE_KEY)
    if (raw === null) return { assets: [], view: normalizeAssetView([], null), error: '' }
    if (raw.length > MAX_DOCUMENT_SIZE) throw new Error('Too large')
    const value: unknown = JSON.parse(raw)
    const assets = parseAssetDocument(value)
    if (!assets) throw new Error('Invalid asset document')
    return { assets, view: normalizeAssetView(assets, record(value) ? value.sidebar : null), error: '' }
  } catch {
    return { assets: [], view: normalizeAssetView([], null), error: '无法读取本机资产配置。为避免覆盖已有数据，已暂停修改；请检查本机存储权限或资产数据。' }
  }
}

export function saveAssets(storage: Pick<Storage, 'setItem'>, assets: Asset[]): void {
  saveAssetWorkspace(storage, assets, initialAssetView)
}

export function saveAssetWorkspace(storage: Pick<Storage, 'setItem'>, assets: Asset[], view: AssetView): void {
  const safe = parseAssetDocument({ version: 1, assets })
  if (!safe) throw new Error('Invalid asset document')
  const raw = JSON.stringify({ version: 1, assets: safe, sidebar: normalizeAssetView(safe, view) })
  if (raw.length > MAX_DOCUMENT_SIZE) throw new Error('Asset document too large')
  storage.setItem(ASSET_STORAGE_KEY, raw)
}
