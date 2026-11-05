import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, link, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Client, SFTPWrapper, FileEntryWithStats } from 'ssh2'
import { MAX_DIRECTORY_ENTRIES, remoteName, remotePath, type SftpEntry, type SftpEvent, type SftpRequest, type SftpResult } from '../shared/sftp.ts'

export function createSftpOperations(client: Client, send: (event: SftpEvent) => void) {
  let active: { abort: AbortController; done: Promise<void> } | undefined
  const run = async (request: SftpRequest, abort: AbortController): Promise<SftpResult> => {
    const { signal } = abort
    let sftp: SFTPWrapper | undefined
    let temporary: string | undefined
    let remoteTemporary = false
    let idle: ReturnType<typeof setTimeout> | undefined
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => abort.abort(new Error('SFTP 操作超时，请检查网络后重试。')), 30_000) }
    const call = <T>(invoke: (callback: (error: Error | undefined | null, value: T) => void) => void): Promise<T> => new Promise((resolve, reject) => {
      signal.throwIfAborted()
      const cancelled = () => { reject(signal.reason) }
      signal.addEventListener('abort', cancelled, { once: true })
      invoke((error, value) => {
        signal.removeEventListener('abort', cancelled)
        if (signal.aborted) { reject(signal.reason); return }
        touch()
        if (error) reject(error); else resolve(value)
      })
    })
    touch()
    try {
      sftp = await call<SFTPWrapper>((callback) => client.sftp((error, channel) => {
        if (signal.aborted) channel?.end()
        callback(error, channel)
      }))
      const channel = sftp
      channel.on('error', () => abort.abort(new Error('SFTP 通道异常，请重试。')))
      channel.on('close', () => abort.abort(new Error('SFTP 通道已关闭，请重试。')))
      if (request.operation === 'list') {
        const path = await call<string>((callback) => channel.realpath(request.path, callback))
        if (!remotePath(path)) throw new Error('远端目录路径无效。')
        const handle = await call<Buffer>((callback) => channel.opendir(path, callback))
        const entries: SftpEntry[] = []
        const names = new Set<string>()
        let count = 0
        try {
          for (;;) {
            const batch = await call<FileEntryWithStats[] | false>((callback) => channel.readdir(handle, (error, entries) => {
              if (error && 'code' in error && error.code === 1) callback(undefined, false)
              else callback(error, entries)
            }))
            if (batch === false) break
            if (!Array.isArray(batch)) throw new Error('远端目录响应无效。')
            count += Math.max(1, batch.length)
            if (count > MAX_DIRECTORY_ENTRIES + 2) throw new Error('目录超过 1000 项，请打开更小的子目录。')
            for (const item of batch) {
              if (!remoteName(item.filename) || names.has(item.filename)) continue
              names.add(item.filename)
              const size = item.attrs.size
              entries.push({ name: item.filename, kind: item.attrs.isDirectory() ? 'directory' : item.attrs.isFile() ? 'file' : 'other', size: Number.isSafeInteger(size) && size >= 0 ? size : 0 })
            }
            if (entries.length > MAX_DIRECTORY_ENTRIES) throw new Error('目录超过 1000 项，请打开更小的子目录。')
          }
        } finally { await call<void>((callback) => channel.close(handle, callback)).catch(() => {}) }
        entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
        return { kind: 'directory', path, entries }
      }
      const localPath = request.localPath
      if (!localPath || !isAbsolute(localPath)) throw new Error('本地文件路径无效。')
      let transferred = 0
      let lastProgress = 0
      const meter = (total: number) => async function* (source: AsyncIterable<Buffer>) {
        send({ type: 'sftp-progress', requestId: request.requestId, transferred: 0, total })
        for await (const chunk of source) {
          signal.throwIfAborted()
          transferred += chunk.length
          if (transferred > total) throw new Error('源文件大小已变化，请重试。')
          touch()
          if (Date.now() - lastProgress >= 100) { lastProgress = Date.now(); send({ type: 'sftp-progress', requestId: request.requestId, transferred, total }) }
          yield chunk
        }
        if (transferred !== total) throw new Error('源文件大小已变化，请重试。')
      }
      let total: number
      let name: string
      if (request.operation === 'upload') {
        name = basename(localPath)
        if (!remoteName(name)) throw new Error('文件名不支持上传。')
        const directory = await call<string>((callback) => channel.realpath(request.path, callback))
        if (!remotePath(directory)) throw new Error('远端目录路径无效。')
        const destination = posix.join(directory, name)
        const file = await open(localPath, constants.O_RDONLY | constants.O_NONBLOCK)
        try {
          const info = await file.stat()
          if (!info.isFile() || !Number.isSafeInteger(info.size)) throw new Error('只支持传输普通文件。')
          total = info.size
          const temp = posix.join(directory, `.novaterminal-${randomUUID()}.part`)
          const handle = await call<Buffer>((callback) => channel.open(temp, 'wx', 0o600, callback))
          temporary = temp; remoteTemporary = true
          await pipeline(file.createReadStream({ highWaterMark: 65_536, autoClose: true }), meter(total), channel.createWriteStream(temp, { handle, autoClose: true, highWaterMark: 65_536 }), { signal })
          signal.throwIfAborted()
          // SFTP v3 RENAME refuses existing targets; do not use the overwriting POSIX extension.
          await call<void>((callback) => channel.rename(temp, destination, callback))
          temporary = undefined
        } finally { await file.close() }
      } else {
        name = posix.basename(request.path)
        if (!remoteName(name)) throw new Error('远端文件名无效。')
        const info = await call<import('ssh2').Stats>((callback) => channel.lstat(request.path, callback))
        if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0) throw new Error('只支持下载普通文件。')
        total = info.size
        const temp = join(dirname(localPath), `.novaterminal-${randomUUID()}.part`)
        const file = await open(temp, 'wx', 0o600)
        temporary = temp
        try {
          await pipeline(channel.createReadStream(request.path, { highWaterMark: 65_536 }), meter(total), file.createWriteStream({ autoClose: true, highWaterMark: 65_536 }), { signal })
        } finally { await file.close() }
        signal.throwIfAborted()
        await link(temp, localPath)
      }
      send({ type: 'sftp-progress', requestId: request.requestId, transferred: total, total })
      return { kind: 'file', name }
    } finally {
      clearTimeout(idle)
      if (temporary) {
        if (remoteTemporary && sftp) {
          const channel = sftp, temp = temporary
          await Promise.race([new Promise<void>((resolve) => channel.unlink(temp, () => resolve())), new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1_000); timer.unref() })])
        } else await unlink(temporary).catch(() => {})
      }
      sftp?.end()
    }
  }
  return {
    request: (request: SftpRequest) => {
      if (active) { send({ type: 'sftp-result', requestId: request.requestId, error: '该会话正在处理其他文件操作。' }); return }
      const abort = new AbortController()
      const done = run(request, abort).then((result) => { send({ type: 'sftp-result', requestId: request.requestId, result }) }, (error: unknown) => {
        const reason: unknown = abort.signal.aborted ? abort.signal.reason : error
        const message = reason instanceof Error && /^(?:[\u4e00-\u9fff]|SFTP )/.test(reason.message) ? reason.message : 'SFTP 操作失败，请检查权限、目标是否已存在及服务端支持。'
        send({ type: 'sftp-result', requestId: request.requestId, error: message.slice(0, 512) })
      }).finally(() => { active = undefined })
      active = { abort, done }
    },
    cancel: () => { active?.abort.abort(new Error('已取消文件操作。')) },
    close: async () => { active?.abort.abort(new Error('SSH 会话已关闭，文件操作已取消。')); await active?.done },
  }
}
