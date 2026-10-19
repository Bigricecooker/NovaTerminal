import { spawn } from 'node:child_process'
import electron from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { createServer } from 'vite'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NOVA_DEV_SERVER
const dev = process.argv.includes('--dev')
let server
if (dev) {
  server = await createServer({ mode: 'desktop', server: { host: '127.0.0.1', port: 5180, strictPort: true }, logLevel: 'error' })
  await server.listen()
  env.NOVA_DEV_SERVER = 'http://127.0.0.1:5180/'
}
const temporary = await mkdtemp(join(tmpdir(), 'novaterminal-desktop-test-'))
env.APPDATA = temporary
env.XDG_CONFIG_HOME = temporary
env.NOVA_TEST_PROFILE = temporary
const args = ['scripts/electron-smoke.cjs']
if (process.argv[2] && !dev) args.push(resolve(process.argv[2]))
const child = spawn(electron, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let passed = false
let cleanupFailed = false
child.stdout.on('data', (data) => { process.stdout.write(data); if (data.toString().includes('Desktop smoke passed:')) passed = true })
child.stderr.on('data', (data) => { process.stderr.write(data); if (data.toString().includes('Shell remains')) cleanupFailed = true })
child.once('error', () => { process.exitCode = 1 })
child.once('exit', async (code) => {
  process.exitCode = code === 0 && passed && !cleanupFailed ? 0 : 1
  await server?.close()
  if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith('novaterminal-desktop-test-')) throw new Error('Unexpected test cleanup path')
  await rm(temporary, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
})
