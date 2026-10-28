import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createTerminalTransport } from '../src/renderer/src/lib/terminal-transport.ts'
import type { DesktopTerminalApi } from '../src/shared/desktop-api.ts'
import { MAX_PASTE } from '../src/shared/terminal-interactions.ts'
import type { ClientMessage } from '../src/shared/terminal-protocol.ts'

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

test('escaped paste is rejected before any chunk is sent and leaves the transport usable', async () => {
  const { calls, api, events } = fixture()
  const sent: ClientMessage[] = []
  api.send = async (_id, message) => { sent.push(message); return true }
  const transport = createTerminalTransport(events, api)
  await setImmediate()
  assert.equal(transport.sendInput('\x01'.repeat(MAX_PASTE)), false)
  assert.equal(transport.sendInput('x'.repeat(MAX_PASTE + 13)), false)
  assert.equal(sent.length, 0)
  assert.equal(transport.isOpen(), true)
  assert.equal(calls.errors, 0)
  const text = '\x1b[200~' + 'x'.repeat(16_377) + '🚀中文' + 'x'.repeat(49_155) + '\x1b[201~'
  assert.equal(transport.sendInput(text), true)
  const data = sent.flatMap((message) => message.type === 'input' ? [message.data] : [])
  assert.equal(data.join(''), text)
  assert.equal(Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString('utf8'), text)
  transport.close()
})

test('input reservations include pending encoded messages and release after IPC completes', async () => {
  const { calls, api, events } = fixture()
  const sent: ClientMessage[] = []
  const complete: (() => void)[] = []
  api.send = (_id, message) => new Promise((resolve) => { sent.push(message); complete.push(() => resolve(true)) })
  const transport = createTerminalTransport(events, api)
  await setImmediate()
  assert.equal(transport.sendInput('x'.repeat(MAX_PASTE)), true)
  assert.equal(transport.sendInput('x'.repeat(MAX_PASTE)), false)
  assert.equal(sent.length, 4)
  for (const finish of complete) finish()
  await setImmediate()
  const mouse = '\x1b[M \x84\xff'
  assert.equal(transport.sendInput(mouse, true), true)
  assert.deepEqual(sent.at(-1), { type: 'input', data: mouse, binary: true })
  assert.equal(calls.errors, 0)
  transport.close()
})
