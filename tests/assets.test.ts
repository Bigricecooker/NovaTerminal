import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ASSET_STORAGE_KEY, MAX_ASSETS, MAX_GROUP_DEPTH, appendAsset, assetSubtreeIds, assetTree, deleteAsset, editConnection, groupOptions, initialAssetView, loadAssets, loadAssetWorkspace, moveAsset, normalizeAssetView, parseAssetDocument, renameAsset, saveAssets, saveAssetWorkspace, viewAfterAppend, type Asset } from '../src/renderer/src/lib/assets.ts'

const assets: Asset[] = [
  { kind: 'group', id: 'prod', name: '生产环境', parentId: null },
  { kind: 'group', id: 'asia', name: '亚洲', parentId: 'prod' },
  { kind: 'connection', id: 'api', name: 'API', parentId: 'asia', host: 'api.example.test', port: 22, username: 'deploy' },
  { kind: 'connection', id: 'db', name: '数据库', parentId: 'prod', host: 'db.example.test', port: 2222, username: 'ops' },
  { kind: 'group', id: 'test', name: '测试环境', parentId: null },
  { kind: 'connection', id: 'root', name: '独立服务器', parentId: null, host: '127.0.0.1', port: 22, username: 'user' },
]
const document = (entries: unknown) => ({ version: 1, assets: entries })

test('editing connections preserves identity and order while validating config and credential references', () => {
  const draft = { kind: 'connection', name: '新 API', parentId: 'test', host: 'NEW.EXAMPLE.TEST', port: 2222, username: 'new-user', credentialId: 'revision-one' } as const
  const edited = editConnection(assets, 'api', draft)
  assert.ok(edited)
  assert.deepEqual(edited.map((asset) => asset.id), assets.map((asset) => asset.id))
  assert.deepEqual(edited[2], { ...draft, id: 'api', host: 'new.example.test' })
  assert.equal(assets[2]?.name, 'API')
  let raw = ''
  saveAssets({ setItem: (_key, value) => { raw = value } }, edited)
  assert.deepEqual(loadAssets({ getItem: () => raw }).assets, edited)
  for (const invalid of [{ name: ' ' }, { port: 0 }, { parentId: 'missing' }, { credentialId: '../escape' }, { credentialId: 'db' }]) {
    assert.equal(editConnection(assets, 'api', { ...draft, ...invalid }), null)
  }
  assert.equal(editConnection(assets, 'prod', draft), null)
  assert.equal(editConnection(assets, 'missing', draft), null)
  assert.equal(editConnection(assets, 'api', { kind: 'local', name: 'local', parentId: null, directory: '/work' }), null)
  const local = appendAsset(assets, { kind: 'local', name: '工作', parentId: null, directory: '/old' }, 'local')
  assert.ok(local)
  assert.equal(editConnection(local, 'local', { kind: 'local', name: '新工作', parentId: 'prod', directory: '/new' })?.at(-1)?.name, '新工作')
  assert.equal(editConnection(local, 'local', { kind: 'local', name: '工作', parentId: null, directory: 'relative' }), null)
})

test('ungrouped SSH and local connections stay top-level after folders across moves and reloads', () => {
  const local = { kind: 'local', name: '工作目录', parentId: null, directory: '/work' } as const
  const withLocal = appendAsset(assets, local, 'local')
  assert.ok(withLocal)
  const ssh = { kind: 'connection', name: '新增连接', parentId: null, host: 'host.test', port: 22, username: 'user' } as const
  const created = appendAsset(withLocal, ssh, 'ssh')
  assert.ok(created)
  const grouped = moveAsset(created, 'local', 'asia')
  assert.ok(grouped)
  const ungrouped = moveAsset(grouped, 'local', null)
  assert.ok(ungrouped)
  const moved = moveAsset(ungrouped, 'api', null)
  assert.ok(moved)
  let raw = ''
  saveAssetWorkspace({ setItem: (_key, value) => { raw = value } }, moved, { expandedIds: ['prod'], currentGroupId: null })
  const restored = loadAssetWorkspace({ getItem: () => raw })
  assert.equal(restored.error, '')
  assert.equal(restored.assets.length, assets.length + 2, 'No synthetic group is persisted')
  assert.deepEqual(restored.assets.filter((asset) => asset.kind === 'group'), assets.filter((asset) => asset.kind === 'group'))
  const top = assetTree(restored.assets, '')
  assert.deepEqual(top.map(({ asset }) => asset.id), ['prod', 'test', 'api', 'root', 'local', 'ssh'])
  assert.ok(top.every(({ asset }) => asset.parentId === null))
  assert.ok(top.filter(({ asset }) => asset.kind !== 'group').every(({ children }) => children.length === 0))
})

