import assert from 'node:assert/strict'
import { test } from 'node:test'
import { terminalInputChunks } from '../src/shared/terminal-input.ts'
import { MAX_INPUT, parseClientMessage } from '../src/shared/terminal-protocol.ts'

test('terminal input chunks preserve Unicode through independent UTF-8 writes', () => {
  for (const input of [
    '', '中文\r', 'x'.repeat(MAX_INPUT),
    'x'.repeat(MAX_INPUT - 1) + '🚀中文\r',
    '🚀'.repeat(MAX_INPUT) + '\r',
    'x'.repeat(MAX_INPUT - 1) + '🚀' + 'y'.repeat(MAX_INPUT - 2) + '🌏\r',
  ]) {
    const chunks = [...terminalInputChunks(input)]
    for (const data of chunks) {
      assert.ok(data.length > 0 && data.length <= MAX_INPUT)
      assert.ok(parseClientMessage(JSON.stringify({ type: 'input', data })))
    }
    assert.equal(chunks.join(''), input)
    assert.equal(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'utf8'))).toString('utf8'), input)
  }
})
