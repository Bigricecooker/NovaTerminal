import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_SESSIONS } from '../src/lib/terminal-protocol.ts'
import { initialTerminalTabs, terminalTabsReducer } from '../src/lib/terminal-tabs.ts'

function openTabs(count: number) {
  let state = initialTerminalTabs
  for (let index = 0; index < count; index++) state = terminalTabsReducer(state, { type: 'open' })
  return state
}

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
  let state = terminalTabsReducer(local, { type: 'open', ssh: { host: 'server.invalid', port: 22, username: 'operator' } })
  assert.equal(state.activeId, 'ssh-2')
  assert.deepEqual(state.tabs[1]?.target, { kind: 'ssh', host: 'server.invalid', port: 22, username: 'operator' })
  state = terminalTabsReducer(state, { type: 'close', id: 'ssh-2' })
  assert.equal(state.activeId, 'local-1')
  assert.equal(state.tabs[0], local.tabs[0])
})
