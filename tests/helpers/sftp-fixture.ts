import { once } from 'node:events'
import { posix } from 'node:path'
import ssh2, { type Connection, type ServerChannel } from 'ssh2'

// Temporary in-memory protocol server; no user files or credentials are used.
export async function sftpFixture() {
  const files = new Map<string, Buffer>([['/home/test/hello.txt', Buffer.from('中文\0binary🚀')]])
  const connections = new Set<Connection>()
  const shells: ServerChannel[] = []
  const directories = new Set(['/', '/home', '/home/test', '/home/test/empty'])
  let slow = false
  let supported = true
  let extraNames: string[] = []
  let authentications = 0
  let channels = 0
  const { STATUS_CODE: status, OPEN_MODE: flags } = ssh2.utils.sftp
  const server = new ssh2.Server({ hostKeys: [ssh2.utils.generateKeyPairSync('ed25519').private] }, (connection) => {
    connections.add(connection)
    connection.on('error', () => {})
    connection.on('close', () => connections.delete(connection))
    connection.on('authentication', (context) => {
      authentications++
      if (context.method === 'password' && context.username === 'test' && context.password === 'temporary') context.accept()
      else context.reject()
    })
    connection.on('ready', () => connection.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty?.())
      session.on('shell', (acceptShell) => {
        const shell = acceptShell(); shells.push(shell)
        shell.on('error', () => {})
        shell.on('data', (data: Buffer) => shell.write(data))
      })
      session.on('sftp', (acceptSftp, reject) => {
        if (!supported) { reject(); return }
        const channel = acceptSftp(); channels++
        let closed = false
        channel.on('error', () => {})
        channel.on('close', () => { channels--; closed = true })
        const handles = new Map<string, { path: string; directory: boolean; read: boolean }>()
        let next = 0
        const pathOf = (path: string) => posix.resolve('/home/test', path)
        const attrs = (path: string) => ({ mode: directories.has(path) ? 0o40755 : 0o100600, size: files.get(path)?.length ?? 0, uid: 0, gid: 0, atime: 0, mtime: 0 })
        channel.on('REALPATH', (id, path) => channel.name(id, [{ filename: pathOf(path), longname: '', attrs: attrs(pathOf(path)) }]))
        channel.on('LSTAT', (id, path) => {
          const actual = pathOf(path)
          if (files.has(actual) || directories.has(actual)) channel.attrs(id, attrs(actual)); else channel.status(id, status.NO_SUCH_FILE)
        })
        channel.on('FSTAT', (id, handle) => {
          const resource = handles.get(handle.toString())
          if (resource) channel.attrs(id, attrs(resource.path)); else channel.status(id, status.FAILURE)
        })
        channel.on('OPENDIR', (id, path) => {
          const actual = pathOf(path)
          if (!directories.has(actual)) { channel.status(id, status.NO_SUCH_FILE); return }
          const key = String(++next); handles.set(key, { path: actual, directory: true, read: false }); channel.handle(id, Buffer.from(key))
        })
        channel.on('READDIR', (id, handle) => {
          const resource = handles.get(handle.toString())
          if (!resource || resource.read) { channel.status(id, status.EOF); return }
          resource.read = true
          const paths = [...directories, ...files.keys()].filter((path) => path !== resource.path && posix.dirname(path) === resource.path)
          channel.name(id, [...paths.map((path) => ({ filename: posix.basename(path), longname: '', attrs: attrs(path) })), ...extraNames.map((name) => ({ filename: name, longname: '', attrs: attrs('/file') }))])
        })
        channel.on('OPEN', (id, path, mode) => {
          const actual = pathOf(path)
          if (mode & flags.EXCL && files.has(actual)) { channel.status(id, status.FAILURE); return }
          if (mode & flags.CREAT) files.set(actual, Buffer.alloc(0))
          if (!files.has(actual)) { channel.status(id, status.NO_SUCH_FILE); return }
          const key = String(++next); handles.set(key, { path: actual, directory: false, read: false }); channel.handle(id, Buffer.from(key))
        })
        channel.on('READ', (id, handle, offset, length) => {
          const resource = handles.get(handle.toString()), data = resource && files.get(resource.path)
          const reply = () => {
            if (closed) return
            if (!data || offset >= data.length) channel.status(id, status.EOF)
            else channel.data(id, data.subarray(offset, offset + Math.min(length, 32_768)))
          }
          if (slow) setTimeout(reply, 150); else reply()
        })
        channel.on('WRITE', (id, handle, offset, data) => {
          const resource = handles.get(handle.toString()), previous = resource && files.get(resource.path)
          if (!resource || !previous) { channel.status(id, status.FAILURE); return }
          const next = Buffer.alloc(Math.max(previous.length, offset + data.length)); previous.copy(next); data.copy(next, offset)
          files.set(resource.path, next)
          if (slow) setTimeout(() => { if (!closed) channel.status(id, status.OK) }, 150)
          else channel.status(id, status.OK)
        })
        channel.on('CLOSE', (id, handle) => { handles.delete(handle.toString()); channel.status(id, status.OK) })
        channel.on('REMOVE', (id, path) => { files.delete(pathOf(path)); channel.status(id, status.OK) })
        channel.on('RENAME', (id, source, destination) => {
          const from = pathOf(source), to = pathOf(destination), data = files.get(from)
          if (!data || files.has(to) || directories.has(to)) { channel.status(id, status.FAILURE); return }
          files.set(to, data); files.delete(from); channel.status(id, status.OK)
        })
      })
    }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture address')
  return {
    port: address.port, files, shells,
    authCount: () => authentications, channelCount: () => channels,
    slow: (value: boolean) => { slow = value }, supported: (value: boolean) => { supported = value }, names: (value: string[]) => { extraNames = value },
    close: async () => { for (const connection of connections) connection.end(); await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}
