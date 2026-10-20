import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import type { TestContext } from 'node:test'
import { createDesktopSessions } from '../../src/main/sessions.ts'
import type { ClientMessage, ServerMessage } from '../../src/shared/terminal-protocol.ts'

export async function wait(condition: () => boolean) {
  const deadline = Date.now() + 12_000
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for session output or state')
    await delay(20)
  }
}

export function sessionHarness(t: TestContext, directory?: string) {
  const clients = new Map<string, { receive: (message: ServerMessage) => void; closed: () => void }>()
  const exits: Promise<void>[] = []
  const sessions = createDesktopSessions(() => {
    const child = fork(fileURLToPath(new URL('../fixtures/session-worker.ts', import.meta.url)), directory ? [directory] : [], {
      execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    exits.push(new Promise<void>((done) => child.once('close', () => done())))
    return {
      postMessage: (message) => {
        if (typeof message !== 'object' || message === null) throw new Error('Invalid test worker message')
        if (!child.connected || !child.send(message, (error) => { if (error) child.kill() })) throw new Error('Test worker unavailable')
      },
      kill: () => child.kill(),
      on: (_event, listener) => {
        child.on('error', () => listener({ type: 'error', message: '测试会话进程启动失败。' }))
        return child.on('message', listener)
      },
      once: (_event, listener) => child.once('close', (code) => listener(code ?? 1)),
    }
  }, (_owner, event) => {
    const client = clients.get(event.id)
    if ('closed' in event) client?.closed()
    else client?.receive(event.message)
  })
  t.after(async () => { await sessions.shutdown(); await Promise.all(exits) })

  return {
    connect: (ack = true) => {
      const id = sessions.open(1)
      const messages: ServerMessage[] = []
      let output = ''
      let open = true
      let acknowledge = ack
      let exited: Promise<void> | undefined
      const sendRaw = (raw: string) => {
        if (!open) return false
        const before = exits.length
        const accepted = sessions.send(1, id, raw)
        if (exits.length > before) exited = exits.at(-1)
        return accepted
      }
      const send = (message: ClientMessage) => sendRaw(JSON.stringify(message))
      clients.set(id, {
        closed: () => { open = false },
        receive: (message) => {
          messages.push(message)
          if (message.type === 'output') {
            output += message.data
            if (acknowledge && open) send({ type: 'ack', count: message.data.length })
          }
        },
      })
      return {
        messages, send, sendRaw, wait, output: () => output, isOpen: () => open,
        close: async () => { sessions.close(1, id); await exited },
        acknowledge: () => {
          acknowledge = true
          for (const message of messages) if (message.type === 'output') send({ type: 'ack', count: message.data.length })
        },
        start: async () => {
          send({ type: 'start', cols: 100, rows: 30 })
          await wait(() => messages.some((message) => message.type === 'ready' || message.type === 'error'))
          assert.ok(messages.some((message) => message.type === 'ready'), 'Native PTY must start')
          await wait(() => output.length > 0)
          await delay(200)
        },
      }
    },
  }
}