test('local connections share grouping, search and persistence without storing unknown fields', () => {
  const local = { kind: 'local', id: 'local', name: '工作目录', parentId: null, directory: 'C:\\work\\项目 目录' } as const
  const parsed = parseAssetDocument(document([...assets, { ...local, password: 'secret' }]))
  assert.ok(parsed)
  assert.deepEqual(parsed.at(-1), local)
  const moved = moveAsset(parsed, 'local', 'asia')
  assert.ok(moved)
  assert.equal(assetTree(moved, '项目 目录')[0]?.children[0]?.children[0]?.asset.id, 'local')
  assert.equal(renameAsset(moved, 'local', '新名称')?.at(-1)?.name, '新名称')
  assert.ok(!deleteAsset(moved, 'prod')?.some((asset) => asset.id === 'local'))
  let raw = ''
  saveAssetWorkspace({ setItem: (_key, value) => { raw = value } }, moved, initialAssetView)
  assert.deepEqual(loadAssetWorkspace({ getItem: () => raw }).assets, moved)
  assert.ok(!raw.includes('secret'))
  for (const directory of ['', 'relative/path', 'C:relative', '/bad\npath', '/bad\0path', '/'.repeat(4097)]) {
    assert.equal(parseAssetDocument(document([{ ...local, directory }])), null)
  }
  const large: Asset[] = Array.from({ length: 150 }, (_, i) => ({ ...local, id: `local${i}`, directory: `/${'x'.repeat(4000)}` }))
  const before = raw
  assert.throws(() => saveAssets({ setItem: (_key, value) => { raw = value } }, large), /too large/)
  assert.equal(raw, before, 'An oversized document must not replace readable saved assets')
})

test('asset document normalizes public fields and strips credentials and unknown properties', () => {
  const result = parseAssetDocument(document([{ ...assets[2], parentId: null, host: 'API.EXAMPLE.TEST', name: ' API ', auth: { password: 'secret' }, privateKey: 'key', passphrase: 'phrase' }]))
  assert.deepEqual(result, [{ kind: 'connection', id: 'api', name: 'API', parentId: null, host: 'api.example.test', port: 22, username: 'deploy' }])
  assert.equal(parseAssetDocument(document(assets))?.length, assets.length)
})

test('asset document rejects invalid endpoints, names, ids, duplicate ids, parents and cycles', () => {
  const invalid: unknown[] = [
    [{ ...assets[2], parentId: null, host: 'ssh://host' }],
    [{ ...assets[2], parentId: null, port: 0 }],
    [{ ...assets[2], parentId: null, username: 'a b' }],
    [{ ...assets[0], name: ' ' }], [{ ...assets[0], name: 'a\nb' }], [{ ...assets[0], id: '../file' }],
    [assets[0], assets[0]], [assets[1]],
    [{ ...assets[0], parentId: 'prod' }],
    [{ ...assets[0], parentId: 'asia' }, assets[1]],
    [assets[5], { ...assets[0], parentId: 'root' }],
    [{ ...assets[0], kind: 'unknown' }],
  ]
  for (const entries of invalid) assert.equal(parseAssetDocument(document(entries)), null)
  assert.equal(parseAssetDocument({ version: 2, assets: [] }), null)
})

test('asset creation enforces count and nesting bounds while allowing root connections and deepest-group connections', () => {
  const groups: Asset[] = Array.from({ length: MAX_GROUP_DEPTH }, (_, i) => ({ kind: 'group', id: `g${i}`, name: `分组${i}`, parentId: i === 0 ? null : `g${i - 1}` }))
  assert.ok(appendAsset(groups, { kind: 'connection', name: '服务器', host: 'host.test', port: 22, username: 'user', parentId: `g${MAX_GROUP_DEPTH - 1}` }, 'conn'))
  assert.equal(appendAsset(groups, { kind: 'group', name: '过深', parentId: `g${MAX_GROUP_DEPTH - 1}` }, 'extra'), null)
  assert.equal(appendAsset(assets, { kind: 'group', name: '不存在的父项', parentId: 'missing' }, 'extra'), null)
  const full: Asset[] = Array.from({ length: MAX_ASSETS }, (_, i) => ({ kind: 'group', id: `g${i}`, name: '分组', parentId: null }))
  assert.equal(appendAsset(full, { kind: 'group', name: '超限', parentId: null }, 'extra'), null)
  assert.deepEqual(assets.map((asset) => asset.id), ['prod', 'asia', 'api', 'db', 'test', 'root'])
})

