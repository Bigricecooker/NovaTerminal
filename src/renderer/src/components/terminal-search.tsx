import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ArrowUpIcon, ArrowDownIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Field, FieldLabel } from '@/components/ui/field'
import { composing } from '@shared/terminal-interactions'
import type { SearchAddon } from '@xterm/addon-search'
import type { createRegexSearch } from '@/lib/regex-search'

export function TerminalSearch({ search, regexSearch, onClear, onClose }: { search: SearchAddon; regexSearch: ReturnType<typeof createRegexSearch>; onClear: () => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [message, setMessage] = useState('')
  const id = useId()
  const composingRef = useRef(false)
  const request = useRef(0)
  const find = useCallback((previous = false, incremental = false) => {
    if (!search || composingRef.current) return
    const current = ++request.current
    regexSearch.cancel()
    if (!query) { onClear(); setMessage(''); return }
    if (regex) {
      search.clearDecorations()
      setMessage('正在搜索…')
      void regexSearch.find(query, caseSensitive, previous, incremental).then((result) => {
        if (request.current === current) setMessage(result)
      })
      return
    }
    try {
      const matched = previous ? search.findPrevious(query, { caseSensitive, incremental }) : search.findNext(query, { caseSensitive, incremental })
      setMessage(matched ? '已选中匹配项' : '没有匹配项')
    } catch { setMessage('无法搜索当前缓冲区') }
  }, [search, regexSearch, query, regex, caseSensitive, onClear])
  useEffect(() => {
    const sequence = request
    const timer = setTimeout(() => find(false, true), 150)
    return () => { clearTimeout(timer); sequence.current++; regexSearch.cancel() }
  }, [find, regexSearch])
  return <div className="flex h-20 shrink-0 flex-col justify-center gap-1 border-b p-2" role="search" aria-label="搜索当前终端" onKeyDown={(event) => {
    if (composing(event.nativeEvent)) return
    if (event.key === 'Escape') { event.preventDefault(); onClose() }
    if (event.key === 'Enter') { event.preventDefault(); find(event.shiftKey) }
  }}>
    <div className="flex min-w-0 items-center gap-1"><Input autoFocus className="min-w-0 flex-1" aria-label="终端搜索" maxLength={256} value={query} onChange={(event) => setQuery(event.target.value)}
      onCompositionStart={() => { composingRef.current = true }} onCompositionEnd={() => { composingRef.current = false; find() }} />
    <Button size="icon-xs" variant="ghost" aria-label="上一个匹配" onClick={() => find(true)}><ArrowUpIcon /></Button>
    <Button size="icon-xs" variant="ghost" aria-label="下一个匹配" onClick={() => find()}><ArrowDownIcon /></Button>
    <Button size="icon-xs" variant="ghost" aria-label="关闭搜索" onClick={onClose}><XIcon /></Button>
    </div><div className="flex min-w-0 items-center gap-2">
      <Field orientation="horizontal" className="w-auto shrink-0"><Switch id={`${id}-case`} aria-label="区分大小写" checked={caseSensitive} onCheckedChange={setCaseSensitive} /><FieldLabel htmlFor={`${id}-case`}>区分大小写</FieldLabel></Field>
      <Field orientation="horizontal" className="w-auto shrink-0"><Switch id={`${id}-regex`} aria-label="正则" checked={regex} onCheckedChange={setRegex} /><FieldLabel htmlFor={`${id}-regex`}>正则</FieldLabel></Field>
      <span role="status" className="truncate text-xs text-muted-foreground">{message}</span>
    </div>
  </div>
}
