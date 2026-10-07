import { Emitter } from '@socket.io/redis-emitter'
import { redisPub } from '../config/redis.js'

let emitter = null

/**
 * Returns a Socket.IO-compatible emitter (`.to(room).emit(event, data)`)
 * for worker processes, which have no Socket.IO server of their own.
 * Publishes over the same Redis channel the API/realtime processes
 * subscribe to via @socket.io/redis-adapter (see socketio.plugin.js), so
 * events reach connected clients regardless of which process emitted them.
 */
export function getSocketEmitter() {
  if (!emitter) {
    emitter = new Emitter(redisPub)
  }
  return emitter
}
