export type SearchPoint = { line: number; offset: number }
export type RegexSearchRequest = { lines: string[]; query: string; caseSensitive: boolean; previous: boolean; anchor: SearchPoint }
export type RegexSearchResult = { match: { line: number; start: number; end: number } | null; invalid?: true }

// Called only in a terminable worker in the application, never on the renderer thread.
export function matchRegex({ lines, query, caseSensitive, previous, anchor }: RegexSearchRequest): RegexSearchResult {
  let regex: RegExp
  try { regex = new RegExp(query, caseSensitive ? 'gu' : 'giu') } catch { return { match: null, invalid: true } }
  let first: RegexSearchResult['match'] = null
  let last: RegexSearchResult['match'] = null
  let before: RegexSearchResult['match'] = null
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line] ?? ''
    regex.lastIndex = 0
    for (const found of text.matchAll(regex)) {
      // Zero-width assertions do not select terminal cells.
      if (!found[0].length) continue
      const match = { line, start: found.index, end: found.index + found[0].length }
      first ??= match
      last = match
      const precedes = line < anchor.line || line === anchor.line && match.start < anchor.offset
      if (precedes) before = match
      else if (!previous) return { match }
    }
  }
  return { match: previous ? before ?? last : first }
}
