import { runSessionWorker } from './session-worker.ts'

runSessionWorker({
  send: (message, callback) => {
    if (!process.connected || !process.send) { callback(new Error('Parent disconnected')); return }
    process.send(message, (error) => callback(error ?? null))
  },
  onMessage: (callback) => { process.on('message', callback) },
  onDisconnect: (callback) => {
    process.once('disconnect', callback)
    process.once('SIGTERM', callback)
    process.once('SIGINT', callback)
  },
})
