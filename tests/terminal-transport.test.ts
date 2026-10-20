import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createTerminalTransport } from '../src/renderer/src/lib/terminal-transport.ts'
import type { DesktopTerminalApi } from '../src/shared/desktop-api.ts'

function fixture() {
  const calls = { open: 0, close: [] as string[], unsubscribe: 0, ready: 0, errors: 0 }
  const api: DesktopTerminalApi = {
    open: async () => { calls.open++; return `session-${calls.open}` },
    close: async (id) => { calls.close.push(id) },
    send: async () => true,
    onEvent: () => () => { calls.unsubscribe++ },
  }
  const events = { open: () => { calls.ready++ }, message: () => {}, close: () => {}, error: () => { calls.errors++ } }
  return { calls, api, events }
}

test('a discarded development mount does not reserve a session before the replacement connects', async () => {
  const { calls, api, events } = fixture()
  const discarded = createTerminalTransport(events, api)
  discarded.close()
  const active = createTerminalTransport(events, api)
  await setImmediate()
  assert.equal(calls.open, 1, 'StrictMode setup/cleanup/setup must reserve only one session slot')
  assert.equal(calls.ready, 1)
  assert.equal(calls.errors, 0)
  assert.equal(active.isOpen(), true)
  assert.deepEqual(calls.close, [])
  active.close()
  assert.deepEqual(calls.close, ['session-1'])
  assert.equal(calls.unsubscribe, 2)
})

test('closing while an IPC open is pending releases the returned session without activating it', async () => {
  const { calls, api, events } = fixture()
  let resolveId: ((id: string) => void) | undefined
  api.open = () => new Promise<string>((resolve) => { calls.open++; resolveId = resolve })
  const transport = createTerminalTransport(events, api)
  await setImmediate()
  transport.close()
  resolveId?.('late-session')
  await setImmediate()
  assert.equal(calls.open, 1)
  assert.equal(calls.ready, 0)
  assert.deepEqual(calls.close, ['late-session'])
  assert.equal(transport.isOpen(), false)
  assert.equal(calls.unsubscribe, 1)
})
