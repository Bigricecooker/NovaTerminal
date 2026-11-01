import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

if (process.platform === 'darwin') {
  const root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
  // node-pty 1.1.0 ships macOS helpers without execute permission.
  for (const directory of ['build/Release', 'build/Debug', `prebuilds/darwin-${process.arch}`]) {
    const helper = join(root, directory, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
