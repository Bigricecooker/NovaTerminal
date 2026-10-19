import { runSessionWorker } from '../server/session-worker.ts'

const parent = process.parentPort
if (!parent) throw new Error('Missing session parent')
runSessionWorker({
  send: (message, callback) => {
    try {
      parent.postMessage(message)
      // The owner acknowledges terminal completion by sending close. Bound its wait.
      if (message.type === 'exit' || message.type === 'error') setTimeout(() => callback(null), 2_000)
      else callback(null)
    } catch { callback(new Error('Session transport closed')) }
  },
  onMessage: (callback) => { parent.on('message', (event) => callback(event.data)) },
  onDisconnect: (callback) => {
    process.once('SIGTERM', callback)
    process.once('SIGINT', callback)
  },
})
