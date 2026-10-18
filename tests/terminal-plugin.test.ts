import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { test, type TestContext } from 'node:test'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { WebSocket } from 'ws'
import { attachTerminalServer } from '../server/terminal-server.ts'
import { terminalPlugin } from '../server/terminal-plugin.ts'
import { parseServerMessage } from '../src/lib/terminal-protocol.ts'

async function expectTerminalReady(app: ViteDevServer, t: TestContext) {
  const address = app.httpServer?.address()
  assert.ok(address && typeof address !== 'string')
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/terminal`, {
    origin: `http://127.0.0.1:${address.port}`,
    handshakeTimeout: 2_000,
  })
  t.after(() => socket.terminate())
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PTY did not become ready')), 10_000)
    const finish = (error?: Error) => {
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    socket.once('error', finish)
    socket.on('message', (raw) => {
      const message = parseServerMessage(raw.toString())
      if (message?.type === 'ready') finish()
      if (message?.type === 'error') finish(new Error(message.message))
    })
    socket.once('open', () => socket.send(JSON.stringify({ type: 'start', cols: 80, rows: 24 })))
  })
  await ready
  const closed = once(socket, 'close')
  socket.close()
  await closed
}

test('local PTY transport does not intercept host process termination signals', () => {
  const beforeInt = process.listeners('SIGINT')
  const beforeTerm = process.listeners('SIGTERM')
  const dispose = attachTerminalServer(createHttpServer())
  try {
    assert.deepEqual(process.listeners('SIGINT'), beforeInt)
    assert.deepEqual(process.listeners('SIGTERM'), beforeTerm)
  } finally {
    dispose()
  }
})

test('terminal remains available after an environment closes and Vite restarts', { timeout: 30_000 }, async (t) => {
  const app = await createViteServer({
    configFile: false,
    plugins: [terminalPlugin()],
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    preview: { host: '127.0.0.1' },
    logLevel: 'silent',
  })
  try {
    await app.listen()
    await expectTerminalReady(app, t)
    assert.ok(app.environments.ssr)
    await app.environments.ssr.close()
    await expectTerminalReady(app, t)
    await app.restart()
    await expectTerminalReady(app, t)
  } finally {
    await app.close()
  }
})
