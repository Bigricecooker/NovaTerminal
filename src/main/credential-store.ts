import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { credentialId, parseSshOptions, type SavedSshConnection, type SshOptions } from '../shared/terminal-protocol.ts'

export type CredentialProtector = { available: () => boolean; encrypt: (value: string) => Buffer; decrypt: (value: Buffer) => string }
const MAX_SIZE = 524_288
const UNAVAILABLE = '系统安全存储不可用，无法保存或使用 SSH 认证信息。请解锁系统密钥库后重试。'
const MISSING = '此连接的认证信息缺失、损坏或与端点不匹配，请删除此连接后重新添加。'
const hasCode = (error: unknown, code: string) => error instanceof Error && 'code' in error && error.code === code

// The renderer can write and remove credentials, but cannot retrieve decrypted values.
export function createCredentialStore(directory: string, protector: CredentialProtector) {
  const file = (id: unknown) => { if (!credentialId(id)) throw new Error('无效的 SSH 连接引用。'); return join(directory, `asset-${id}.bin`) }
  const available = () => { if (!protector.available()) throw new Error(UNAVAILABLE) }
  return {
    save: (id: unknown, raw: unknown) => {
      const target = file(id)
      const options = parseSshOptions(raw)
      if (!options) throw new Error('SSH 认证配置无效。')
      available()
      const temporary = `${target}.${randomUUID()}.tmp`
      let failed = false
      let published = false
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        if (readdirSync(directory).filter((name) => name.endsWith('.bin')).length >= 500) throw new Error('Credential limit')
        const encrypted = protector.encrypt(JSON.stringify({ version: 1, options }))
        if (!encrypted.length || encrypted.length > MAX_SIZE) throw new Error('Invalid ciphertext size')
        writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 })
        // Never overwrite another asset's existing credential record.
        linkSync(temporary, target)
        published = true
      } catch { failed = true }
      try { unlinkSync(temporary) } catch (error) { if (!hasCode(error, 'ENOENT')) failed = true }
      if (failed) {
        if (published) { try { unlinkSync(target) } catch { /* Report failure without exposing paths or ciphertext. */ } }
        throw new Error('无法安全保存 SSH 认证信息，请检查系统密钥库和本机存储。')
      }
    },
    load: (reference: SavedSshConnection): SshOptions => {
      const target = file(reference.assetId)
      available()
      try {
        const info = lstatSync(target)
        if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > MAX_SIZE) throw new Error('Invalid ciphertext')
        const document: unknown = JSON.parse(protector.decrypt(readFileSync(target)))
        if (typeof document !== 'object' || document === null || !('version' in document) || document.version !== 1 || !('options' in document)) throw new Error('Invalid record')
        const options = parseSshOptions(document.options)
        if (!options || options.host !== reference.host || options.port !== reference.port || options.username !== reference.username) throw new Error('Endpoint mismatch')
        return options
      } catch { throw new Error(MISSING) }
    },
    remove: (raw: unknown) => {
      if (!Array.isArray(raw) || raw.length > 500 || !raw.every(credentialId)) throw new Error('无效的 SSH 连接引用。')
      let failed = false
      for (const id of new Set(raw)) {
        try { unlinkSync(file(id)) } catch (error) { if (!hasCode(error, 'ENOENT')) failed = true }
      }
      if (failed) throw new Error('无法删除 SSH 加密认证信息，请检查本机存储权限。')
    },
  }
}
