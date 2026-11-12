import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ArrowUpIcon, DownloadIcon, FileIcon, FolderIcon, RefreshCwIcon, UploadIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import type { SftpProgress, SftpResult } from '@shared/sftp'

export function SftpBrowser({ sessionId, label, active, connected, terminalDirectory, onClose }: {
  sessionId: string; label: string; active: boolean; connected: boolean; terminalDirectory: string | null; onClose: () => void
}) {
  const [directory, setDirectory] = useState<(Extract<SftpResult, { kind: 'directory' }> & { requestedPath: string }) | null>(null)
  const [path, setPath] = useState('.')
  const [follow, setFollow] = useState(true)
  const [attemptedPath, setAttemptedPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<SftpProgress | null>(null)
  const mounted = useRef(false)
  const running = useRef(false)
  const followVersion = useRef(0)
  const pathId = useId()
  const followPath = follow ? terminalDirectory ?? '.' : null
  const canTransfer = connected && !busy && directory !== null && path === directory.path
    && (!followPath || directory.requestedPath === followPath)
  const perform = useCallback(async (operation: 'list' | 'upload' | 'download', target: string, version?: number) => {
    const api = window.novaSftp
    const discarded = () => version !== undefined && version !== followVersion.current
    if (!api || running.current || discarded()) return
    running.current = true
    if (operation === 'list') setAttemptedPath(target)
    setBusy(true); setError(''); setMessage(operation === 'list' ? '正在读取目录…' : '正在选择文件…'); setProgress(null)
    try {
      const result = await api[operation](sessionId, target)
      if (!mounted.current || discarded()) return
      if (result?.kind === 'directory') { setDirectory({ ...result, requestedPath: target }); setPath(result.path); setMessage('') }
      else {
        setMessage(result ? `${operation === 'upload' ? '上传' : '下载'}完成：${result.name}` : '已取消文件选择。')
        if (result && operation === 'upload') {
          const listing = await api.list(sessionId, target)
          if (mounted.current && listing.kind === 'directory') {
            setDirectory((current) => current && { ...listing, requestedPath: current.requestedPath })
            setPath(listing.path)
          }
        }
      }
    } catch (failure) {
      if (mounted.current && !discarded()) { setMessage(''); setError(failure instanceof Error ? failure.message : '文件操作失败，请重试。') }
    } finally {
      running.current = false
      if (mounted.current) {
        if (discarded()) setMessage('')
        setBusy(false)
      }
    }
  }, [sessionId])
  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.novaSftp?.onProgress((event) => {
      if (event.id === sessionId && running.current) { setProgress(event); setMessage('正在传输…') }
    })
    return () => { mounted.current = false; unsubscribe?.(); if (running.current) void window.novaSftp?.cancel(sessionId).catch(() => {}) }
  }, [sessionId])
  useEffect(() => {
    if (!active || !connected || busy || !followPath || attemptedPath === followPath) return
    const version = followVersion.current
    const timer = window.setTimeout(() => { void perform('list', followPath, version) }, 200)
    return () => window.clearTimeout(timer)
  }, [active, connected, busy, followPath, attemptedPath, perform])
  const setFollowing = (enabled: boolean) => {
    setFollow(enabled)
    if (enabled) setAttemptedPath(null)
    else followVersion.current += 1
  }
  const browse = (target: string) => { setFollowing(false); void perform('list', target) }
  const cancel = () => { void window.novaSftp?.cancel(sessionId).catch((failure: unknown) => { if (mounted.current) setError(failure instanceof Error ? failure.message : '无法取消文件操作。') }) }
  return (
    <aside aria-label={`文件传输 · ${label}`} className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto border-t bg-background p-3 text-sm lg:w-96 lg:max-w-1/2 lg:flex-none lg:border-t-0 lg:border-l">
      <div className="flex shrink-0 items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate font-medium" title={label}>文件传输 · {label}</h2>
        {busy && <Button size="sm" variant="outline" onClick={cancel}>取消操作</Button>}
        <Button size="sm" variant="ghost" onClick={onClose}>关闭</Button>
      </div>
      <Field orientation="horizontal" className="shrink-0">
        <FieldLabel htmlFor={`${pathId}-follow`}>跟随终端目录</FieldLabel>
        <Switch id={`${pathId}-follow`} checked={follow} disabled={!connected} onCheckedChange={setFollowing} />
      </Field>
      {connected && follow && !terminalDirectory && <p className="shrink-0 text-xs text-muted-foreground">等待远端 Shell 报告目录，可手动浏览。</p>}
      <form className="shrink-0" onSubmit={(event) => { event.preventDefault(); if (connected && !busy) browse(path) }}>
        <FieldGroup><Field><FieldLabel htmlFor={pathId}>远端目录</FieldLabel>
          <div className="flex gap-2">
            <Input id={pathId} value={path} maxLength={4096} disabled={!connected || busy} onChange={(event) => { setFollowing(false); setPath(event.target.value) }} />
            <Button type="submit" variant="outline" disabled={!connected || busy || !path}>打开</Button>
          </div>
        </Field></FieldGroup>
      </form>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!connected || busy || !directory || directory.path === '/'} onClick={() => { if (directory) browse(`${directory.path}/..`) }}><ArrowUpIcon data-icon="inline-start" />上级目录</Button>
        <Button size="sm" variant="outline" disabled={!connected || busy} onClick={() => { void perform('list', followPath ?? directory?.path ?? '.') }}><RefreshCwIcon data-icon="inline-start" />刷新</Button>
        <Button size="sm" disabled={!canTransfer} onClick={() => { if (canTransfer) void perform('upload', directory.path) }}><UploadIcon data-icon="inline-start" />上传文件</Button>
      </div>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {!connected && <Alert><AlertDescription>SSH 会话已断开，请重新连接。</AlertDescription></Alert>}
      <div className="min-h-24 flex-1 overflow-y-auto rounded-md border" aria-label="远端文件" aria-busy={busy}>
        {directory?.entries.length ? <ul className="divide-y">
          {directory.entries.map((entry) => <li key={entry.name} className="flex min-w-0 items-center gap-2 px-3 py-1">
            {entry.kind === 'directory' ? <FolderIcon className="size-4 shrink-0" aria-hidden="true" /> : <FileIcon className="size-4 shrink-0" aria-hidden="true" />}
            {entry.kind === 'directory' ? <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start" disabled={!connected || busy} onClick={() => { browse(`${directory.path === '/' ? '' : directory.path}/${entry.name}`) }}><span className="truncate">{entry.name}</span></Button> : <span className="min-w-0 flex-1 truncate" title={entry.name}>{entry.name}</span>}
            <span className="shrink-0 text-xs text-muted-foreground">{entry.kind === 'file' ? `${entry.size.toLocaleString()} B` : entry.kind === 'directory' ? '目录' : '其他'}</span>
            {entry.kind === 'file' && <Button variant="ghost" size="icon-sm" aria-label={`下载 ${entry.name}`} title={`下载 ${entry.name}`} disabled={!canTransfer} onClick={() => { void perform('download', `${directory.path === '/' ? '' : directory.path}/${entry.name}`) }}><DownloadIcon /></Button>}
          </li>)}
        </ul> : <Empty><EmptyHeader><EmptyTitle>{directory ? '目录为空' : '尚未读取目录'}</EmptyTitle></EmptyHeader></Empty>}
      </div>
      <div className="flex shrink-0 flex-col gap-2" role="status" aria-live="polite">
        {progress && <><Progress aria-label="文件传输进度" value={progress.total ? progress.transferred / progress.total * 100 : busy ? 0 : 100} /><span className="text-xs text-muted-foreground">{progress.transferred.toLocaleString()} / {progress.total.toLocaleString()} B</span></>}
        <p className="min-h-5 text-sm text-muted-foreground">{message}</p>
      </div>
    </aside>
  )
}
