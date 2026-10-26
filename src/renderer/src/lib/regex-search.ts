import type { Terminal } from '@xterm/xterm'
import type { RegexSearchResult } from '@shared/regex-search'

const MAX_TEXT = 4_194_304
const TIMEOUT = 500
type Fragment = { row: number; text: string }
type LogicalLine = { text: string; fragments: Fragment[] }

export function createRegexSearch(terminal: Terminal) {
  let cancel = () => {}
  return {
    cancel: () => cancel(),
    find(query: string, caseSensitive: boolean, previous: boolean, incremental: boolean): Promise<string> {
      cancel()
      return new Promise((resolve) => {
        let done = false
        let worker: Worker | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        const listeners: { dispose: () => void }[] = []
        const finish = (message: string) => {
          if (done) return
          done = true
          clearTimeout(timer)
          if (worker) {
            worker.onmessage = null
            worker.onerror = null
            worker.terminate()
          }
          cancel = () => {}
          listeners.forEach((listener) => listener.dispose())
          resolve(message)
        }
        cancel = () => finish('')
        const changed = () => finish('终端内容已变化，请重新搜索')
        listeners.push(terminal.onWriteParsed(changed), terminal.onResize(changed), terminal.buffer.onBufferChange(changed))
        const buffer = terminal.buffer.active
        const selected = terminal.getSelectionPosition()
        const origin = selected ? (previous || incremental ? selected.start : selected.end) : { x: 0, y: previous ? buffer.length : 0 }
        const lines: LogicalLine[] = []
        let row = 0
        let size = 0
        const snapshot = () => {
          try { readSnapshot() } catch { finish('无法搜索当前缓冲区') }
        }
        const readSnapshot = () => {
          if (done) return
          const until = Math.min(row + 128, buffer.length)
          for (; row < until; row++) {
            const line = buffer.getLine(row)
            if (!line) continue
            const next = buffer.getLine(row + 1)
            let text = line.translateToString(!next?.isWrapped, 0, terminal.cols)
            // xterm inserts a padding cell when a wide character wraps at the right edge.
            const tail = line.getCell(terminal.cols - 1)
            if (next?.isWrapped && tail?.getCode() === 0 && tail.getWidth() === 1 && next.getCell(0)?.getWidth() === 2) text = text.slice(0, -1)
            size += text.length
            if (size > MAX_TEXT) { finish('缓冲区过大，请缩小回滚行数后重试正则搜索'); return }
            let logical = lines.at(-1)
            if (!line.isWrapped || !logical) { logical = { text: '', fragments: [] }; lines.push(logical) }
            logical.text += text
            logical.fragments.push({ row, text })
          }
          if (row < buffer.length) { timer = setTimeout(snapshot, 0); return }
          let anchor = { line: lines.length, offset: 0 }
          for (let index = 0; index < lines.length; index++) {
            let offset = 0
            for (const fragment of lines[index]?.fragments ?? []) {
              if (fragment.row === origin.y) {
                anchor = { line: index, offset: offset + (buffer.getLine(origin.y)?.translateToString(false, 0, origin.x).length ?? 0) }
                break
              }
              offset += fragment.text.length
            }
            if (anchor.line !== lines.length) break
          }
          try {
            worker = new Worker(new URL('./regex-search.worker.ts', import.meta.url), { type: 'module' })
            timer = setTimeout(() => finish('正则搜索超时，请简化表达式'), TIMEOUT)
            worker.onerror = (event) => { event.preventDefault(); finish('无法搜索当前缓冲区') }
            worker.onmessage = (event: MessageEvent<RegexSearchResult>) => {
              if (done) return
              const { match, invalid } = event.data
              if (invalid) { finish('正则表达式无效'); return }
              if (!match) { terminal.clearSelection(); finish('没有匹配项'); return }
              const logical = lines[match.line]
              const position = (offset: number, end: boolean) => {
                for (const fragment of logical?.fragments ?? []) {
                  if (offset < fragment.text.length || end && offset === fragment.text.length || fragment === logical?.fragments.at(-1)) {
                    const line = buffer.getLine(fragment.row)
                    let consumed = 0
                    let column = 0
                    while (line && column < terminal.cols && consumed < offset) {
                      const cell = line.getCell(column)
                      const width = cell?.getWidth() ?? 1
                      const length = width ? (cell?.getChars() || ' ').length : 0
                      if (consumed + length > offset) {
                        if (end) column += Math.max(1, width)
                        break
                      }
                      consumed += length
                      column += Math.max(1, width)
                    }
                    return { row: fragment.row, column }
                  }
                  offset -= fragment.text.length
                }
                return null
              }
              const start = position(match.start, false)
              const end = position(match.end, true)
              if (!start || !end) { finish('无法搜索当前缓冲区'); return }
              terminal.select(start.column, start.row, (end.row - start.row) * terminal.cols + end.column - start.column)
              terminal.scrollToLine(start.row)
              finish('已选中匹配项')
            }
            worker.postMessage({ lines: lines.map((line) => line.text), query, caseSensitive, previous, anchor })
          } catch { finish('无法搜索当前缓冲区') }
        }
        snapshot()
      })
    },
  }
}
