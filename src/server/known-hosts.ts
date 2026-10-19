import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const defaultKnownHostsDirectory = join(
  process.platform === 'win32' ? process.env.APPDATA ?? homedir() : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
  'NovaTerminal', 'known-hosts',
)

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

export function createKnownHosts(directory = defaultKnownHostsDirectory) {
  let writing = Promise.resolve()
  const file = (host: string, port: number) => join(directory, `${createHash('sha256').update(JSON.stringify([host, port])).digest('hex')}.json`)
  const read = async (host: string, port: number): Promise<string | null> => {
    try {
      const path = file(host, port)
      if ((await stat(path)).size > 1024) throw new Error('Invalid host record')
      const value: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (typeof value !== 'object' || value === null || !('fingerprint' in value)
        || !('host' in value) || value.host !== host || !('port' in value) || value.port !== port
        || typeof value.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value.fingerprint)) {
        throw new Error('Invalid host record')
      }
      return value.fingerprint
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return null
      throw error
    }
  }
  return {
    lookup: async (host: string, port: number) => { await writing; return read(host, port) },
    trust: (host: string, port: number, fingerprint: string) => {
      const operation = writing.then(async () => {
        const previous = await read(host, port)
        if (previous !== null) {
          if (previous !== fingerprint) throw new Error('Host key changed')
          return
        }
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const target = file(host, port)
        const temporary = `${target}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, JSON.stringify({ host, port, fingerprint }), { flag: 'wx', mode: 0o600 })
          try {
            // Publish a complete record atomically without replacing another process's trust.
            await link(temporary, target)
          } catch (error) {
            if (!hasCode(error, 'EEXIST')) throw error
            if (await read(host, port) !== fingerprint) throw new Error('Host key changed', { cause: error })
          }
        } finally {
          await unlink(temporary).catch((error: unknown) => { if (!hasCode(error, 'ENOENT')) throw error })
        }
      })
      writing = operation.catch(() => {})
      return operation
    },
  }
}

export type KnownHosts = ReturnType<typeof createKnownHosts>
