import { MAX_INPUT, parseClientMessage, type ClientMessage } from './terminal-protocol.ts'
import { MAX_PASTE } from './terminal-interactions.ts'

export const MAX_PENDING_INPUT = 131_072
export type InputMessage = Extract<ClientMessage, { type: 'input' }>
export type DesktopMessage = ClientMessage | InputMessage[]

export function parseDesktopMessage(raw: string): DesktopMessage | null {
  const single = parseClientMessage(raw)
  if (single) return single
  if (raw.length > MAX_PENDING_INPUT) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!Array.isArray(value) || !value.length || value.length > Math.ceil((MAX_PASTE + 12) / MAX_INPUT)) return null
  const messages: InputMessage[] = []
  let length = 0
  for (const item of value) {
    const message = parseClientMessage(JSON.stringify(item))
    if (message?.type !== 'input') return null
    length += message.data.length
    messages.push(message)
  }
  return length <= MAX_PASTE + 12 ? messages : null
}

export function* terminalInputChunks(data: string): Generator<string> {
  for (let offset = 0; offset < data.length;) {
    let end = Math.min(offset + MAX_INPUT, data.length)
    // Each chunk is encoded separately by PTY / SSH; keep surrogate pairs intact.
    const previous = data.charCodeAt(end - 1)
    const next = data.charCodeAt(end)
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
    yield data.slice(offset, end)
    offset = end
  }
}
