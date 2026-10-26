import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchRegex, type RegexSearchRequest } from '../src/shared/regex-search.ts'

const request: RegexSearchRequest = { lines: ['first ABC 12', '中😀 second abc 34', 'last ABC 56'], query: 'abc \\d+', caseSensitive: false, previous: false, anchor: { line: 0, offset: 0 } }

test('regex matching supports case, direction, anchors and wrap-around', () => {
  assert.deepEqual(matchRegex(request).match, { line: 0, start: 6, end: 12 })
  assert.deepEqual(matchRegex({ ...request, anchor: { line: 0, offset: 12 } }).match, { line: 1, start: 11, end: 17 })
  assert.deepEqual(matchRegex({ ...request, caseSensitive: true }).match, { line: 1, start: 11, end: 17 })
  assert.deepEqual(matchRegex({ ...request, previous: true }).match, { line: 2, start: 5, end: 11 })
  assert.deepEqual(matchRegex({ ...request, previous: true, anchor: { line: 1, offset: 11 } }).match, { line: 0, start: 6, end: 12 })
  assert.deepEqual(matchRegex({ ...request, anchor: { line: 3, offset: 0 } }).match, { line: 0, start: 6, end: 12 })
})

test('invalid, empty-width and Unicode regular expressions complete deterministically', () => {
  assert.equal(matchRegex({ ...request, query: '(' }).invalid, true)
  assert.equal(matchRegex({ ...request, query: '^|$' }).match, null)
  assert.deepEqual(matchRegex({ ...request, query: '中😀' }).match, { line: 1, start: 0, end: 3 })
  assert.equal(matchRegex({ ...request, query: 'missing' }).match, null)
})
