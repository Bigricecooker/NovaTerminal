import { parseSshEndpoint, type SshEndpoint } from '../../../shared/terminal-protocol.ts'

export const ASSET_STORAGE_KEY = 'novaterminal.assets.v1'
export const MAX_ASSETS = 500
export const MAX_GROUP_DEPTH = 8
export type AssetGroup = { kind: 'group'; id: string; name: string; parentId: string | null }
export type AssetConnection = { kind: 'connection'; id: string; name: string; parentId: string | null } & SshEndpoint
export type Asset = AssetGroup | AssetConnection
export type AssetDraft = Omit<AssetGroup, 'id'> | Omit<AssetConnection, 'id'>
export type AssetNode = { asset: Asset; children: AssetNode[] }

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
      if (!endpoint) return null
      assets.push({ ...base, kind: 'connection', ...endpoint })
    } else return null
  }
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  if (byId.size !== assets.length) return null
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

export function assetTree(assets: Asset[], query: string): AssetNode[] {
  const term = query.trim().toLocaleLowerCase()
  const children = new Map<string | null, Asset[]>()
  for (const asset of assets) children.set(asset.parentId, [...(children.get(asset.parentId) ?? []), asset])
  const visit = (parentId: string | null, includeAll: boolean): AssetNode[] => {
    const result: AssetNode[] = []
    // Stable ordering: folders first, then connections, preserving creation order within each.
    const siblings = (children.get(parentId) ?? []).toSorted((a, b) => Number(b.kind === 'group') - Number(a.kind === 'group'))
    for (const asset of siblings) {
      const text = asset.kind === 'group' ? asset.name : `${asset.name} ${asset.host} ${asset.username} ${asset.port}`
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
  try {
    const raw = storage.getItem(ASSET_STORAGE_KEY)
    if (raw === null) return { assets: [], error: '' }
    if (raw.length > 524_288) throw new Error('Too large')
    const value: unknown = JSON.parse(raw)
    const assets = parseAssetDocument(value)
    if (!assets) throw new Error('Invalid asset document')
    return { assets, error: '' }
  } catch {
    return { assets: [], error: '无法读取本机资产配置。为避免覆盖已有数据，已暂停新增；请检查浏览器存储权限或资产数据。' }
  }
}

export function saveAssets(storage: Pick<Storage, 'setItem'>, assets: Asset[]): void {
  const safe = parseAssetDocument({ version: 1, assets })
  if (!safe) throw new Error('Invalid asset document')
  storage.setItem(ASSET_STORAGE_KEY, JSON.stringify({ version: 1, assets: safe }))
}
