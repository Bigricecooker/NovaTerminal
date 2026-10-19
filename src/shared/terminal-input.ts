import { MAX_INPUT } from './terminal-protocol.ts'

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
