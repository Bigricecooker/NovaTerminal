export const MAX_SESSIONS = 4
export const MAX_INPUT = 16_384
export const MAX_BUFFER = 1_048_576
export const HIGH_WATER = 131_072
export const LOW_WATER = 32_768
export const SSH_START_TIMEOUT = 120_000

export type SshOptions = {
  host: string; port: number; username: string
  auth: { method: 'password'; password: string } | { method: 'privateKey'; privateKey: string; passphrase: string }
}

export type SshEndpoint = Pick<SshOptions, 'host' | 'port' | 'username'>

export type ClientMessage =
  | { type: 'start'; cols: number; rows: number; ssh?: SshOptions; cwd?: string }
  | { type: 'host-key-response'; fingerprint: string; accept: boolean }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ack'; count: number }
  | { type: 'clear' }

export type ServerMessage =
  | { type: 'ready'; shell: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string }
  | { type: 'host-key'; host: string; port: number; fingerprint: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function dimension(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= max
}

export function parseLocalDirectory(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 4096
    || Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || !(/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\'))) return null
  return value
}

export function parseSshEndpoint(value: unknown): SshEndpoint | null {
  if (!isRecord(value) || typeof value.host !== 'string' || value.host.length > 253
    || !/^[a-zA-Z0-9:.][a-zA-Z0-9:._-]*$/.test(value.host)
    || (!dimension(value.port, 65_535) && value.port !== 1)
    || typeof value.username !== 'string' || value.username.length === 0 || value.username.length > 128
    || /\s/.test(value.username) || Array.from(value.username).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null
  return { host: value.host.toLowerCase(), port: value.port, username: value.username }
}

export function parseSshOptions(value: unknown): SshOptions | null {
  const base = parseSshEndpoint(value)
  if (!base || !isRecord(value) || !isRecord(value.auth)) return null
  if (value.auth.method === 'password' && typeof value.auth.password === 'string'
    && value.auth.password.length > 0 && value.auth.password.length <= 4096) {
    return { ...base, auth: { method: 'password', password: value.auth.password } }
  }
  if (value.auth.method === 'privateKey' && typeof value.auth.privateKey === 'string'
    && value.auth.privateKey.length > 0 && value.auth.privateKey.length <= 65_536
    && typeof value.auth.passphrase === 'string' && value.auth.passphrase.length <= 4096) {
    return { ...base, auth: { method: 'privateKey', privateKey: value.auth.privateKey, passphrase: value.auth.passphrase } }
  }
  return null
}

function fingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value)
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'clear': return { type: 'clear' }
    case 'host-key-response':
      return fingerprint(value.fingerprint) && typeof value.accept === 'boolean'
        ? { type: 'host-key-response', fingerprint: value.fingerprint, accept: value.accept } : null
    case 'start': {
      if (!dimension(value.cols, 500) || !dimension(value.rows, 300)) return null
      if (value.ssh === undefined) {
        if (value.cwd === undefined) return { type: 'start', cols: value.cols, rows: value.rows }
        const cwd = parseLocalDirectory(value.cwd)
        return cwd ? { type: 'start', cols: value.cols, rows: value.rows, cwd } : null
      }
      if (value.cwd !== undefined) return null
      const ssh = parseSshOptions(value.ssh)
      return ssh ? { type: 'start', cols: value.cols, rows: value.rows, ssh } : null
    }
    case 'resize':
      return dimension(value.cols, 500) && dimension(value.rows, 300)
        ? { type: value.type, cols: value.cols, rows: value.rows } : null
    case 'input':
      return typeof value.data === 'string' && value.data.length > 0 && value.data.length <= MAX_INPUT
        ? { type: 'input', data: value.data } : null
    case 'ack':
      return typeof value.count === 'number' && Number.isInteger(value.count) && value.count > 0 && value.count <= MAX_BUFFER
        ? { type: 'ack', count: value.count } : null
    default: return null
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'host-key':
      return typeof value.host === 'string' && value.host.length <= 253
        && typeof value.port === 'number' && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65_535
        && fingerprint(value.fingerprint)
        ? { type: 'host-key', host: value.host, port: value.port, fingerprint: value.fingerprint } : null
    case 'ready':
      return typeof value.shell === 'string' ? { type: 'ready', shell: value.shell } : null
    case 'output':
      return typeof value.data === 'string' && value.data.length <= MAX_INPUT
        ? { type: 'output', data: value.data } : null
    case 'exit':
      return typeof value.code === 'number' && Number.isInteger(value.code)
        ? { type: 'exit', code: value.code } : null
    case 'error':
      return typeof value.message === 'string' ? { type: 'error', message: value.message } : null
    default: return null
  }
}
