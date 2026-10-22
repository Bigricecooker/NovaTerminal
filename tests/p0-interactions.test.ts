import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createExitCoordinator } from '../src/main/exit-coordinator.ts'
import { workspaceKey, activePhase, type KeyInput } from '../src/shared/terminal-interactions.ts'
import { initialTerminalTabs, terminalTabsReducer } from '../src/renderer/src/lib/terminal-tabs.ts'

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
