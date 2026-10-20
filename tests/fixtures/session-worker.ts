import { runSessionWorker } from '../../src/server/session-worker.ts'
import { createKnownHosts } from '../../src/server/known-hosts.ts'

// System-Node adapter for testing the same session core used by utilityProcess.
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
}, createKnownHosts(process.argv[2]))
