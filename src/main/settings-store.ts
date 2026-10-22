import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_SETTINGS, parseSettings, record, type Platform } from '../shared/settings.ts'

export function atomicWrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = join(dirname(file), `.nova-${randomUUID()}.tmp`)
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, file)
  } finally { try { unlinkSync(temporary) } catch { /* Already renamed or never created. */ } }
}
export function createSettingsStore(file: string, platform: Platform) {
  let values = { ...DEFAULT_SETTINGS }
  let warning = ''
  try {
    if (statSync(file).size > 65_536) throw new Error('Settings too large')
    const document: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!record(document) || document.version !== 1) throw new Error('Unsupported settings')
    values = parseSettings(document.values, platform)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      warning = '设置无法读取，已恢复默认。'
      try { renameSync(file, join(dirname(file), `settings.corrupt-${Date.now()}-${randomUUID()}.json`)) } catch { /* Preserve inaccessible evidence in place. */ }
    }
  }
  return {
    get: () => ({ ...values }),
    warning: () => warning,
    save: (raw: unknown) => {
      const next = parseSettings(raw, platform)
      const text = JSON.stringify({ version: 1, values: next }, null, 2)
      if (Buffer.byteLength(text) > 65_536) throw new Error('设置文件过大。')
      try { atomicWrite(file, text) } catch { throw new Error('设置保存失败，请检查磁盘空间与目录权限。') }
      values = next
      warning = ''
      return { ...values }
    },
  }
}
