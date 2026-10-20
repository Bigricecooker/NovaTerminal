import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { APP_URL, DEV_URL, assetPath, desktopMessage, trustedFrame, windowAction } from '../src/main/security.ts'
import { createDesktopSessions, type SessionProcess } from '../src/main/sessions.ts'
import type { DesktopEvent } from '../src/shared/desktop-api.ts'

test('desktop IPC requires the owning main frame and exact document URL', () => {
  assert.ok(trustedFrame(10, 10, true, APP_URL, APP_URL))
  assert.ok(trustedFrame(10, 10, true, DEV_URL, DEV_URL))
  for (const [sender, main, url] of [[11, true, APP_URL], [10, false, APP_URL], [10, true, `${APP_URL}?other`], [10, true, 'https://example.invalid/']] as const) {
    assert.equal(trustedFrame(sender, 10, main, url, APP_URL), false)
  }
})

test('window IPC accepts only the three supported window actions', () => {
  for (const action of ['minimize', 'toggle-maximize', 'close']) assert.equal(windowAction(action), action)
  for (const value of [null, 'exec', {}, ['close'], { action: 'close' }, 'close;exec', 'setBounds']) {
    assert.equal(windowAction(value), null)
  }
})

test('desktop resource protocol rejects foreign hosts and escaped asset paths', () => {
  const root = resolve('dist')
  assert.equal(assetPath(root, APP_URL), resolve(root, 'index.html'))
  assert.equal(assetPath(root, 'app://novaterminal/assets/app.js'), resolve(root, 'assets/app.js'))
  for (const url of ['file:///etc/passwd', 'app://other/index.html', 'app://novaterminal/%2e%2e%2fsecret', 'app://novaterminal/%5csecret', 'app://novaterminal/index.html?other', 'app://user@novaterminal/index.html']) {
    assert.equal(assetPath(root, url), null)
  }
  assert.equal(desktopMessage({ type: 'clear' }), null)
  assert.equal(desktopMessage('x'.repeat(262_145)), null)
  assert.equal(desktopMessage('{"type":"exec","command":"anything"}'), null)
})

class FakeProcess extends EventEmitter implements SessionProcess {
  sent: unknown[] = []
  postMessage(message: unknown) { this.sent.push(message) }
  kill() { this.emit('exit', 0); return true }
}

test('desktop sessions enforce ownership, limits, acknowledgements and isolated cleanup', () => {
  const children: FakeProcess[] = []
  const events: { owner: number; event: DesktopEvent }[] = []
  const sessions = createDesktopSessions(() => { const child = new FakeProcess(); children.push(child); return child }, (owner, event) => events.push({ owner, event }))
  try {
    const id = sessions.open(1)
    const other = sessions.open(2)
    assert.throws(() => sessions.send(2, id, '{"type":"clear"}'), /unavailable/)
    assert.throws(() => sessions.close(2, id), /unavailable/)
    assert.ok(sessions.send(1, id, '{"type":"start","cols":80,"rows":24}'))
    children[0]?.emit('message', { type: 'ready', shell: 'test' })
    children[0]?.emit('message', { type: 'output', data: 'hello' })
    assert.ok(sessions.send(1, id, '{"type":"ack","count":5}'))
    assert.equal(sessions.send(1, id, '{"type":"ack","count":1}'), false)
    assert.equal(sessions.count(), 1)
    assert.equal(events.at(-1)?.owner, 1)
    sessions.open(2); sessions.open(2)
    assert.throws(() => sessions.open(2), /limit/)
    children[0]?.emit('exit', 0)
    const replacement = sessions.open(1)
    sessions.closeOwner(1)
    assert.ok(events.some(({ event }) => event.id === replacement && 'closed' in event))
    assert.ok(sessions.send(2, other, '{"type":"start","cols":80,"rows":24}'))
    sessions.closeOwner(2)
    assert.equal(sessions.count(), 0)
  } finally { sessions.dispose(); for (const child of children) child.kill() }
})

test('closing an unstarted desktop session releases capacity without spawning a process', () => {
  let spawned = 0
  const sessions = createDesktopSessions(() => { spawned++; return new FakeProcess() }, () => {})
  try {
    for (let index = 0; index < 12; index++) sessions.close(1, sessions.open(1))
    assert.equal(spawned, 0)
    assert.equal(sessions.count(), 0)
  } finally { sessions.dispose() }
})

test('desktop output overflow and excessive input terminate only the owning session', () => {
  const children: FakeProcess[] = []
  const sessions = createDesktopSessions(() => { const child = new FakeProcess(); children.push(child); return child }, () => {})
  try {
    const flood = sessions.open(1)
    const survivor = sessions.open(2)
    const start = '{"type":"start","cols":80,"rows":24}'
    sessions.send(1, flood, start)
    sessions.send(2, survivor, start)
    for (let index = 0; index < 65; index++) children[0]?.emit('message', { type: 'output', data: 'x'.repeat(16_384) })
    assert.throws(() => sessions.send(1, flood, '{"type":"clear"}'), /unavailable/)
    assert.ok(sessions.send(2, survivor, '{"type":"clear"}'))
    const input = JSON.stringify({ type: 'input', data: 'x'.repeat(16_384) })
    for (let index = 0; index < 8; index++) assert.ok(sessions.send(2, survivor, input))
    assert.equal(sessions.send(2, survivor, input), false)
  } finally { sessions.dispose(); for (const child of children) child.kill() }
})
