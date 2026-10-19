import { resolve, relative, isAbsolute } from 'node:path'
import { parseClientMessage } from '../shared/terminal-protocol.ts'

export const APP_URL = 'app://novaterminal/index.html'
export const DEV_URL = 'http://127.0.0.1:5180/'
export const MAX_IPC_SIZE = 262_144

export function trustedFrame(senderId: number, ownerId: number, mainFrame: boolean, url: string, expected: string): boolean {
  return senderId === ownerId && mainFrame && url === expected
}

export function sessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
}

export function desktopMessage(value: unknown) {
  if (typeof value !== 'string' || value.length > MAX_IPC_SIZE) return null
  return parseClientMessage(value)
}

export function assetPath(root: string, input: string): string | null {
  try {
    const url = new URL(input)
    if (url.protocol !== 'app:' || url.host !== 'novaterminal' || url.username || url.password || url.search) return null
    const name = decodeURIComponent(url.pathname)
    if (name.includes('\\') || name.includes('\0')) return null
    const target = resolve(root, `.${name === '/' ? '/index.html' : name}`)
    const part = relative(root, target)
    return part.startsWith('..') || isAbsolute(part) ? null : target
  } catch { return null }
}
