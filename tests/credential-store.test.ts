import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createCredentialStore, type CredentialProtector } from '../src/main/credential-store.ts'
import type { SavedSshConnection, SshOptions } from '../src/shared/terminal-protocol.ts'

const options: SshOptions = { host: 'server.invalid', port: 22, username: 'operator', auth: { method: 'password', password: 'never-store-plaintext' } }
const reference: SavedSshConnection = { assetId: 'server-one', host: options.host, port: options.port, username: options.username }
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-credentials-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const key = randomBytes(32)
  let available = true
  const protector: CredentialProtector = {
    available: () => available,
    encrypt: (value) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    decrypt: (value) => {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    },
  }
  return { directory, protector, store: createCredentialStore(directory, protector), lock: () => { available = false } }
}

test('credentials persist encrypted and survive store recreation for password and private-key auth', (t) => {
  const { store, directory, protector } = fixture(t)
  const privateOptions: SshOptions = { ...options, auth: { method: 'privateKey', privateKey: 'test-private-key', passphrase: 'test-passphrase' } }
  store.save(reference.assetId, options)
  store.save('key-server', privateOptions)
  const restored = createCredentialStore(directory, protector)
  assert.deepEqual(restored.load(reference), options)
  assert.deepEqual(restored.load({ ...reference, assetId: 'key-server' }), privateOptions)
  assert.deepEqual(readdirSync(directory).sort(), ['asset-key-server.bin', 'asset-server-one.bin'])
  for (const name of readdirSync(directory)) {
    const raw = readFileSync(join(directory, name)).toString('utf8')
    for (const secret of ['never-store-plaintext', 'test-private-key', 'test-passphrase']) assert.ok(!raw.includes(secret))
  }
  const before = readFileSync(join(directory, 'asset-server-one.bin'))
  assert.throws(() => store.save(reference.assetId, privateOptions), /无法安全保存/)
  assert.deepEqual(readFileSync(join(directory, 'asset-server-one.bin')), before)
  assert.deepEqual(store.load(reference), options)
})

test('credential lookup binds asset id to endpoint and fails closed on missing or damaged records', (t) => {
  const { store, directory } = fixture(t)
  store.save(reference.assetId, options)
  for (const altered of [{ host: 'other.invalid' }, { port: 2222 }, { username: 'other' }, { assetId: 'missing' }]) {
    assert.throws(() => store.load({ ...reference, ...altered }), /缺失、损坏或与端点不匹配/)
  }
  const file = join(directory, 'asset-server-one.bin')
  const encrypted = readFileSync(file)
  encrypted.writeUInt8(encrypted.readUInt8(encrypted.length - 1) ^ 1, encrypted.length - 1)
  writeFileSync(file, encrypted)
  assert.throws(() => store.load(reference), /缺失、损坏/)
  writeFileSync(file, Buffer.alloc(524_289))
  assert.throws(() => store.load(reference), /缺失、损坏/)
})

test('unavailable secure storage never falls back to plaintext; deletion works while locked', (t) => {
  const { store, directory, lock } = fixture(t)
  store.save(reference.assetId, options)
  lock()
  assert.throws(() => store.save('other', options), /系统安全存储不可用/)
  assert.throws(() => store.load(reference), /系统安全存储不可用/)
  assert.deepEqual(readdirSync(directory), ['asset-server-one.bin'])
  store.remove([reference.assetId, 'missing', reference.assetId])
  assert.deepEqual(readdirSync(directory), [])
})

test('credential inputs reject traversal, malformed auth and oversized deletion batches', (t) => {
  const { store, directory } = fixture(t)
  for (const id of ['', '../escape', 'a/b', 'a\\b', 'a'.repeat(65), null]) {
    assert.throws(() => store.save(id, options), /无效的 SSH 连接引用/)
    assert.throws(() => store.remove([id]), /无效的 SSH 连接引用/)
  }
  assert.throws(() => store.save('valid', { ...options, auth: { method: 'password', password: '' } }), /配置无效/)
  assert.throws(() => store.remove(Array(501).fill('valid')), /无效/)
  assert.throws(() => store.remove('valid'), /无效/)
  assert.deepEqual(readdirSync(directory), [])
})

test('a full asset vault reserves one bounded revision and retains the original until commit', (t) => {
  const { store, directory } = fixture(t)
  for (let index = 0; index < 500; index++) store.save(`server-${index}`, options)
  const replacement: SshOptions = { ...options, auth: { method: 'password', password: 'replacement-secret' } }
  store.save('revision', replacement)
  assert.equal(readdirSync(directory).length, 501)
  assert.deepEqual(store.load({ ...reference, assetId: 'server-0' }), options)
  assert.deepEqual(store.load({ ...reference, assetId: 'revision' }), replacement)
  assert.throws(() => store.save('extra-revision', replacement), /无法安全保存/)
  store.remove(['revision'])
  assert.deepEqual(store.load({ ...reference, assetId: 'server-0' }), options, 'Rolling back a revision leaves the old credentials usable')
  store.save('revision-committed', replacement)
  store.remove(['server-0'])
  assert.equal(readdirSync(directory).length, 500)
  assert.deepEqual(store.load({ ...reference, assetId: 'revision-committed' }), replacement)
})

test('recovery uses committed references to reclaim an interrupted revision at full capacity', (t) => {
  const { store, directory, protector } = fixture(t)
  const assets = Array.from({ length: 500 }, (_, index) => ({ kind: 'connection', id: `server-${index}`, name: `Server ${index}`, parentId: null, host: options.host, port: options.port, username: options.username }))
  for (const asset of assets) store.save(asset.id, options)
  store.save('interrupted', options)
  const restored = createCredentialStore(directory, protector)
  restored.recover({ version: 1, assets })
  assert.equal(readdirSync(directory).length, 500)
  assert.deepEqual(restored.load({ ...reference, assetId: 'server-0' }), options)
  restored.save('committed', options)
  restored.recover({ version: 1, assets: assets.map((asset, index) => index === 0 ? { ...asset, credentialId: 'committed' } : asset) })
  assert.equal(readdirSync(directory).length, 500)
  assert.deepEqual(restored.load({ ...reference, assetId: 'committed' }), options)
  assert.throws(() => restored.load({ ...reference, assetId: 'server-0' }), /缺失/)
})

test('recovery rejects invalid documents before deletion and preserves unrelated files', (t) => {
  const { store, directory, lock } = fixture(t)
  store.save('orphan', options)
  for (const document of [null, { version: 2, assets: [] }, { version: 1, assets: [{ id: 'invalid' }] }]) {
    assert.throws(() => store.recover(document), /资产配置无效/)
    assert.deepEqual(readdirSync(directory), ['asset-orphan.bin'])
  }
  writeFileSync(join(directory, 'asset-orphan.bin.12345678-1234-1234-1234-123456789abc.tmp'), 'ciphertext')
  writeFileSync(join(directory, 'unrelated.bin'), 'retain')
  lock()
  store.recover({ version: 1, assets: [] })
  assert.deepEqual(readdirSync(directory), ['unrelated.bin'])
})
