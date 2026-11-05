export const SFTP_CHANNELS = { list: 'sftp:list', upload: 'sftp:upload', download: 'sftp:download', cancel: 'sftp:cancel', progress: 'sftp:progress' } as const
export const MAX_DIRECTORY_ENTRIES = 1_000
export type SftpEntry = { name: string; kind: 'directory' | 'file' | 'other'; size: number }
export type SftpResult = { kind: 'directory'; path: string; entries: SftpEntry[] } | { kind: 'file'; name: string }
export type SftpProgress = { id: string; transferred: number; total: number }
export type DesktopSftpApi = {
  list: (id: string, path: string) => Promise<SftpResult>
  upload: (id: string, directory: string) => Promise<SftpResult | null>
  download: (id: string, path: string) => Promise<SftpResult | null>
  cancel: (id: string) => Promise<void>
  onProgress: (listener: (event: SftpProgress) => void) => () => void
}
export type SftpRequest = { type: 'sftp'; requestId: string; operation: 'list' | 'upload' | 'download'; path: string; localPath?: string }
export type SftpEvent = { type: 'sftp-result'; requestId: string; result?: SftpResult; error?: string }
  | { type: 'sftp-progress'; requestId: string; transferred: number; total: number }

export function remotePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096 && !/\p{Cc}/u.test(value)
}
export function remoteName(value: unknown): value is string {
  return remotePath(value) && value.length <= 255 && value !== '.' && value !== '..' && !/[\\/]/.test(value)
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
export function sftpRequest(value: unknown): value is SftpRequest {
  return record(value) && value.type === 'sftp' && typeof value.requestId === 'string' && /^[a-f0-9-]{36}$/.test(value.requestId)
    && remotePath(value.path) && (value.operation === 'list' && value.localPath === undefined
      || (value.operation === 'upload' || value.operation === 'download') && remotePath(value.localPath))
}
function size(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
export function sftpEvent(value: unknown): value is SftpEvent {
  if (!record(value) || typeof value.requestId !== 'string') return false
  if (value.type === 'sftp-progress') return size(value.transferred) && size(value.total) && value.transferred <= value.total
  if (value.type !== 'sftp-result') return false
  if (typeof value.error === 'string') return value.error.length <= 512 && value.result === undefined
  const result = value.result
  if (!record(result)) return false
  if (result.kind === 'file') return remoteName(result.name)
  return result.kind === 'directory' && remotePath(result.path) && Array.isArray(result.entries) && result.entries.length <= MAX_DIRECTORY_ENTRIES
    && result.entries.every((entry: unknown) => record(entry) && remoteName(entry.name) && size(entry.size)
      && (entry.kind === 'file' || entry.kind === 'directory' || entry.kind === 'other'))
}
