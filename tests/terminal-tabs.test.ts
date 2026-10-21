import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_SESSIONS } from '../src/shared/terminal-protocol.ts'
import { initialTerminalTabs, terminalTabsReducer } from '../src/renderer/src/lib/terminal-tabs.ts'

function openTabs(count: number) {
  let state = initialTerminalTabs
  for (let index = 0; index < count; index++) state = terminalTabsReducer(state, { type: 'open' })
  return state
}

test('saved local connections carry their directory and label through tab moves', () => {
  let state = terminalTabsReducer(openTabs(1), { type: 'open', local: { directory: 'C:\\work\\项目', name: '项目' } })
  const tab = state.tabs[1]
  assert.equal(tab?.label, '项目')
  assert.deepEqual(tab?.target, { kind: 'local', cwd: 'C:\\work\\项目' })
  state = terminalTabsReducer(state, { type: 'move', id: 'local-2', targetId: 'local-1', position: 'before' })
  assert.equal(state.tabs[0], tab)
})

test('opens independent tabs and selects each new tab up to the session limit', () => {
  const state = openTabs(MAX_SESSIONS)
  assert.equal(state.tabs.length, MAX_SESSIONS)
  assert.equal(new Set(state.tabs.map((tab) => tab.id)).size, MAX_SESSIONS)
  assert.equal(state.activeId, state.tabs.at(-1)?.id)
  assert.equal(terminalTabsReducer(state, { type: 'open' }), state)
  assert.deepEqual(initialTerminalTabs.tabs, [])
})

test('switching and closing a background tab preserve the active tab and remaining identities', () => {
  let state = openTabs(3)
  state = terminalTabsReducer(state, { type: 'select', id: 'local-1' })
  const originalTabs = state.tabs
  state = terminalTabsReducer(state, { type: 'close', id: 'local-2' })
  assert.equal(state.activeId, 'local-1')
  assert.deepEqual(state.tabs.map((tab) => tab.id), ['local-1', 'local-3'])
  assert.equal(state.tabs[0], originalTabs[0])
  assert.equal(state.tabs[1], originalTabs[2])
})

test('closing an active tab selects its right neighbour then falls back to its left', () => {
  let state = terminalTabsReducer(openTabs(3), { type: 'select', id: 'local-2' })
  state = terminalTabsReducer(state, { type: 'close', id: 'local-2' })
  assert.equal(state.activeId, 'local-3')
  state = terminalTabsReducer(state, { type: 'close', id: 'local-3' })
  assert.equal(state.activeId, 'local-1')
  state = terminalTabsReducer(state, { type: 'close', id: 'local-1' })
  assert.deepEqual(state.tabs, [])
  assert.equal(state.activeId, null)
})

test('closing tabs releases capacity and reopening never reuses an old session identity', () => {
  let state = openTabs(MAX_SESSIONS)
  state = terminalTabsReducer(state, { type: 'close', id: 'local-2' })
  state = terminalTabsReducer(state, { type: 'open' })
  assert.equal(state.tabs.length, MAX_SESSIONS)
  assert.equal(state.activeId, `local-${MAX_SESSIONS + 1}`)
  assert.equal(state.tabs.at(-1)?.label, `本地终端 ${MAX_SESSIONS + 1}`)
  for (const tab of state.tabs) state = terminalTabsReducer(state, { type: 'close', id: tab.id })
  state = terminalTabsReducer(state, { type: 'open' })
  assert.equal(state.activeId, `local-${MAX_SESSIONS + 2}`)
})

test('stale selection or close events cannot affect another session', () => {
  const state = openTabs(2)
  assert.equal(terminalTabsReducer(state, { type: 'select', id: 'missing' }), state)
  assert.equal(terminalTabsReducer(state, { type: 'close', id: 'missing' }), state)
})

test('SSH tabs share the limit and closing them preserves local tabs without retaining credentials', () => {
  const local = openTabs(1)
  let state = terminalTabsReducer(local, { type: 'open', ssh: { assetId: 'saved-server', host: 'server.invalid', port: 22, username: 'operator' } })
  assert.equal(state.activeId, 'ssh-2')
  assert.deepEqual(state.tabs[1]?.target, { kind: 'ssh', assetId: 'saved-server', host: 'server.invalid', port: 22, username: 'operator' })
  state = terminalTabsReducer(state, { type: 'close', id: 'ssh-2' })
  assert.equal(state.activeId, 'local-1')
  assert.equal(state.tabs[0], local.tabs[0])
})

test('asset names label SSH sessions and synchronize without replacing running session targets', () => {
  const ssh = { assetId: 'credential-revision', host: 'server.invalid', port: 22, username: 'operator' }
  let state = terminalTabsReducer(openTabs(1), { type: 'open', ssh, name: '生产服务器', assetId: 'server' })
  state = terminalTabsReducer(state, { type: 'open', ssh, name: '生产服务器', assetId: 'server' })
  state = terminalTabsReducer(state, { type: 'open', local: { directory: '/work', name: '工作目录' }, assetId: 'work' })
  const before = state
  assert.equal(state.tabs[1]?.label, '生产服务器')
  state = terminalTabsReducer(state, { type: 'sync-assets', assets: [{ id: 'server', name: '新名称' }, { id: 'work', name: '新目录名' }] })
  assert.deepEqual(state.tabs.map((tab) => tab.label), ['本地终端 1', '新名称', '新名称', '新目录名'])
  assert.equal(state.activeId, before.activeId)
  assert.equal(state.nextId, before.nextId)
  state.tabs.forEach((tab, index) => {
    assert.equal(tab.id, before.tabs[index]?.id)
    assert.equal(tab.target, before.tabs[index]?.target)
  })
  assert.equal(terminalTabsReducer(state, { type: 'sync-assets', assets: [] }), state, 'Deleting an asset preserves its live tab and name')
})

test('moving tabs retains session objects, active identity and next-id counter in both directions', () => {
  const original = terminalTabsReducer(openTabs(3), { type: 'select', id: 'local-2' })
  let state = terminalTabsReducer(original, { type: 'move', id: 'local-3', targetId: 'local-1', position: 'before' })
  assert.deepEqual(state.tabs.map((tab) => tab.id), ['local-3', 'local-1', 'local-2'])
  assert.equal(state.activeId, original.activeId)
  assert.equal(state.nextId, original.nextId)
  for (const tab of state.tabs) assert.equal(tab, original.tabs.find((item) => item.id === tab.id))
  state = terminalTabsReducer(state, { type: 'move', id: 'local-3', targetId: 'local-2', position: 'after' })
  assert.deepEqual(state.tabs, original.tabs)
  state = terminalTabsReducer(state, { type: 'move', id: 'local-2', targetId: 'local-1', position: 'before' })
  state = terminalTabsReducer(state, { type: 'close', id: 'local-2' })
  assert.equal(state.activeId, 'local-1', 'Closing follows the displayed neighbour after a move')
})

test('stale, identical and no-op tab drops leave the state unchanged', () => {
  const state = openTabs(2)
  for (const [id, targetId, position] of [['missing', 'local-1', 'before'], ['local-1', 'missing', 'after'], ['local-1', 'local-1', 'after'], ['local-1', 'local-2', 'before']] as const) {
    assert.equal(terminalTabsReducer(state, { type: 'move', id, targetId, position }), state)
  }
})
