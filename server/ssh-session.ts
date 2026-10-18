import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import ssh2, { type ClientChannel, type ConnectConfig } from 'ssh2'
import { HIGH_WATER, LOW_WATER, MAX_BUFFER, MAX_INPUT, SSH_START_TIMEOUT, type ClientMessage, type ServerMessage, type SshOptions } from '../src/lib/terminal-protocol.ts'
import type { KnownHosts } from './known-hosts.ts'

const { Client } = ssh2

export function createSshSession(
  options: SshOptions, cols: number, rows: number,
  knownHosts: KnownHosts, send: (message: ServerMessage) => void,
) {
  const { host, port, username } = options
  const client = new Client()
  let channel: ClientChannel | undefined
  let finished = false
  let pending = 0
  let paused = false
  let lastAck = Date.now()
  let exitCode = 0
  let verification: { fingerprint: string; done: (trusted: boolean) => void } | undefined
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')

  const close = () => {
    if (finished) return
    finished = true
    clearInterval(watchdog)
    verification = undefined
    channel?.destroy()
    client.destroy()
  }
  const fail = (message: string) => {
    if (finished) return
    close()
    send({ type: 'error', message })
  }
  const output = (data: string) => {
    if (finished || !data) return
    pending += data.length
    if (pending > MAX_BUFFER) { fail('SSH 输出超过缓冲限制，会话已关闭。'); return }
    for (let offset = 0; offset < data.length; offset += MAX_INPUT) {
      send({ type: 'output', data: data.slice(offset, offset + MAX_INPUT) })
    }
    if (pending >= HIGH_WATER && !paused) {
      paused = true
      lastAck = Date.now()
      channel?.pause()
      channel?.stderr.pause()
    }
  }
  const watchdog = setInterval(() => {
    if (paused && Date.now() - lastAck > 30_000) fail('SSH 输出确认超时，会话已关闭。')
  }, 5_000)
  watchdog.unref()

  const config: ConnectConfig = {
    host, port, username,
    readyTimeout: SSH_START_TIMEOUT, keepaliveInterval: 15_000, keepaliveCountMax: 3,
    hostVerifier: (key: Buffer, callback: (trusted: boolean) => void) => {
      const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
      void knownHosts.lookup(host, port).then((previous) => {
        if (finished) return
        if (previous === fingerprint) { callback(true); return }
        if (previous !== null) {
          fail(`SSH 主机指纹已变化，连接已阻止。已记录：${previous}；当前：${fingerprint}。请联系服务器管理员核实。`)
          return
        }
        verification = { fingerprint, done: callback }
        send({ type: 'host-key', host, port, fingerprint })
      }).catch(() => fail('无法读取 SSH 主机指纹记录，连接已阻止。'))
    },
    ...(options.auth.method === 'password'
      ? { password: options.auth.password, authHandler: ['password'] }
      : { privateKey: options.auth.privateKey, passphrase: options.auth.passphrase, authHandler: ['publickey'] }),
  }

  client.on('error', (error: Error & { level?: string }) => {
    fail(error.level === 'client-authentication'
      ? 'SSH 认证失败，请检查用户名、密码或私钥。'
      : 'SSH 连接失败，请检查主机、端口、网络及服务器配置。')
  })
  client.on('close', () => {
    if (!finished) fail('SSH 连接已断开。')
  })
  client.on('ready', () => {
    // Do not retain authentication material in our connection configuration.
    delete config.password
    delete config.privateKey
    delete config.passphrase
    client.shell({ term: 'xterm-256color', cols, rows }, (error, stream) => {
      if (finished) { stream?.destroy(); return }
      if (error) { fail('服务器无法打开交互式 SSH 终端。'); return }
      channel = stream
      send({ type: 'ready', shell: `${username}@${host}:${port}` })
      stream.on('data', (data: Buffer) => output(stdoutDecoder.write(data)))
      stream.stderr.on('data', (data: Buffer) => output(stderrDecoder.write(data)))
      stream.stderr.on('error', () => fail('SSH 标准错误通道异常，会话已关闭。'))
      stream.on('exit', (code: number | null) => { exitCode = code ?? 128 })
      stream.on('error', () => fail('SSH 终端通道异常，会话已关闭。'))
      stream.on('close', () => {
        if (finished) return
        for (const decoder of [stdoutDecoder, stderrDecoder]) output(decoder.end())
        if (finished) return
        close()
        send({ type: 'exit', code: exitCode })
      })
    })
  })

  // Start on the next microtask so the owner has installed its cleanup handle.
  queueMicrotask(() => {
    if (finished) return
    try { client.connect(config) }
    catch { fail('无法启动 SSH 连接，请检查私钥格式及连接参数。') }
  })

  return {
    close,
    handle: (message: ClientMessage) => {
      if (finished) return
      if (message.type === 'host-key-response') {
        const request = verification
        if (!request || request.fingerprint !== message.fingerprint) { fail('SSH 主机指纹确认无效。'); return }
        verification = undefined
        if (!message.accept) { fail('已拒绝 SSH 主机指纹，连接已取消。'); return }
        void knownHosts.trust(host, port, request.fingerprint).then(() => {
          if (!finished) request.done(true)
        }).catch(() => fail('无法安全保存主机指纹，连接已阻止。'))
        return
      }
      if (!channel) { fail('SSH 尚未连接，无法发送终端操作。'); return }
      switch (message.type) {
        case 'input':
          if (channel.writableLength + Buffer.byteLength(message.data) > 65_536) {
            fail('SSH 输入缓冲已满，会话已关闭。'); return
          }
          channel.write(message.data)
          break
        case 'resize': channel.setWindow(message.rows, message.cols, 0, 0); break
        case 'clear': break // xterm clears locally; never inject commands into the remote Shell.
        case 'ack':
          if (message.count > pending) { fail('SSH 输出确认无效。'); return }
          pending -= message.count
          lastAck = Date.now()
          if (paused && pending <= LOW_WATER) {
            paused = false
            channel.resume()
            channel.stderr.resume()
          }
          break
        case 'start': fail('SSH 会话已经启动。'); break
      }
    },
  }
}

export type SshSession = ReturnType<typeof createSshSession>
