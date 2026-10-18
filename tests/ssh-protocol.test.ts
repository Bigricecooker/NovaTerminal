import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClientMessage, parseSshOptions } from '../src/lib/terminal-protocol.ts'

const options = { host: 'SERVER.invalid', port: 22, username: 'operator', auth: { method: 'password', password: 'test-only' } }

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
