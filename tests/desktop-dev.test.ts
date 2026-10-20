import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'

test('desktop Vite serves the renderer from the loopback development origin', { timeout: 20_000 }, async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'silent' })
  try {
    await server.listen()
    assert.ok(server.config.root.replaceAll('\\', '/').endsWith('/src/renderer'))
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const page = await fetch(origin)
    assert.equal(page.status, 200)
    assert.equal(page.headers.get('content-security-policy'), "frame-ancestors 'none'")
    assert.match(await page.text(), /<title>NovaTerminal<\/title>/)
    const entry = await fetch(`${origin}/src/main.tsx`)
    assert.equal(entry.status, 200)
    assert.match(await entry.text(), /react-dom/)
    assert.ok(!server.config.server.https)
    assert.equal(server.config.server.host, '127.0.0.1')
  } finally { await server.close() }
})
