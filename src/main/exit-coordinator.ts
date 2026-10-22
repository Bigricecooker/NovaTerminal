// Acknowledgements keep a visible confirmation alive; the user has no decision timeout.
export function createExitCoordinator(request: (id: number) => void, finish: () => void, now = Date.now) {
  let pending: { id: number; lastAck: number } | null = null
  let nextId = 0
  let done = false
  let timer: ReturnType<typeof setInterval> | undefined
  const complete = () => {
    if (done) return
    done = true; pending = null; clearInterval(timer); finish()
  }
  const tick = () => {
    if (!pending) return
    if (now() - pending.lastAck >= 5_000) complete()
    else request(pending.id)
  }
  return {
    begin: (confirm: boolean) => {
      if (done || pending) return
      if (!confirm) { complete(); return }
      pending = { id: ++nextId, lastAck: now() }
      request(pending.id)
      timer = setInterval(tick, 1_000)
    },
    reply: (id: number, action: 'ack' | 'cancel' | 'exit') => {
      if (!pending || pending.id !== id || done) return
      if (action === 'ack') pending.lastAck = now()
      else if (action === 'exit') complete()
      else { pending = null; clearInterval(timer) }
    },
    unavailable: () => { if (pending) complete() },
    tick,
    pending: () => pending !== null,
    dispose: () => clearInterval(timer),
  }
}
