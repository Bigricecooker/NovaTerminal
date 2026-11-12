import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { remoteName, remotePath, sftpEvent, sftpRequest, sshWorkingDirectory } from '../src/shared/sftp.ts'
import { sessionHarness, wait } from './helpers/session-client.ts'
import { sftpFixture } from './helpers/sftp-fixture.ts'

test('SSH directory reports decode bounded absolute paths on the current host', () => {
  const host = 'server.example'
  assert.equal(sshWorkingDirectory('file://SERVER.example/home/%E4%B8%AD%E6%96%87%20%23%25', host), '/home/中文 #%')
  assert.equal(sshWorkingDirectory('file:///linked/../dir', host), '/linked/../dir')
  assert.equal(sshWorkingDirectory('file://[::1]/', '::1'), '/')
  for (const report of ['https://server.example/path', 'file://other.example/path', 'file://user@server.example/path',
    'file://server.example:22/path', 'file://server.example', 'file:relative', 'file:///a?x', 'file:///a#x',
    'file:///bad%ZZ', 'file:///bad%00', 'file:///bad%0A', 'file:///bad\tpath', 'file:///bad\\path',
    'file:///' + 'x'.repeat(4096), 'file:///' + '%61'.repeat(14_000)]) {
    assert.equal(sshWorkingDirectory(report, host), null)
  }
})

test('SFTP validates bounded paths, names, requests, listings and progress', () => {
  assert.ok(remotePath('/home/中文'))
  for (const path of ['', '/a\0b', '/a\nb', 'x'.repeat(4097), null]) assert.equal(remotePath(path), false)
  for (const name of ['..', '.', '../file', 'a\\b', '/absolute', 'x'.repeat(256)]) assert.equal(remoteName(name), false)
  const request = { type: 'sftp', requestId: randomUUID(), operation: 'list', path: '.' }
  assert.ok(sftpRequest(request))
  assert.equal(sftpRequest({ ...request, operation: 'exec' }), false)
  assert.equal(sftpRequest({ ...request, operation: 'download' }), false)
  assert.equal(sftpRequest({ ...request, localPath: '/secret' }), false)
  assert.ok(sftpEvent({ type: 'sftp-result', requestId: request.requestId, result: { kind: 'directory', path: '/', entries: [] } }))
  assert.equal(sftpEvent({ type: 'sftp-progress', requestId: request.requestId, transferred: 2, total: 1 }), false)
  assert.equal(sftpEvent({ type: 'sftp-result', requestId: request.requestId, result: { kind: 'directory', path: '/', entries: [{ name: '../escape', kind: 'file', size: 0 }] } }), false)
})

