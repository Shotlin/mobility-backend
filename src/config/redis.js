/**
 * Purpose-specific Redis clients — Raahi spec 03 §9.
 *
 * The commerce foundation used ONE client (maxRetriesPerRequest: null, which
 * BullMQ requires) for every concern. That is wrong for latency-sensitive API
 * work: a BullMQ-style infinite retry on a blocked command stalls API requests.
 *
 * All clients may point at the same Redis server initially, but each has its
 * own tunable options so the deployment can later split by workload
 * (realtime/GEO vs queues vs cache/rate-limit) WITHOUT rewriting app code:
 *
 *   redisApi         latency-sensitive API reads/writes (finite retries, command timeout)
 *   redisCache       cache semantics (config, lookup data)
 *   redisRateLimit   distributed rate limiters
 *   redisGeo         driver presence / GEO hot path
 *   redisPub         Socket.IO adapter publisher
 *   redisSub         Socket.IO adapter subscriber
 *   redisBull        BullMQ queues (maxRetriesPerRequest: null REQUIRED here)
 *
 * @module config/redis
 */

import Redis from 'ioredis'
import { env } from './env.js'
import { logger } from './logger.js'

const HOST = env.REDIS_HOST
const PORT = env.REDIS_PORT
const DB = env.REDIS_DB
const PASSWORD = env.REDIS_PASSWORD || undefined
const BULL_PASSWORD = env.BULL_REDIS_PASSWORD || env.REDIS_PASSWORD || undefined
const BULL_HOST = env.BULL_REDIS_HOST || HOST
const BULL_PORT = env.BULL_REDIS_PORT || PORT

const baseOptions = {
  host: HOST,
  port: PORT,
  db: DB,
  password: PASSWORD,
  // Eager connect keeps lifecycle simple and readiness honest; unused
  // clients cost one socket each until queue volume justifies laziness.
  lazyConnect: false,
  retryStrategy: (times) => {
    if (times > 10) return null
    return Math.min(times * 200, 5000)
  },
}

const bullOptions = {
  host: BULL_HOST,
  port: BULL_PORT,
  db: DB,
  password: BULL_PASSWORD,
  lazyConnect: true,
  // BullMQ blocks on BRPOPLPUSH and requires unlimited retries per command.
  maxRetriesPerRequest: null,
  retryStrategy: (times) => {
    if (times > 20) return 5000
    return Math.min(times * 500, 5000)
  },
}

function attachLogging(client, name) {
  client.on('error', (err) => {
    logger.error({ err, client: name }, `Redis ${name} connection error`)
  })
  client.on('close', () => {
    logger.debug({ client: name }, `Redis ${name} connection closed`)
  })
  return client
}

/** Latency-sensitive API commands: bounded retries, short command timeout. */
export const redisApi = attachLogging(
  new Redis({
    ...baseOptions,
    maxRetriesPerRequest: 3,
    commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
    connectTimeout: 5000,
  }),
  'redisApi',
)

/** Cache semantics: tolerate occasional loss, bounded retries. */
export const redisCache = attachLogging(
  new Redis({
    ...baseOptions,
    maxRetriesPerRequest: 2,
    commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS * 2,
  }),
  'redisCache',
)

/** Rate limiter counters: fail fast, class-based fallbacks live in callers. */
export const redisRateLimit = attachLogging(
  new Redis({
    ...baseOptions,
    maxRetriesPerRequest: 1,
    commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
  }),
  'redisRateLimit',
)

/** Driver presence GEO hot path: write-behind semantics, fail fast. */
export const redisGeo = attachLogging(
  new Redis({
    ...baseOptions,
    maxRetriesPerRequest: 2,
    commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
  }),
  'redisGeo',
)

/** Socket.IO adapter publisher. */
export const redisPub = attachLogging(
  new Redis({
    ...baseOptions,
    maxRetriesPerRequest: null, // pub/sub must not drop on transient blocks
  }),
  'redisPub',
)

/** Socket.IO adapter subscriber. */
export const redisSub = attachLogging(
  new Redis({
    ...baseOptions,
    maxRetriesPerRequest: null,
  }),
  'redisSub',
)

/** BullMQ-compatible connection (maxRetriesPerRequest: null mandatory). */
export const redisBull = attachLogging(new Redis(bullOptions), 'redisBull')

/**
 * All purpose clients. Workers/HTTP pick what they need; nothing else in the
 * codebase should construct ad-hoc Redis connections.
 */
export const redisClients = {
  redisApi,
  redisCache,
  redisRateLimit,
  redisGeo,
  redisPub,
  redisSub,
  redisBull,
}

/**
 * Graceful shutdown: quit every client, tolerating already-closed sockets.
 */
export async function closeRedis() {
  await Promise.allSettled(
    Object.values(redisClients).map((client) =>
      client.status === 'end' ? Promise.resolve() : client.quit(),
    ),
  )
}

/**
 * Ping every client with an open socket. Used by readiness to distinguish
 * "Redis up" from "BullMQ connection up".
 */
export async function pingRedisClients() {
  const results = {}
  await Promise.all(
    Object.entries(redisClients).map(async ([name, client]) => {
      // Clients that never connected (lazyConnect, unused in this process)
      // are reported as "idle", not down.
      if (client.status === 'wait' || client.status === 'end') {
        results[name] = 'idle'
        return
      }
      try {
        await client.ping()
        results[name] = 'up'
      } catch (err) {
        results[name] = `down: ${err.message}`
      }
    }),
  )
  return results
}
