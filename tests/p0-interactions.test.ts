import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createExitCoordinator } from '../src/main/exit-coordinator.ts'
import { workspaceKey, externalUrl, activePhase, type KeyInput } from '../src/shared/terminal-interactions.ts'
import { exportConnections, mergeConnections, parseConnectionImport } from '../src/shared/connection-transfer.ts'
import { initialTerminalTabs, terminalTabsReducer } from '../src/renderer/src/lib/terminal-tabs.ts'
import type { Asset } from '../src/shared/assets.ts'

test('exit confirmation deduplicates, ignores stale replies, survives human thinking time and supports cancellation', () => {
  let time = 0, finished = 0
  const requests: number[] = []
  const exit = createExitCoordinator((id) => requests.push(id), () => { finished++ }, () => time)
  try {
    exit.begin(true); exit.begin(true)
    assert.deepEqual(requests, [1])
    exit.reply(99, 'exit'); assert.equal(finished, 0)
    for (let i = 0; i < 10; i++) { time += 1000; exit.reply(1, 'ack'); exit.tick() }
    assert.equal(finished, 0)
    exit.reply(1, 'cancel'); assert.equal(exit.pending(), false)
    exit.begin(true); exit.reply(1, 'exit'); assert.equal(finished, 0)
    exit.reply(2, 'exit'); exit.reply(2, 'exit'); assert.equal(finished, 1)
  } finally { exit.dispose() }
})
test('unresponsive renderers time out and crashed renderers finish pending exit', () => {
  for (const crash of [false, true]) {
    let time = 0, finished = 0
    const exit = createExitCoordinator(() => {}, () => { finished++ }, () => time)
    try {
      exit.begin(true); time = 5000
      if (crash) exit.unavailable(); else exit.tick()
      assert.equal(finished, 1)
    } finally { exit.dispose() }
  }
})
test('workspace shortcuts preserve shell combinations and ignore IME', () => {
  const key = (key: string, values: Partial<KeyInput> = {}): KeyInput => ({ key, ctrlKey: true, shiftKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 0, ...values })
  assert.equal(workspaceKey(key('w'), false), null)
  assert.equal(workspaceKey(key('t'), false), null)
  assert.equal(workspaceKey(key('W', { shiftKey: true }), false), 'close')
  assert.equal(workspaceKey(key('Tab', { shiftKey: true }), true), 'previous')
  assert.equal(workspaceKey(key('8'), false), 7)
  assert.equal(workspaceKey(key('9'), false), null)
  assert.equal(workspaceKey(key('t', { ctrlKey: false, metaKey: true }), true), 'new')
  assert.equal(workspaceKey(key(',', { isComposing: true }), false), null)
  assert.equal(workspaceKey(key('Tab', { keyCode: 229 }), false), null)
  assert.equal(workspaceKey(key('Tab', { altKey: true }), false), null)
  assert.ok(activePhase('verifying')); assert.equal(activePhase('error'), false)
})
test('external links reject protocols, credentials, controls, invalid hosts and excessive lengths', () => {
  assert.equal(externalUrl('https://example.com/path?q=1'), 'https://example.com/path?q=1')
  assert.equal(externalUrl('http://[::1]:80/'), 'http://[::1]/')
  for (const value of [null, '', 'file:///tmp/x', 'javascript:alert(1)', 'mailto:a@b.com', 'https://u:p@example.com',
    'https://example.com\n', ' https://example.com', 'https://bad host', 'https://', 'https://.', 'https://a..b', 'https://-invalid.example', 'https://example.com\\x', `https://example.com/${'x'.repeat(2048)}`]) assert.equal(externalUrl(value), null)
})
const assets: Asset[] = [
  { kind: 'group', id: 'g', name: 'group', parentId: null },
  { kind: 'connection', id: 'c', name: 'ssh', parentId: 'g', host: 'host.invalid', port: 22, username: 'user', credentialId: 'secret-reference' },
  { kind: 'local', id: 'l', name: 'local', parentId: null, directory: '/tmp' },
]
test('export strips authentication references and import reuses group paths without overwriting connections', () => {
  const document = exportConnections(assets)
  assert.equal(JSON.stringify(document).includes('secret-reference'), false)
  let id = 0
  const preview = mergeConnections(assets, document, () => `new-${++id}`)
  assert.equal(preview.groups, 0)
  assert.equal(preview.connections, 2)
  assert.deepEqual(preview.assets.slice(0, 3), assets)
  const added = preview.assets[3]
  assert.equal(added?.kind, 'connection')
  assert.ok(added?.kind === 'connection' && added.needsAuthentication && added.credentialId === undefined)
  assert.equal(added?.parentId, 'g')
})
test('invalid imports are rejected atomically and missing parents are previewed as top-level', () => {
  const document = exportConnections(assets)
  const original = structuredClone(assets)
  for (const raw of [
    { ...document, version: 2 },
    { ...document, connections: [...document.connections, document.connections[0]] },
    { ...document, groups: [{ kind: 'group', id: 'g', name: 'loop', parentId: 'g' }] },
    { ...document, connections: [{ ...document.connections[0], port: 0 }] },
    { ...document, connections: Array.from({ length: 501 }, () => document.connections[0]) },
  ]) assert.throws(() => mergeConnections(assets, raw, () => 'new'))
  assert.deepEqual(assets, original)
  const orphan = parseConnectionImport({ ...document, groups: [] })
  assert.equal(orphan.orphaned, 1)
  assert.equal(orphan.assets[0]?.parentId, null)
  const injected = parseConnectionImport({ ...document, connections: [{ ...document.connections[0], credentialId: 'stolen', auth: { password: 'secret' } }] })
  assert.ok(!JSON.stringify(injected).includes('stolen') && !JSON.stringify(injected).includes('secret'))
})
test('dynamic tab limits preserve existing tabs and reconnect keeps identity and ordering', () => {
  let state = initialTerminalTabs
  for (let i = 0; i < 6; i++) state = terminalTabsReducer(state, { type: 'open', limit: 6 })
  assert.equal(state.tabs.length, 6)
  assert.equal(terminalTabsReducer(state, { type: 'open', limit: 2 }), state)
  const first = state.tabs[0]!
  const reconnected = terminalTabsReducer(state, { type: 'reconnect', id: first.id, target: first.target })
  assert.equal(reconnected.tabs[0]?.generation, 1)
  assert.equal(reconnected.tabs[0]?.id, first.id)
  assert.equal(reconnected.activeId, state.activeId)
  assert.equal(reconnected.tabs[1], state.tabs[1])
})
