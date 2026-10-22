import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, parseSettings } from '../src/shared/settings.ts'
import { createSettingsStore } from '../src/main/settings-store.ts'
import { resolveLocalShell } from '../src/server/local-shell.ts'

test('settings validate numbers, enums, booleans and platform paths, dropping unknown fields', () => {
  assert.deepEqual(parseSettings({ secret: 'discard' }, 'win32'), DEFAULT_SETTINGS)
  for (const raw of [{ fontSize: 9 }, { fontSize: 14.1 }, { lineHeight: 1.03 }, { scrollback: 1500 }, { maxSessions: 9 },
    { cursorBlink: 'true' }, { theme: 'other' }, { shell: 'bash' }, { shell: 'cmd /c echo' }, { directory: 'relative' }, { directory: 'C:\\bad\npath' }]) {
    assert.throws(() => parseSettings(raw, 'win32'))
  }
  assert.equal(parseSettings({ lineHeight: 1.35, directory: 'C:\\data' }, 'win32').lineHeight, 1.35)
  assert.throws(() => parseSettings({ shell: 'cmd' }, 'linux'))
  assert.equal(parseSettings({ shell: 'zsh', directory: '/tmp' }, 'darwin').shell, 'zsh')
})
test('settings persist atomically, isolate profiles and preserve previous state on failed saves', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-settings-'))
  try {
    const file = join(directory, 'desktop.json')
    const store = createSettingsStore(file, 'win32')
    assert.equal(store.warning(), '')
    store.save({ theme: 'dark', maxSessions: 6 })
    assert.equal(createSettingsStore(file, 'win32').get().theme, 'dark')
    assert.equal(createSettingsStore(join(directory, 'development.json'), 'win32').get().theme, 'system')
    assert.throws(() => store.save({ fontSize: 25 }))
    assert.equal(store.get().maxSessions, 6)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).values.maxSessions, 6)
    rmSync(file)
    mkdirSync(file)
    assert.throws(() => store.save({ theme: 'light' }), /保存失败/)
    assert.equal(store.get().theme, 'dark')
    assert.ok(readdirSync(directory).every((name) => !name.endsWith('.tmp')))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test('invalid settings are quarantined with defaults and a recovery warning', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-settings-'))
  try {
    const file = join(directory, 'desktop.json')
    writeFileSync(file, '{broken')
    const store = createSettingsStore(file, 'win32')
    assert.deepEqual(store.get(), DEFAULT_SETTINGS)
    assert.match(store.warning(), /恢复默认/)
    const backup = readdirSync(directory).find((name) => name.startsWith('settings.corrupt-'))
    assert.ok(backup)
    assert.equal(readFileSync(join(directory, backup), 'utf8'), '{broken')
    store.save({ theme: 'light' })
    assert.equal(store.warning(), '')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test('explicit unavailable shells fail without fallback', () => {
  assert.throws(() => resolveLocalShell('bash', 'win32'), /不支持/)
  assert.throws(() => resolveLocalShell('pwsh', 'win32', { ProgramFiles: join(tmpdir(), 'nova-no-shell') }), /不可用/)
  assert.throws(() => resolveLocalShell('default', 'linux', { SHELL: '/nova-no-such-shell' }), /不可用/)
})