test('search keeps only matching connections and ancestors, supports host/user/port and ignores case and whitespace', () => {
  for (const query of [' API ', 'API.EXAMPLE', 'deploy']) {
    const tree = assetTree(assets, query)
    assert.equal(tree.length, 1)
    assert.equal(tree[0]?.asset.id, 'prod')
    assert.equal(tree[0]?.children[0]?.asset.id, 'asia')
    assert.deepEqual(tree[0]?.children[0]?.children.map((node) => node.asset.id), ['api'])
  }
  assert.equal(assetTree(assets, '2222')[0]?.children[0]?.asset.id, 'db')
  assert.equal(assetTree(assets, '127.0.0.1')[0]?.asset.id, 'root')
  assert.deepEqual(assetTree(assets, '不存在'), [])
})

test('matching groups include descendants; empty groups and unfiltered folder order remain visible', () => {
  const tree = assetTree(assets, '生产')
  assert.deepEqual(tree[0]?.children.map((node) => node.asset.id), ['asia', 'db'])
  assert.equal(tree[0]?.children[0]?.children[0]?.asset.id, 'api')
  assert.equal(assetTree(assets, '测试')[0]?.asset.id, 'test')
  assert.deepEqual(assetTree(assets, ' ').map((node) => node.asset.id), ['prod', 'test', 'root'])
  assert.deepEqual(groupOptions(assets), [
    { id: 'prod', label: '生产环境', depth: 1 },
    { id: 'asia', label: '生产环境 / 亚洲', depth: 2 },
    { id: 'test', label: '测试环境', depth: 1 },
  ])
})

test('storage round-trip persists only validated public configuration and reports corrupt or inaccessible storage', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  assert.deepEqual(loadAssets(storage), { assets: [], error: '' })
  saveAssets(storage, assets)
  assert.deepEqual(loadAssets(storage), { assets, error: '' })
  const withSecrets = [{ ...assets[2], parentId: null, password: 'do-not-persist', privateKey: 'do-not-persist' }]
  const safe = parseAssetDocument(document(withSecrets))
  assert.ok(safe)
  saveAssets(storage, safe)
  assert.ok(!values.get(ASSET_STORAGE_KEY)?.includes('do-not-persist'))
  for (const raw of ['invalid json', '{"version":9,"assets":[]}', 'x'.repeat(524_289)]) {
    values.set(ASSET_STORAGE_KEY, raw)
    const result = loadAssets(storage)
    assert.deepEqual(result.assets, [])
    assert.ok(result.error)
    assert.equal(values.get(ASSET_STORAGE_KEY), raw)
  }
  assert.ok(loadAssets({ getItem: () => { throw new Error('Denied') } }).error)
  assert.throws(() => saveAssets({ setItem: () => { throw new Error('Quota') } }, assets), /Quota/)
})

test('renaming preserves identity, endpoint, hierarchy and creation order with validated names', () => {
  const renamed = renameAsset(assets, 'api', '  API 服务  ')
  assert.ok(renamed)
  assert.deepEqual(renamed.map((asset) => asset.id), assets.map((asset) => asset.id))
  assert.deepEqual(renamed.find((asset) => asset.id === 'api'), { ...assets[2], name: 'API 服务' })
  for (const name of [' ', 'x'.repeat(81), 'bad\nname']) assert.equal(renameAsset(assets, 'api', name), null)
  assert.equal(renameAsset(assets, 'missing', '名称'), null)
  assert.equal(assets[2]?.name, 'API')
})

test('moving assets changes only parentage and retains folders-first creation order', () => {
  const moved = moveAsset(assets, 'api', null)
  assert.ok(moved)
  assert.deepEqual(moved.map((asset) => asset.id), assets.map((asset) => asset.id))
  assert.deepEqual(assetTree(moved, '').map((node) => node.asset.id), ['prod', 'test', 'api', 'root'])
  assert.equal(assets[2]?.parentId, 'asia')
  for (const [id, parent] of [['prod', 'asia'], ['prod', 'prod'], ['asia', 'api'], ['api', 'missing'], ['missing', null]] as const) {
    assert.equal(moveAsset(assets, id, parent), null)
  }
})

