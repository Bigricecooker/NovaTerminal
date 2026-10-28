import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import ssh2, { type Server as SshServer, type Connection, type ServerChannel } from 'ssh2'
import { sessionHarness } from './helpers/session-client.ts'
import { HIGH_WATER, type SshOptions } from '../src/shared/terminal-protocol.ts'
import { terminalInputChunks } from '../src/shared/terminal-input.ts'

// Keys and credentials belong only to this temporary protocol fixture.
const { Server, utils } = ssh2
const hostKey = utils.generateKeyPairSync('ed25519')
const userKey = utils.generateKeyPairSync('ed25519', { passphrase: 'test-passphrase', cipher: 'aes256-cbc', rounds: 4 })
const publicKey = utils.parseKey(userKey.public)
assert.ok(!(publicKey instanceof Error))

async function wait(condition: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for SSH protocol state')
    await delay(15)
  }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'nova-ssh-test-'))
  const harness = sessionHarness(t, directory)
  const remotes: SshServer[] = []
  const connections = new Set<Connection>()
  const channels: ServerChannel[] = []
  const sizes: { cols: number; rows: number }[] = []
  const inputs: string[] = []
  const inputBytes: Buffer[] = []
  let authentications = 0
  let closedChannels = 0
  const startRemote = async (key = hostKey.private, port = 0) => {
    const remote = new Server({ hostKeys: [key] }, (connection) => {
      connections.add(connection)
      connection.on('error', () => {})
      connection.on('close', () => connections.delete(connection))
      connection.on('authentication', (context) => {
        authentications++
        if (context.username !== 'nova-test') { context.reject(); return }
        if (context.method === 'password' && context.password === 'test-password') { context.accept(); return }
        if (context.method === 'publickey' && !(publicKey instanceof Error)
          && context.key.data.equals(publicKey.getPublicSSH())
          && (!context.signature || context.blob && publicKey.verify(context.blob, context.signature, context.hashAlgo))) {
          context.accept(); return
        }
        context.reject()
      })
      connection.on('ready', () => connection.on('session', (accept) => {
        const session = accept()
        session.on('pty', (acceptPty, _reject, info) => { sizes.push({ cols: info.cols, rows: info.rows }); acceptPty?.() })
        session.on('window-change', (_accept, _reject, info) => { sizes.push({ cols: info.cols, rows: info.rows }) })
        session.on('shell', (acceptShell) => {
          const channel = acceptShell()
          channels.push(channel)
          channel.on('error', () => {})
          channel.on('close', () => { closedChannels++ })
          channel.on('data', (data: Buffer) => {
            inputBytes.push(data)
            const text = data.toString('utf8')
            inputs.push(text)
            channel.write(`ECHO:${text}`)
          })
        })
      }))
    })
    remotes.push(remote)
    remote.listen(port, '127.0.0.1')
    await once(remote, 'listening')
    const address = remote.address()
    assert.ok(address && typeof address !== 'string')
    return { remote, port: address.port }
  }
  t.after(async () => {
    for (const connection of connections) connection.end()
    await Promise.all(remotes.filter((remote) => remote.address() !== null).map((remote) => new Promise<void>((done) => remote.close(() => done()))))
    // Only remove this fixture's explicitly allocated temporary directory.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.match(basename(directory), /^nova-ssh-test-/)
    await rm(directory, { recursive: true, force: true })
  })
  const first = await startRemote()
  const connect = async (auth: SshOptions['auth'] = { method: 'password', password: 'test-password' }, port = first.port, acknowledge = true) => {
    const client = harness.connect(acknowledge)
    const { messages, send } = client
    send({ type: 'start', cols: 80, rows: 24, ssh: { host: '127.0.0.1', port, username: 'nova-test', auth } })
    return {
      ...client,
      trust: async (accept = true) => {
        await wait(() => messages.some((message) => message.type === 'host-key' || message.type === 'error'))
        const request = messages.find((message) => message.type === 'host-key')
        assert.ok(request?.type === 'host-key', 'First connection must ask for host trust')
        send({ type: 'host-key-response', fingerprint: request.fingerprint, accept })
        return request
      },
      ready: async () => {
        await wait(() => messages.some((message) => message.type === 'ready' || message.type === 'error'))
        assert.ok(messages.some((message) => message.type === 'ready'), JSON.stringify(messages))
      },
    }
  }
  return { ...first, connect, startRemote, directory, channels, sizes, inputs, inputBytes, authentications: () => authentications, closedChannels: () => closedChannels, connections: () => connections.size }
}

