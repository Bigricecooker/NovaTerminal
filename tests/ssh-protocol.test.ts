import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClientMessage, parseSshOptions } from '../src/shared/terminal-protocol.ts'

const options = { host: 'SERVER.invalid', port: 22, username: 'operator', auth: { method: 'password', password: 'test-only' } }

test('saved SSH starts accept only bounded asset references and forbid mixed targets', () => {
  const savedSsh = { assetId: 'asset-one', host: 'server.invalid', port: 22, username: 'operator' }
  const start = { type: 'start', cols: 80, rows: 24, savedSsh }
  assert.deepEqual(parseClientMessage(JSON.stringify(start)), start)
  for (const assetId of ['', '../escape', 'a/b', 'x'.repeat(65), null]) {
    assert.equal(parseClientMessage(JSON.stringify({ ...start, savedSsh: { ...savedSsh, assetId } })), null)
  }
  for (const extra of [{ cwd: '/tmp' }, { ssh: options }]) assert.equal(parseClientMessage(JSON.stringify({ ...start, ...extra })), null)
})

test('local start accepts bounded absolute directories and rejects mixed SSH/local starts', () => {
  const start = { type: 'start', cols: 80, rows: 24 }
  for (const cwd of ['C:\\项目 目录', '/tmp/project space', '\\\\server\\share']) {
    assert.deepEqual(parseClientMessage(JSON.stringify({ ...start, cwd })), { ...start, cwd })
  }
  for (const cwd of ['', 'relative', 'C:relative', '/bad\0path', '/bad\npath', '/'.repeat(4097), {}, null]) {
    assert.equal(parseClientMessage(JSON.stringify({ ...start, cwd })), null)
  }
  assert.equal(parseClientMessage(JSON.stringify({ ...start, cwd: '/tmp', ssh: options })), null)
})

test('SSH protocol validates endpoint and bounded authentication data', () => {
  assert.equal(parseSshOptions(options)?.host, 'server.invalid')
  assert.ok(parseSshOptions({ ...options, host: '::1', port: 1 }))
  for (const invalid of [
    { host: 'ssh://server.invalid' }, { host: 'server.invalid/dir' }, { host: 'user@server.invalid' },
    { host: 'bad host' }, { host: '' }, { port: 0 }, { port: 65536 }, { port: 2.5 },
    { username: '' }, { username: 'bad\nuser' }, { auth: { method: 'agent', path: '/arbitrary' } },
    { auth: { method: 'password', password: '' } }, { auth: { method: 'password', password: 'p'.repeat(4097) } },
    { auth: { method: 'privateKey', privateKey: 'p'.repeat(65537), passphrase: '' } },
  ]) assert.equal(parseSshOptions({ ...options, ...invalid }), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 'start', cols: 80, rows: 24, ssh: { ...options, port: -1 } })), null)
})

test('host trust responses require a complete SHA-256 fingerprint and a boolean decision', () => {
  const fingerprint = `SHA256:${'A'.repeat(43)}`
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'host-key-response', fingerprint, accept: true })), { type: 'host-key-response', fingerprint, accept: true })
  assert.equal(parseClientMessage(JSON.stringify({ type: 'host-key-response', fingerprint: 'bad', accept: true })), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 'host-key-response', fingerprint, accept: 'true' })), null)
})

test('binary input accepts only bounded byte strings and preserves its encoding flag', () => {
  const input = { type: 'input', data: '\x1b[M \x84\xff', binary: true }
  assert.deepEqual(parseClientMessage(JSON.stringify(input)), input)
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'input', data: '中文🚀' })), { type: 'input', data: '中文🚀' })
  for (const patch of [{ data: '中文' }, { data: '🚀' }, { data: '' }, { data: 'x'.repeat(16_385) }, { binary: false }, { binary: 'true' }]) {
    assert.equal(parseClientMessage(JSON.stringify({ ...input, ...patch })), null)
  }
})