test('moving a group validates its complete subtree depth while permitting deepest connections', () => {
  const groups: Asset[] = Array.from({ length: MAX_GROUP_DEPTH }, (_, i) => ({ kind: 'group', id: `g${i}`, name: '分组', parentId: i ? `g${i - 1}` : null }))
  const branch: Asset[] = [...groups, { kind: 'group', id: 'branch', name: '分支', parentId: null }, { kind: 'group', id: 'child', name: '子分组', parentId: 'branch' }, { kind: 'connection', id: 'c', name: '连接', parentId: null, host: 'host.test', port: 22, username: 'user' }]
  assert.equal(moveAsset(branch, 'branch', 'g6'), null)
  assert.ok(moveAsset(branch, 'branch', 'g5'))
  assert.ok(moveAsset(branch, 'c', 'g7'))
})

test('deleting a subtree removes its descendants and only their sidebar state', () => {
  assert.deepEqual([...assetSubtreeIds(assets, 'prod')].sort(), ['api', 'asia', 'db', 'prod'])
  const remaining = deleteAsset(assets, 'prod')
  assert.ok(remaining)
  assert.deepEqual(remaining.map((asset) => asset.id), ['test', 'root'])
  assert.deepEqual(normalizeAssetView(remaining, { expandedIds: ['prod', 'asia', 'test'], currentGroupId: 'asia' }), { expandedIds: ['test'], currentGroupId: null })
  assert.deepEqual(deleteAsset(assets, 'api')?.map((asset) => asset.id), ['prod', 'asia', 'db', 'test', 'root'])
  assert.equal(deleteAsset(assets, 'missing'), null)
  assert.equal(assets.length, 6)
})

test('new assets expand only their current branch and never reset unrelated folded groups', () => {
  const view = { expandedIds: ['prod'], currentGroupId: 'asia' }
  const draft = { kind: 'group', name: '新分组', parentId: 'asia' } as const
  assert.deepEqual(viewAfterAppend(view, draft, 'new'), { expandedIds: ['prod', 'asia', 'new'], currentGroupId: 'asia' })
  assert.equal(viewAfterAppend(view, { ...draft, parentId: 'test' }, 'new'), view)
  assert.deepEqual(view.expandedIds, ['prod'])
  assert.deepEqual(viewAfterAppend(initialAssetView, { ...draft, parentId: null }, 'new').expandedIds, ['new'])
  assert.deepEqual(viewAfterAppend(view, { kind: 'connection', name: '新连接', parentId: 'asia', host: 'host.test', port: 22, username: 'user' }, 'c').expandedIds, ['prod', 'asia'])
})

test('legacy assets start collapsed; workspace saves hierarchy and filtered view together without secrets', () => {
  let raw = JSON.stringify(document(assets))
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value } }
  assert.deepEqual(loadAssetWorkspace(storage).view, initialAssetView)
  const moved = moveAsset(assets, 'api', 'test')
  assert.ok(moved)
  saveAssetWorkspace(storage, moved, { expandedIds: ['prod', 'prod', 'api', 'missing', 'test'], currentGroupId: 'test' })
  assert.deepEqual(loadAssetWorkspace(storage), { assets: moved, view: { expandedIds: ['prod', 'test'], currentGroupId: 'test' }, error: '' })
  const saved = raw
  assert.throws(() => saveAssetWorkspace({ setItem: () => { throw new Error('Quota') } }, assets, initialAssetView), /Quota/)
  assert.equal(raw, saved)
  raw = JSON.stringify({ ...document(assets), sidebar: { expandedIds: ['prod'], currentGroupId: 'api', password: 'secret' } })
  assert.deepEqual(loadAssetWorkspace(storage).view, { expandedIds: ['prod'], currentGroupId: null })
  saveAssetWorkspace(storage, assets, loadAssetWorkspace(storage).view)
  assert.ok(!raw.includes('secret'))
  raw = JSON.stringify({ ...document(assets), sidebar: { expandedIds: Array(501).fill('prod') } })
  assert.deepEqual(loadAssetWorkspace(storage).view, initialAssetView)
})
