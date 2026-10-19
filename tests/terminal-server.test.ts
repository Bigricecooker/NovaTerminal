import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { after, before, test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { attachTerminalServer } from '../src/server/terminal-server.ts'
import { HIGH_WATER, parseServerMessage, type ClientMessage, type ServerMessage } from '../src/shared/terminal-protocol.ts'

const server = createServer()
const dispose = attachTerminalServer(server)
let origin = ''
let url = ''

before(async () => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  origin = `http://127.0.0.1:${address.port}`
  url = `ws://127.0.0.1:${address.port}/api/terminal`
})
after(async () => {
  dispose()
  server.close()
  await once(server, 'close')
})

async function connect(t: TestContext, ack = true) {
  const socket = new WebSocket(url, { origin })
  t.after(() => socket.terminate())
  const messages: ServerMessage[] = []
  let output = ''
  let acknowledge = ack
  socket.on('message', (raw) => {
    const message = parseServerMessage(raw.toString())
    assert.ok(message)
    messages.push(message)
    if (message.type === 'output') {
      output += message.data
      if (acknowledge && socket.readyState === WebSocket.OPEN) send({ type: 'ack', count: message.data.length })
    }
  })
  const send = (message: ClientMessage) => socket.send(JSON.stringify(message))
  const wait = async (condition: () => boolean) => {
    const deadline = Date.now() + 12_000
    while (!condition()) {
      assert.ok(Date.now() < deadline, 'Timed out waiting for terminal output or state')
      await delay(25)
    }
  }
  await once(socket, 'open')
  return {
    socket, messages, send, wait, output: () => output,
    acknowledge: () => {
      acknowledge = true
      for (const message of messages) {
        if (message.type === 'output') send({ type: 'ack', count: message.data.length })
      }
    },
    start: async () => {
      send({ type: 'start', cols: 100, rows: 30 })
      await wait(() => messages.some((message) => message.type === 'ready' || message.type === 'error'))
      assert.ok(messages.some((message) => message.type === 'ready'), 'Native PTY must start')
      // Wait for the actual interactive prompt; ready means the PTY has spawned.
      await wait(() => output.length > 0)
      await delay(200)
    },
  }
}

test('rejects foreign / absent Origin, forged Host, and query paths', { timeout: 10_000 }, async () => {
  for (const options of [
    { origin: 'https://example.invalid' },
    {},
    { origin, headers: { Host: 'example.invalid' } },
  ]) {
    const socket = new WebSocket(url, options)
    socket.on('error', () => {})
    const [, response] = await once(socket, 'unexpected-response')
    assert.equal(response.statusCode, 403)
    response.resume()
    socket.terminate()
  }
  const socket = new WebSocket(`${url}?unexpected=1`, { origin })
  socket.on('error', () => {})
  const [, response] = await once(socket, 'unexpected-response')
  assert.equal(response.statusCode, 403)
  response.resume()
  socket.terminate()
})

test('rejects invalid messages and input before start', { timeout: 10_000 }, async (t) => {
  for (const raw of ['{', JSON.stringify({ type: 'start', cols: -1, rows: 24 }), JSON.stringify({ type: 'input', data: 'exit\r' })]) {
    const client = await connect(t)
    const closed = once(client.socket, 'close')
    client.socket.send(raw)
    const [code] = await closed
    assert.equal(code, 1008)
    assert.ok(client.messages.some((message) => message.type === 'error'))
  }
})

test('limits concurrent connections before creating more PTYs', { timeout: 10_000 }, async (t) => {
  const clients = []
  for (let index = 0; index < 4; index++) clients.push(await connect(t))
  const extra = new WebSocket(url, { origin })
  extra.on('error', () => {})
  const [, response] = await once(extra, 'unexpected-response')
  assert.equal(response.statusCode, 503)
  response.resume()
  extra.terminate()
  await Promise.all(clients.map(async (client) => {
    const closed = once(client.socket, 'close')
    client.socket.close()
    await closed
  }))
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
  const closed = once(client.socket, 'close')
  client.socket.close()
  await closed
  await client.wait(() => {
    try { process.kill(pid, 0); return false } catch { return true }
  })
  const next = await connect(t)
  await next.start()
  assert.ok(next.socket.readyState === WebSocket.OPEN)
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
  const closed = once(closing.socket, 'close')
  closing.socket.close()
  await closed
  await closing.wait(() => {
    try { process.kill(closingPid, 0); return false } catch { return true }
  })
  await Promise.all(clients.map(async (client, index) => {
    if (index === 1) return
    assert.equal(client.socket.readyState, WebSocket.OPEN)
    client.send({ type: 'input', data: process.platform === 'win32'
      ? "[Console]::WriteLine(('SURVIVOR_' + $novaTabValue + '_' + $PID))\r"
      : "printf 'SURVIVOR_%s_%s\\n' \"$nova_tab_value\" $$\r" })
    await client.wait(() => client.output().includes(`SURVIVOR_TAB_${index}_${pids[index]}`))
    assert.ok(!client.messages.some((message) => message.type === 'exit' || message.type === 'error'))
    const ended = once(client.socket, 'close')
    client.socket.close()
    await ended
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
  const closed = once(client.socket, 'close')
  client.send({ type: 'ack', count: 1_048_576 })
  const [code] = await closed
  assert.equal(code, 1008)
})
