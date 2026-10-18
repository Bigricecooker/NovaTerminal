import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ASSET_STORAGE_KEY, MAX_ASSETS, MAX_GROUP_DEPTH, appendAsset, assetTree, groupOptions, loadAssets, parseAssetDocument, saveAssets, type Asset } from '../src/lib/assets.ts'

const assets: Asset[] = [
  { kind: 'group', id: 'prod', name: '生产环境', parentId: null },
  { kind: 'group', id: 'asia', name: '亚洲', parentId: 'prod' },
  { kind: 'connection', id: 'api', name: 'API', parentId: 'asia', host: 'api.example.test', port: 22, username: 'deploy' },
  { kind: 'connection', id: 'db', name: '数据库', parentId: 'prod', host: 'db.example.test', port: 2222, username: 'ops' },
  { kind: 'group', id: 'test', name: '测试环境', parentId: null },
  { kind: 'connection', id: 'root', name: '独立服务器', parentId: null, host: '127.0.0.1', port: 22, username: 'user' },
]
const document = (entries: unknown) => ({ version: 1, assets: entries })

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
