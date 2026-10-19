import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createKnownHosts } from '../src/server/known-hosts.ts'

const host = 'example.invalid'
const fingerprint = `SHA256:${'A'.repeat(43)}`
const changed = `SHA256:${'B'.repeat(43)}`

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'nova-known-hosts-test-'))
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.match(basename(directory), /^nova-known-hosts-test-/)
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}

test('independent host stores concurrently trust the same fingerprint', async (t) => {
  const directory = await fixture(t)
  const stores = Array.from({ length: 4 }, () => createKnownHosts(directory))
  const results = await Promise.allSettled(stores.map((store) => store.trust(host, 22, fingerprint)))
  for (const result of results) assert.equal(result.status, 'fulfilled')
  for (const store of stores) assert.equal(await store.lookup(host, 22), fingerprint)
  assert.equal((await readdir(directory)).length, 1)
})

test('competing fingerprints never replace the winning host record', async (t) => {
  const directory = await fixture(t)
  const first = createKnownHosts(directory)
  const second = createKnownHosts(directory)
  const results = await Promise.allSettled([first.trust(host, 22, fingerprint), second.trust(host, 22, changed)])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const winner = results[0]?.status === 'fulfilled' ? fingerprint : changed
  assert.equal(await first.lookup(host, 22), winner)
  assert.equal(await second.lookup(host, 22), winner)
  assert.equal((await readdir(directory)).length, 1)
})

test('corrupt host records are rejected and preserved; later writes still work', async (t) => {
  const directory = await fixture(t)
  const store = createKnownHosts(directory)
  await store.trust(host, 22, fingerprint)
  const name = (await readdir(directory))[0]
  assert.ok(name)
  const path = join(directory, name)
  await writeFile(path, 'invalid-json')
  await assert.rejects(store.lookup(host, 22))
  await assert.rejects(store.trust(host, 22, fingerprint))
  assert.equal(await readFile(path, 'utf8'), 'invalid-json')
  await store.trust(host, 2222, changed)
  assert.equal(await store.lookup(host, 2222), changed)
})
