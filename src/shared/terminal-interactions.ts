export const MAX_COPY = 1_048_576
export const MAX_PASTE = 65_536
export type Phase = 'connecting' | 'verifying' | 'running' | 'closed' | 'error'
export const phaseLabels: Record<Phase, string> = { connecting: '连接中', verifying: '待确认指纹', running: '运行中', closed: '已结束', error: '连接失败' }
export function activePhase(phase: Phase) { return phase === 'connecting' || phase === 'verifying' || phase === 'running' }
export type KeyInput = { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; isComposing: boolean; keyCode: number }
export function composing(event: Pick<KeyInput, 'isComposing' | 'keyCode'>) { return event.isComposing || event.keyCode === 229 }
export function workspaceKey(event: KeyInput, mac: boolean): 'new' | 'close' | 'next' | 'previous' | 'settings' | number | null {
  if (composing(event) || event.altKey) return null
  if (event.ctrlKey && !event.metaKey && event.key === 'Tab') return event.shiftKey ? 'previous' : 'next'
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!primary) return null
  if (!event.shiftKey && /^[1-8]$/.test(event.key)) return Number(event.key) - 1
  if (!event.shiftKey && event.key === ',') return 'settings'
  if (event.shiftKey === !mac) {
    if (event.key.toLowerCase() === 't') return 'new'
    if (event.key.toLowerCase() === 'w') return 'close'
  }
  return null
}
export function externalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 2048 || raw !== raw.trim()
    || Array.from(raw).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || raw.includes('\\')) return null
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null
    const host = url.hostname.replace(/\.$/, '')
    if (!host.startsWith('[') && (host.length > 253 || !host.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part)))) return null
    if (url.href.length > 2048) return null
    return url.href
  } catch { return null }
}
