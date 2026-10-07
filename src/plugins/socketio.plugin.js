import fp from 'fastify-plugin'
import { Server } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { redisPub, redisSub } from '../config/redis.js'
import { socketAuthMiddleware } from '../socket/auth.js'
import { canonicalRole } from '../utils/permissions.js'

let activeIo = null

function expandLoopbackOrigins(originList) {
  const expanded = new Set(originList)

  for (const origin of originList) {
    try {
      const url = new URL(origin)
      if (url.hostname === 'localhost') {
        url.hostname = '127.0.0.1'
        expanded.add(url.toString().replace(/\/$/, ''))
      } else if (url.hostname === '127.0.0.1') {
        url.hostname = 'localhost'
        expanded.add(url.toString().replace(/\/$/, ''))
      }
    } catch {
      expanded.add(origin)
    }
  }

  return Array.from(expanded)
}

export function getSocketIo() {
  return activeIo
}

/**
 * Socket.IO plugin — realtime foundation (Raahi spec 09 §9-§16).
 *
 * Room model (all joins are authorized server-side; never trust a
 * client-supplied room name):
 *
 *   user:{userId}       passenger personal room (ride events, notifications)
 *   driver:{driverId}   driver personal room (offers, ride events)
 *   ride:{rideId}       ride tracking room (assigned parties + ops)
 *   ops:city:{cityId}   dashboard fleet/ride streams (city-scoped)
 *   ops:zone:{zoneId}   dashboard fleet/ride streams (zone-scoped)
 *   safety:ops          safety operators (incident queue)
 *
 * High-frequency driver location ingest and versioned ride event fanout
 * are added by the location module (Phase 7); this file owns connection
 * lifecycle, room authorization, and the helpers other modules call.
 */
async function socketioPlugin(fastify) {
  const corsOrigins = expandLoopbackOrigins(
    env.CORS_ORIGINS.split(',').map((s) => s.trim()),
  )

  const io = new Server(fastify.server, {
    cors: {
      origin: corsOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    // Spec 03 §6: websocket-only preferred — removes polling affinity
    // complexity; polling stays available only in dev for tooling.
    transports: env.NODE_ENV === 'production' ? ['websocket'] : ['websocket', 'polling'],
  })

  // Redis adapter lets horizontally scaled realtime/API nodes and worker
  // processes (via plugins/socket-emitter.js) broadcast across processes.
  io.adapter(createAdapter(redisPub, redisSub))

  // ─── AUTH MIDDLEWARE ──────────────────────────────────
  io.use(socketAuthMiddleware)

  // ─── CONNECTION HANDLER ──────────────────────────────
  io.on('connection', (socket) => {
    const role = canonicalRole(socket.auth?.role)
    const { userId } = socket

    logger.info({ userId, socketId: socket.id, role }, 'Socket connected')

    // Personal room by actor type — the only unconditional auto-join.
    if (role === 'DRIVER') {
      socket.join(`driver:${userId}`)
    } else {
      socket.join(`user:${userId}`)
    }

    // ─── RIDE ROOM JOIN (spec 09 §9) ─────────────────────
    // Authorization policy: passenger owns the ride, driver is assigned to
    // it, ops roles have ride.read. The rides table exists from Phase 2;
    // before that the DB check rejects, which fails safe.
    socket.on('ride:join', async (rideId) => {
      if (!rideId || typeof rideId !== 'string') return
      try {
        if (role !== 'PASSENGER' && role !== 'DRIVER') {
          socket.join(`ride:${rideId}`)
          return
        }
        const { query } = await import('../config/database.js')
        const column = role === 'DRIVER' ? 'driver_id' : 'passenger_id'
        const { rows } = await query(
          `SELECT id FROM rides WHERE id = $1 AND ${column} = $2 LIMIT 1`,
          [rideId, userId],
        )
        if (rows.length > 0) {
          socket.join(`ride:${rideId}`)
        } else {
          logger.warn({ userId, rideId }, 'Unauthorized ride room join rejected')
          socket.emit('room:denied', { room: `ride:${rideId}` })
        }
      } catch (err) {
        logger.error({ err, userId, rideId }, 'ride:join authorization failed')
        socket.emit('room:denied', { room: `ride:${rideId}` })
      }
    })

    socket.on('ride:leave', (rideId) => {
      if (rideId) socket.leave(`ride:${rideId}`)
    })

    // ─── OPS ROOM JOIN (dashboard, spec 04 §18) ──────────
    // Dashboard users stream city/zone-scoped snapshots + deltas, never a
    // global firehose of all driver coordinates.
    socket.on('ops:join', async ({ cityId, zoneId } = {}) => {
      try {
        const permissioned =
          role !== 'PASSENGER' && role !== 'DRIVER'
        if (!permissioned) {
          socket.emit('room:denied', { room: 'ops' })
          return
        }
        if (cityId) socket.join(`ops:city:${cityId}`)
        if (zoneId) socket.join(`ops:zone:${zoneId}`)
      } catch (err) {
        logger.error({ err, userId }, 'ops:join failed')
      }
    })

    // ─── SAFETY OPS ROOM (spec 10 §15) ───────────────────
    socket.on('safety:join', () => {
      const perms = socket.permissions || []
      if (perms.includes('safety.incident.read') || perms.includes('safety.incident.manage')) {
        socket.join('safety:ops')
      } else {
        socket.emit('room:denied', { room: 'safety:ops' })
      }
    })

    // ─── DRIVER LOCATION INGEST (spec 04 §10-§11, spec 06 §5) ──
    // High-frequency ephemeral events: Redis hot state + ride-room fanout
    // only. NO PostgreSQL write per event. Server throttles by driver state
    // and coalesces bursts; driverId comes from the AUTHENTICATED socket,
    // never from the payload (spec 09 §13).
    socket.on('driver:location', async (data, ack) => {
      try {
        if (role !== 'DRIVER') return
        const { ingestDriverLocation } = await import('../modules/location/location-ingest.js')
        const result = await ingestDriverLocation({
          driverId: userId,
          lat: Number(data?.lat),
          lng: Number(data?.lng),
          accuracyM: Number(data?.accuracyM),
          heading: Number(data?.heading),
          speedMps: Number(data?.speedMps),
          capturedAt: Number(data?.capturedAt),
        })
        if (typeof ack === 'function') ack({ ok: result.accepted, code: result.reason })
      } catch (err) {
        logger.error({ err, userId }, 'driver:location ingest failed')
        if (typeof ack === 'function') ack({ ok: false, code: 'INGEST_ERROR' })
      }
    })

    socket.on('disconnect', (reason) => {
      logger.info({ userId, socketId: socket.id, reason }, 'Socket disconnected')
    })
  })

  // ─── DECORATE FASTIFY ────────────────────────────────
  fastify.decorate('io', io)
  activeIo = io

  /**
   * Versioned ride event emission (spec 09 §14 envelope). All ride events
   * MUST go through this helper so every payload carries v/eventId/
   * rideVersion and reaches every authorized room consistently.
   */
  fastify.decorate('emitRideEvent', (rooms, envelope) => {
    for (const room of rooms) {
      io.to(room).emit('ride:event', envelope)
    }
  })

  fastify.addHook('onClose', () => {
    io.close()
  })

  logger.info('Socket.IO initialized (ride-hailing room model)')
}

export default fp(socketioPlugin, {
  name: 'socketio',
})