test('SSH first trust precedes authentication; shell supports Unicode, ANSI, resize and exit', { timeout: 20_000 }, async (t) => {
  const server = await fixture(t)
  const client = await server.connect()
  const request = await client.trust()
  assert.equal(server.authentications(), 0)
  await client.ready()
  assert.deepEqual(server.sizes[0], { cols: 80, rows: 24 })
  client.send({ type: 'resize', cols: 110, rows: 32 })
  await wait(() => server.sizes.some((size) => size.cols === 110 && size.rows === 32))
  client.send({ type: 'input', data: '中文 input\r' })
  await wait(() => client.output().includes('ECHO:中文 input\r'))
  const channel = server.channels[0]
  assert.ok(channel)
  const bytes = Buffer.from('\u001b[31m中文🚀\u001b[0m')
  for (const byte of bytes) channel.write(Buffer.from([byte]))
  channel.stderr.write('STDERR_OK')
  await wait(() => client.output().includes('\u001b[31m中文🚀\u001b[0m') && client.output().includes('STDERR_OK'))
  assert.ok(!client.output().includes('\ufffd'))
  const beforeClear = server.inputs.length
  client.send({ type: 'clear' })
  channel.write('AFTER_CLEAR')
  await wait(() => client.output().includes('AFTER_CLEAR'))
  assert.equal(server.inputs.length, beforeClear, 'Clear must not inject commands')
  channel.exit(7)
  channel.end()
  await wait(() => client.messages.some((message) => message.type === 'exit'))
  assert.ok(client.messages.some((message) => message.type === 'exit' && message.code === 7))
  const files = await readdir(server.directory)
  assert.equal(files.length, 1)
  const filename = files[0]
  assert.ok(filename)
  assert.deepEqual(JSON.parse(await readFile(join(server.directory, filename), 'utf8')), { host: '127.0.0.1', port: server.port, fingerprint: request.fingerprint })
})

test('rejecting first host trust sends no authentication and stores nothing', { timeout: 15_000 }, async (t) => {
  const server = await fixture(t)
  const client = await server.connect()
  await client.trust(false)
  await wait(() => client.messages.some((message) => message.type === 'error'))
  assert.equal(server.authentications(), 0)
  assert.deepEqual(await readdir(server.directory), [])
})

test('SSH receives pasted emoji intact across terminal input chunk boundaries', { timeout: 15_000 }, async (t) => {
  const server = await fixture(t)
  const client = await server.connect()
  await client.trust()
  await client.ready()
  const text = 'x'.repeat(16_383) + '🚀中文\r'
  for (const data of terminalInputChunks(text)) client.send({ type: 'input', data })
  await wait(() => server.inputs.join('').length >= text.length)
  assert.ok(server.inputs.join('') === text, 'SSH must receive the original Unicode input without replacement characters')
})

test('SSH receives legacy mouse reports as original bytes rather than UTF-8', { timeout: 15_000 }, async (t) => {
  const server = await fixture(t)
  const client = await server.connect()
  await client.trust()
  await client.ready()
  const data = '\x1b[M \x84\xff'
  client.send({ type: 'input', data, binary: true })
  await wait(() => Buffer.concat(server.inputBytes).length >= data.length)
  assert.deepEqual(Buffer.concat(server.inputBytes), Buffer.from([27, 91, 77, 32, 132, 255]))
})

test('trusted host reconnects with encrypted private key authentication', { timeout: 20_000 }, async (t) => {
  const server = await fixture(t)
  const first = await server.connect()
  await first.trust()
  await first.ready()
  await first.close()
  const next = await server.connect({ method: 'privateKey', privateKey: userKey.private, passphrase: 'test-passphrase' })
  await next.ready()
  assert.ok(!next.messages.some((message) => message.type === 'host-key'))
})

test('changed host key is blocked before authentication and never overwrites trust', { timeout: 20_000 }, async (t) => {
  const server = await fixture(t)
  const first = await server.connect()
  const request = await first.trust()
  await first.ready()
  await first.close()
  await new Promise<void>((done) => server.remote.close(() => done()))
  const previousAuth = server.authentications()
  await server.startRemote(utils.generateKeyPairSync('ed25519').private, server.port)
  const changed = await server.connect()
  await wait(() => changed.messages.some((message) => message.type === 'error'))
  assert.equal(server.authentications(), previousAuth)
  assert.ok(!changed.messages.some((message) => message.type === 'host-key' || message.type === 'ready'))
  assert.ok(changed.messages.some((message) => message.type === 'error' && message.message.includes('指纹已变化') && message.message.includes(request.fingerprint)))
})

