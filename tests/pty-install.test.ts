import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('macOS install repairs only installed spawn helpers and can run twice', { skip: process.platform !== 'darwin' }, () => {
  const temporary = mkdtempSync(join(tmpdir(), 'nova-pty-install-'))
  try {
    const root = join(temporary, 'node_modules/node-pty')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), '{}')
    const script = join(temporary, 'fix-pty-permissions.mjs')
    copyFileSync(new URL('../scripts/fix-pty-permissions.mjs', import.meta.url), script)
    const helpers = ['build/Release', `prebuilds/darwin-${process.arch}`].map((directory) => {
      mkdirSync(join(root, directory), { recursive: true })
      const helper = join(root, directory, 'spawn-helper')
      writeFileSync(helper, 'fixture')
      chmodSync(helper, 0o644)
      return helper
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      for (const helper of helpers) assert.equal(statSync(helper).mode & 0o777, 0o755)
    }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})
