import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ArrowUpIcon, DownloadIcon, FileIcon, FolderIcon, RefreshCwIcon, UploadIcon } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Progress } from '@/components/ui/progress'
import { composing } from '@shared/terminal-interactions'
import type { SftpProgress, SftpResult } from '@shared/sftp'

export function SftpBrowser({ sessionId, label, connected, onClose }: { sessionId: string; label: string; connected: boolean; onClose: () => void }) {
  const [directory, setDirectory] = useState<Extract<SftpResult, { kind: 'directory' }> | null>(null)
  const [path, setPath] = useState('.')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<SftpProgress | null>(null)
  const mounted = useRef(false)
  const running = useRef(false)
  const pathId = useId()
  const perform = useCallback(async (operation: 'list' | 'upload' | 'download', target: string) => {
    const api = window.novaSftp
    if (!api || running.current) return
    running.current = true
    setBusy(true); setError(''); setMessage(operation === 'list' ? '正在读取目录…' : '正在选择文件…'); setProgress(null)
    try {
      const result = await api[operation](sessionId, target)
      if (!mounted.current) return
      if (result?.kind === 'directory') { setDirectory(result); setPath(result.path); setMessage('') }
      else {
        setMessage(result ? `${operation === 'upload' ? '上传' : '下载'}完成：${result.name}` : '已取消文件选择。')
        if (result && operation === 'upload') {
          const listing = await api.list(sessionId, target)
          if (mounted.current && listing.kind === 'directory') { setDirectory(listing); setPath(listing.path) }
        }
      }
    } catch (failure) {
      if (mounted.current) { setMessage(''); setError(failure instanceof Error ? failure.message : '文件操作失败，请重试。') }
    } finally { running.current = false; if (mounted.current) setBusy(false) }
  }, [sessionId])
  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.novaSftp?.onProgress((event) => {
      if (event.id === sessionId && running.current) { setProgress(event); setMessage('正在传输…') }
    })
    // Deferring avoids opening a channel for a discarded StrictMode mount.
    queueMicrotask(() => { if (mounted.current) void perform('list', '.') })
    return () => { mounted.current = false; unsubscribe?.(); if (running.current) void window.novaSftp?.cancel(sessionId).catch(() => {}) }
  }, [perform, sessionId])
  const cancel = () => { void window.novaSftp?.cancel(sessionId).catch((failure: unknown) => { if (mounted.current) setError(failure instanceof Error ? failure.message : '无法取消文件操作。') }) }
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl" onEscapeKeyDown={(event) => { if (composing(event)) event.preventDefault() }}>
      <DialogHeader>
        <DialogTitle>文件传输 · {label}</DialogTitle>
        <DialogDescription>浏览远端目录，上传或下载单个文件。同名目标不会被覆盖，关闭此窗口会取消当前操作。</DialogDescription>
      </DialogHeader>
      <form onSubmit={(event) => { event.preventDefault(); if (connected && !busy) void perform('list', path) }}>
        <FieldGroup><Field><FieldLabel htmlFor={pathId}>远端目录</FieldLabel>
          <div className="flex gap-2">
            <Input id={pathId} value={path} maxLength={4096} disabled={!connected || busy} onChange={(event) => setPath(event.target.value)} />
            <Button type="submit" variant="outline" disabled={!connected || busy || !path}>打开</Button>
          </div>
        </Field></FieldGroup>
      </form>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!connected || busy || !directory || directory.path === '/'} onClick={() => { if (directory) void perform('list', `${directory.path}/..`) }}><ArrowUpIcon data-icon="inline-start" />上级目录</Button>
        <Button size="sm" variant="outline" disabled={!connected || busy || !directory} onClick={() => { if (directory) void perform('list', directory.path) }}><RefreshCwIcon data-icon="inline-start" />刷新</Button>
        <Button size="sm" disabled={!connected || busy || !directory} onClick={() => { if (directory) void perform('upload', directory.path) }}><UploadIcon data-icon="inline-start" />上传文件</Button>
      </div>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {!connected && <Alert><AlertDescription>SSH 会话已断开，请关闭此窗口后重新连接。</AlertDescription></Alert>}
      <div className="min-h-32 overflow-y-auto rounded-md border" aria-label="远端文件" aria-busy={busy}>
        {directory?.entries.length ? <ul className="divide-y">
          {directory.entries.map((entry) => <li key={entry.name} className="flex min-w-0 items-center gap-2 px-3 py-1">
            {entry.kind === 'directory' ? <FolderIcon className="size-4 shrink-0" aria-hidden="true" /> : <FileIcon className="size-4 shrink-0" aria-hidden="true" />}
            {entry.kind === 'directory' ? <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start" disabled={!connected || busy} onClick={() => { void perform('list', `${directory.path === '/' ? '' : directory.path}/${entry.name}`) }}><span className="truncate">{entry.name}</span></Button> : <span className="min-w-0 flex-1 truncate" title={entry.name}>{entry.name}</span>}
            <span className="shrink-0 text-xs text-muted-foreground">{entry.kind === 'file' ? `${entry.size.toLocaleString()} B` : entry.kind === 'directory' ? '目录' : '其他'}</span>
            {entry.kind === 'file' && <Button variant="ghost" size="icon-sm" aria-label={`下载 ${entry.name}`} title={`下载 ${entry.name}`} disabled={!connected || busy} onClick={() => { void perform('download', `${directory.path === '/' ? '' : directory.path}/${entry.name}`) }}><DownloadIcon /></Button>}
          </li>)}
        </ul> : <Empty><EmptyHeader><EmptyTitle>{directory ? '目录为空' : '尚未读取目录'}</EmptyTitle></EmptyHeader></Empty>}
      </div>
      <div className="flex flex-col gap-2" role="status" aria-live="polite">
        {progress && <><Progress aria-label="文件传输进度" value={progress.total ? progress.transferred / progress.total * 100 : busy ? 0 : 100} /><span className="text-xs text-muted-foreground">{progress.transferred.toLocaleString()} / {progress.total.toLocaleString()} B</span></>}
        <p className="min-h-5 text-sm text-muted-foreground">{message}</p>
      </div>
      <DialogFooter>{busy && <Button variant="outline" onClick={cancel}>取消操作</Button>}<Button variant="outline" onClick={onClose}>关闭</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
