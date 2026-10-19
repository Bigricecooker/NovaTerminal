import { packager } from '@electron/packager'
import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const electronPackage = JSON.parse(await readFile('node_modules/electron/package.json', 'utf8'))
if (electronPackage.version !== pkg.devDependencies.electron) throw new Error('Electron version mismatch; run npm ci')
const checksums = JSON.parse(await readFile('node_modules/electron/checksums.json', 'utf8'))
const keep = new Set(['package.json', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.txt', 'licenses', 'dist', 'out', 'node_modules'])
const outputs = await packager({
  dir: '.', name: 'NovaTerminal', executableName: 'NovaTerminal', out: 'release',
  platform: process.platform, arch: process.arch, electronVersion: pkg.devDependencies.electron,
  appVersion: pkg.version, overwrite: true, prune: true,
  download: { checksums },
  asar: { unpack: '**/*.node', unpackDir: '**/node_modules/node-pty/**' },
  ignore: (filename) => {
    if (!filename) return false
    const normalized = filename.replaceAll('\\', '/').replace(/^\/+/, '')
    if (normalized === 'node_modules/.cache' || normalized.startsWith('node_modules/.cache/')) return true
    const root = normalized.split('/')[0]
    return root ? !keep.has(root) : false
  },
})
for (const output of outputs) console.log(output)