test('authentication failure is sanitized and credentials never enter trust records', { timeout: 15_000 }, async (t) => {
  const server = await fixture(t)
  const client = await server.connect({ method: 'password', password: 'wrong-secret' })
  await client.trust()
  await wait(() => client.messages.some((message) => message.type === 'error'))
  assert.ok(client.messages.some((message) => message.type === 'error' && message.message.includes('认证失败')))
  assert.ok(!JSON.stringify(client.messages).includes('wrong-secret'))
  for (const file of await readdir(server.directory)) assert.ok(!(await readFile(join(server.directory, file), 'utf8')).includes('wrong-secret'))
})

test('closing one SSH tab only closes its channel; other connections remain interactive', { timeout: 20_000 }, async (t) => {
  const server = await fixture(t)
  const first = await server.connect()
  await first.trust()
  await first.ready()
  const second = await server.connect()
  await second.ready()
  await first.close()
  await wait(() => server.closedChannels() === 1)
  second.send({ type: 'input', data: 'STILL_ALIVE\r' })
  await wait(() => second.output().includes('ECHO:STILL_ALIVE\r'))
  assert.ok(!first.output().includes('STILL_ALIVE'))
  assert.equal(second.isOpen(), true)
})

test('SSH output pauses without ACK and resumes with bounded, valid acknowledgements', { timeout: 20_000 }, async (t) => {
  const server = await fixture(t)
  const client = await server.connect(undefined, server.port, false)
  await client.trust()
  await client.ready()
  const channel = server.channels[0]
  assert.ok(channel)
  channel.write('x'.repeat(600_000) + 'SSH_FLOW_DONE')
  await wait(() => client.output().length >= HIGH_WATER)
  await delay(250)
  const length = client.output().length
  await delay(250)
  assert.equal(client.output().length, length)
  assert.ok(length < 600_000)
  client.acknowledge()
  await wait(() => client.output().includes('SSH_FLOW_DONE'))
  client.send({ type: 'ack', count: 1_048_576 })
  await wait(() => client.messages.some((message) => message.type === 'error'))
})

test('invalid trust response and malformed existing trust store fail closed', { timeout: 20_000 }, async (t) => {
  const server = await fixture(t)
  const client = await server.connect()
  await wait(() => client.messages.some((message) => message.type === 'host-key'))
  client.send({ type: 'host-key-response', fingerprint: `SHA256:${'A'.repeat(43)}`, accept: true })
  await wait(() => client.messages.some((message) => message.type === 'error'))
  assert.equal(server.authentications(), 0)
  const trusted = await server.connect()
  await trusted.trust()
  await trusted.ready()
  await trusted.close()
  const file = (await readdir(server.directory))[0]
  assert.ok(file)
  await writeFile(join(server.directory, file), 'invalid-json')
  const corrupt = await server.connect()
  await wait(() => corrupt.messages.some((message) => message.type === 'error'))
  assert.ok(!corrupt.messages.some((message) => message.type === 'ready' || message.type === 'host-key'))
})

test('canceling host verification, malformed private keys and refused connections release resources', { timeout: 20_000 }, async (t) => {
  const server = await fixture(t)
  const canceled = await server.connect()
  await wait(() => canceled.messages.some((message) => message.type === 'host-key'))
  await canceled.close()
  await wait(() => server.connections() === 0)
  assert.equal(server.authentications(), 0)
  assert.deepEqual(await readdir(server.directory), [])
  const invalidKey = await server.connect({ method: 'privateKey', privateKey: 'invalid-private-key', passphrase: '' })
  await wait(() => invalidKey.messages.some((message) => message.type === 'error'))
  assert.ok(!invalidKey.messages.some((message) => message.type === 'ready'))
  await new Promise<void>((done) => server.remote.close(() => done()))
  const refused = await server.connect()
  await wait(() => refused.messages.some((message) => message.type === 'error'))
  assert.ok(!refused.messages.some((message) => message.type === 'ready' || message.type === 'host-key'))
})

test('concurrent first-trust requests serialize host records without losing or replacing fingerprints', { timeout: 20_000 }, async (t) => {
  const server = await fixture(t)
  const [first, second] = await Promise.all([server.connect(), server.connect()])
  await wait(() => first.messages.some((message) => message.type === 'host-key') && second.messages.some((message) => message.type === 'host-key'))
  await Promise.all([first.trust(), second.trust()])
  await Promise.all([first.ready(), second.ready()])
  assert.equal((await readdir(server.directory)).length, 1)
})
