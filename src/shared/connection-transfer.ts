import { MAX_ASSETS, parseAssetDocument, assetTree, type Asset } from './assets.ts'
import { record } from './settings.ts'

export const MAX_TRANSFER_BYTES = 1_048_576
export type ConnectionExport = { format: 'novaterminal.connections'; version: 1; exportedAt: string; groups: Asset[]; connections: Asset[] }
export type ImportPreview = { assets: Asset[]; connections: number; groups: number; regenerated: number; orphaned: number }

export function exportConnections(assets: Asset[], date = new Date()): ConnectionExport {
  const safe = parseAssetDocument({ version: 1, assets })
  if (!safe) throw new Error('连接配置无效。')
  const ordered: Asset[] = []
  const visit = (nodes: ReturnType<typeof assetTree>) => { for (const node of nodes) { ordered.push(node.asset); visit(node.children) } }
  visit(assetTree(safe, ''))
  const publicAssets = ordered.map((asset): Asset => {
    const base = { id: asset.id, name: asset.name, parentId: asset.parentId }
    if (asset.kind === 'group') return { ...base, kind: 'group' }
    if (asset.kind === 'local') return { ...base, kind: 'local', directory: asset.directory }
    return { ...base, kind: 'connection', host: asset.host, port: asset.port, username: asset.username }
  })
  return { format: 'novaterminal.connections', version: 1, exportedAt: date.toISOString(), groups: publicAssets.filter((item) => item.kind === 'group'), connections: publicAssets.filter((item) => item.kind !== 'group') }
}
export function parseConnectionImport(raw: unknown): { assets: Asset[]; orphaned: number } {
  if (!record(raw) || raw.format !== 'novaterminal.connections' || raw.version !== 1 || !Array.isArray(raw.groups) || !Array.isArray(raw.connections)
    || raw.groups.length + raw.connections.length > MAX_ASSETS) throw new Error('导入文件格式、版本或条目数量无效。')
  if (!raw.groups.every((item: unknown) => record(item) && item.kind === 'group')
    || !raw.connections.every((item: unknown) => record(item) && (item.kind === 'connection' || item.kind === 'local'))) throw new Error('导入条目类型无效。')
  const items: unknown[] = [...raw.groups, ...raw.connections]
  const ids = new Set(items.filter(record).map((item) => item.id))
  let orphaned = 0
  const normalized = items.map((item) => {
    if (!record(item)) return item
    let parentId = item.parentId
    if (typeof parentId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(parentId) && !ids.has(parentId)) { parentId = null; orphaned++ }
    const base = { kind: item.kind, id: item.id, name: item.name, parentId }
    if (item.kind === 'group') return base
    if (item.kind === 'local') return { ...base, directory: item.directory }
    return { ...base, host: item.host, port: item.port, username: item.username, needsAuthentication: true }
  })
  const assets = parseAssetDocument({ version: 1, assets: normalized })
  if (!assets) throw new Error('导入条目非法、ID 重复、分组循环或层级超过限制。')
  return { assets, orphaned }
}
export function mergeConnections(existing: Asset[], raw: unknown, makeId: () => string): ImportPreview {
  if (!parseAssetDocument({ version: 1, assets: existing })) throw new Error('现有配置无效。')
  const imported = parseConnectionImport(raw)
  const merged = [...existing]
  const mapping = new Map<string, string>()
  const byId = new Map(imported.assets.map((item) => [item.id, item]))
  let groups = 0
  const resolveGroup = (id: string): string => {
    const known = mapping.get(id)
    if (known) return known
    const source = byId.get(id)
    if (!source || source.kind !== 'group') throw new Error('无效的上级分组。')
    const parentId = source.parentId === null ? null : resolveGroup(source.parentId)
    const match = merged.find((item) => item.kind === 'group' && item.parentId === parentId && item.name === source.name)
    const newId = match?.id ?? makeId()
    mapping.set(id, newId)
    if (!match) { merged.push({ ...source, id: newId, parentId }); groups++ }
    return newId
  }
  for (const asset of imported.assets) if (asset.kind === 'group') resolveGroup(asset.id)
  let connections = 0
  for (const asset of imported.assets) {
    if (asset.kind === 'group') continue
    merged.push({ ...asset, id: makeId(), parentId: asset.parentId === null ? null : resolveGroup(asset.parentId) })
    connections++
  }
  const assets = parseAssetDocument({ version: 1, assets: merged })
  if (!assets) throw new Error('导入后配置超过 500 项、8 层或存在重复标识。')
  if (JSON.stringify({ version: 1, assets, sidebar: { expandedIds: [], currentGroupId: null } }).length > 524_288) throw new Error('导入后资产文档过大。')
  return { assets, connections, groups, regenerated: groups + connections, orphaned: imported.orphaned }
}