test('real SFTP shares SSH trust, streams files, protects existing targets, cancels and leaves the shell alive', { timeout: 45_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'nova-sftp-test-'))
  const remote = await sftpFixture()
  const harness = sessionHarness(t, join(temporary, 'known-hosts'))
  t.after(async () => { await remote.close(); await rm(temporary, { recursive: true, force: true }) })
  const client = harness.connect()
  client.send({ type: 'start', cols: 80, rows: 24, ssh: { host: '127.0.0.1', port: remote.port, username: 'test', auth: { method: 'password', password: 'temporary' } } })
  assert.throws(() => client.sftp({ operation: 'list', path: '.' }), /已连接/)
  await wait(() => client.messages.some((event) => event.type === 'host-key'))
  const key = client.messages.find((event) => event.type === 'host-key')
  assert.ok(key?.type === 'host-key')
  assert.equal(remote.authCount(), 0)
  client.send({ type: 'host-key-response', fingerprint: key.fingerprint, accept: true })
  await wait(() => client.messages.some((event) => event.type === 'ready'))
  const list = await client.sftp({ operation: 'list', path: '.' })
  assert.equal(list.kind, 'directory')
  assert.ok(list.kind === 'directory' && list.path === '/home/test' && list.entries[0]?.kind === 'directory')
  const content = Buffer.concat([Buffer.from('中文🚀\0'), Buffer.alloc(600_000, 171)])
  const source = join(temporary, '上传.bin'), destination = join(temporary, 'download.bin')
  await writeFile(source, content)
  assert.equal((await client.sftp({ operation: 'upload', path: '/home/test', localPath: source })).kind, 'file')
  assert.deepEqual(remote.files.get('/home/test/上传.bin'), content)
  await client.sftp({ operation: 'download', path: '/home/test/上传.bin', localPath: destination })
  assert.deepEqual(await readFile(destination), content)
  assert.ok(client.progress().some((event) => event.transferred === content.length && event.total === content.length))
  await assert.rejects(client.sftp({ operation: 'upload', path: '/home/test', localPath: source }), /SFTP 操作失败/)
  await assert.rejects(client.sftp({ operation: 'download', path: '/home/test/hello.txt', localPath: destination }), /SFTP 操作失败/)
  assert.deepEqual(await readFile(destination), content)
  assert.deepEqual(remote.files.get('/home/test/上传.bin'), content)
  assert.ok([...remote.files.keys()].every((name) => !name.endsWith('.part')))
  assert.ok((await readdir(temporary)).every((name) => !name.endsWith('.part')))
  const emptySource = join(temporary, 'empty.bin'), emptyDownload = join(temporary, 'empty-download.bin')
  await writeFile(emptySource, Buffer.alloc(0))
  await client.sftp({ operation: 'upload', path: '/home/test', localPath: emptySource })
  await client.sftp({ operation: 'download', path: '/home/test/empty.bin', localPath: emptyDownload })
  assert.equal((await readFile(emptyDownload)).length, 0)
  remote.slow(true)
  const before = client.progress().length
  const cancelled = client.sftp({ operation: 'download', path: '/home/test/上传.bin', localPath: join(temporary, 'cancel.bin') })
  const rejected = assert.rejects(cancelled, /取消/)
  assert.throws(() => client.sftp({ operation: 'list', path: '.' }), /其他文件操作/)
  await wait(() => client.progress().slice(before).some((event) => event.transferred > 0))
  client.send({ type: 'input', data: 'SFTP_SHELL_ALIVE' })
  await wait(() => client.output().includes('SFTP_SHELL_ALIVE'))
  client.cancelSftp()
  await rejected
  assert.ok(!(await readdir(temporary)).includes('cancel.bin'))
  assert.ok((await readdir(temporary)).every((name) => !name.endsWith('.part')))
  const uploadCancelledSource = join(temporary, 'cancel-upload.bin')
  await writeFile(uploadCancelledSource, content)
  const uploadProgress = client.progress().length
  const cancelledUpload = assert.rejects(client.sftp({ operation: 'upload', path: '/home/test', localPath: uploadCancelledSource }), /取消/)
  await wait(() => client.progress().slice(uploadProgress).some((event) => event.transferred > 0))
  client.cancelSftp(); await cancelledUpload
  assert.equal(remote.files.has('/home/test/cancel-upload.bin'), false)
  assert.ok([...remote.files.keys()].every((name) => !name.endsWith('.part')))
  remote.slow(false)
  remote.names(['../escape', 'bad\nname'])
  const filtered = await client.sftp({ operation: 'list', path: '.' })
  assert.ok(filtered.kind === 'directory' && filtered.entries.every((entry) => remoteName(entry.name)))
  remote.names(Array.from({ length: 1001 }, (_, i) => `file-${i}`))
  await assert.rejects(client.sftp({ operation: 'list', path: '.' }), /1000/)
  remote.names([]); remote.supported(false)
  await assert.rejects(client.sftp({ operation: 'list', path: '.' }), /SFTP 操作失败/)
  client.send({ type: 'input', data: 'AFTER_SFTP_FAILURE' })
  await wait(() => client.output().includes('AFTER_SFTP_FAILURE'))
  assert.equal(remote.authCount(), 1, 'SFTP reuses the authenticated connection')
  remote.supported(true); remote.slow(true)
  const lastProgress = client.progress().length
  const interrupted = client.sftp({ operation: 'download', path: '/home/test/上传.bin', localPath: join(temporary, 'closed.bin') })
  const closed = assert.rejects(interrupted, /会话已关闭/)
  await wait(() => client.progress().slice(lastProgress).some((event) => event.transferred > 0))
  await client.close(); await closed
  assert.ok((await readdir(temporary)).every((name) => !name.endsWith('.part') && name !== 'closed.bin'))
})
