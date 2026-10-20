import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { HIGH_WATER } from '../src/shared/terminal-protocol.ts'
import { sessionHarness } from './helpers/session-client.ts'

const fixtures = new WeakMap<TestContext, ReturnType<typeof sessionHarness>>()
async function connect(t: TestContext, ack = true) {
  let fixture = fixtures.get(t)
  if (!fixture) { fixture = sessionHarness(t); fixtures.set(t, fixture) }
  return fixture.connect(ack)
}

test('desktop sessions reject malformed messages and input before start', async (t) => {
  for (const raw of ['{', JSON.stringify({ type: 'start', cols: -1, rows: 24 }), JSON.stringify({ type: 'input', data: 'exit\r' })]) {
    const client = await connect(t)
    assert.equal(client.sendRaw(raw), false)
    assert.equal(client.isOpen(), false)
    assert.ok(client.messages.some((message) => message.type === 'error'))
  }
})

test('runs a real shell with Unicode, ANSI output, resize, and exit code', { timeout: 20_000 }, async (t) => {
  const client = await connect(t)
  await client.start()
  client.send({ type: 'clear' })
  client.send({ type: 'resize', cols: 110, rows: 32 })
  const command = process.platform === 'win32'
    ? "[Console]::WriteLine(([char]27) + '[31m' + ('NOVA_' + '中文') + ([char]27) + '[0m'); [Console]::WriteLine(('SIZE_' + $Host.UI.RawUI.WindowSize.Width + '_' + $Host.UI.RawUI.WindowSize.Height)); exit 7\r"
    : "printf '\\033[31mNOVA_%s\\033[0m\\n' '中文'; printf 'SIZE_'; stty size; exit 7\r"
  client.send({ type: 'input', data: command })
  await client.wait(() => client.messages.some((message) => message.type === 'exit'))
  assert.ok(client.output().includes('\u001b[31mNOVA_中文'))
  assert.match(client.output(), process.platform === 'win32' ? /SIZE_110_32/ : /SIZE_32 110/)
  assert.ok(client.messages.some((message) => message.type === 'exit' && message.code === 7))
})

test('pauses output until render acknowledgements then resumes', { timeout: 25_000 }, async (t) => {
  const client = await connect(t, false)
  await client.start()
  const command = process.platform === 'win32'
    ? "[Console]::Write(('x' * 400000)); [Console]::WriteLine(('FLOW_' + 'DONE'))\r"
    : "head -c 400000 /dev/zero | tr '\\0' x; printf 'FLOW_%s\\n' 'DONE'\r"
  client.send({ type: 'input', data: command })
  await client.wait(() => client.output().length >= HIGH_WATER)
  await delay(200)
  const pausedLength = client.output().length
  await delay(200)
  assert.equal(client.output().length, pausedLength, 'PTY output should pause without acknowledgements')
  assert.ok(pausedLength < 400_000)
  client.acknowledge()
  await client.wait(() => client.output().includes('FLOW_DONE'))
  assert.ok(client.output().length > 400_000)
})

test('disconnect kills the shell and a new connection starts a fresh session', { timeout: 25_000 }, async (t) => {
  const client = await connect(t)
  await client.start()
  client.send({ type: 'input', data: process.platform === 'win32'
    ? "[Console]::WriteLine(('PID_' + $PID))\r"
    : "printf 'PID_%s\\n' $$\r" })
  await client.wait(() => /PID_\d+/.test(client.output()))
  const match = /PID_(\d+)/.exec(client.output())
  assert.ok(match?.[1])
  const pid = Number(match[1])
  await client.close()
  await client.wait(() => {
    try { process.kill(pid, 0); return false } catch { return true }
  })
  const next = await connect(t)
  await next.start()
  assert.ok(next.isOpen())
})

test('closing one of three concurrent shells leaves the others and their state alive', { timeout: 30_000 }, async (t) => {
  const clients = await Promise.all([connect(t), connect(t), connect(t)])
  const pids = await Promise.all(clients.map(async (client, index) => {
    await client.start()
    client.send({ type: 'input', data: process.platform === 'win32'
      ? `$novaTabValue = 'TAB_${index}'; [Console]::WriteLine(('IDENTITY_' + $PID))\r`
      : `nova_tab_value='TAB_${index}'; printf 'IDENTITY_%s\\n' $$\r` })
    await client.wait(() => /IDENTITY_\d+/.test(client.output()))
    const match = /IDENTITY_(\d+)/.exec(client.output())
    assert.ok(match?.[1])
    return Number(match[1])
  }))
  assert.equal(new Set(pids).size, 3, 'Each tab must have its own Shell process')
  const closing = clients[1]
  const closingPid = pids[1]
  assert.ok(closing && closingPid)
  await closing.close()
  await closing.wait(() => {
    try { process.kill(closingPid, 0); return false } catch { return true }
  })
  await Promise.all(clients.map(async (client, index) => {
    if (index === 1) return
    assert.equal(client.isOpen(), true)
    client.send({ type: 'input', data: process.platform === 'win32'
      ? "[Console]::WriteLine(('SURVIVOR_' + $novaTabValue + '_' + $PID))\r"
      : "printf 'SURVIVOR_%s_%s\\n' \"$nova_tab_value\" $$\r" })
    await client.wait(() => client.output().includes(`SURVIVOR_TAB_${index}_${pids[index]}`))
    assert.ok(!client.messages.some((message) => message.type === 'exit' || message.type === 'error'))
    await client.close()
  }))
  for (const [index, client] of clients.entries()) {
    for (const other of [0, 2]) {
      if (other !== index) assert.ok(!client.output().includes(`SURVIVOR_TAB_${other}_`), 'Outputs must not cross sessions')
    }
  }
})

test('rejects acknowledgements beyond outstanding output', { timeout: 20_000 }, async (t) => {
  const client = await connect(t)
  await client.start()
  client.send({ type: 'ack', count: 1_048_576 })
  await client.wait(() => !client.isOpen())
})
