/**
 * Worker entrypoint — Raahi spec 03 §3 deployment units.
 *
 *   WORKER_PROCESS=general       node src/worker.js
 *   WORKER_PROCESS=dispatch      node src/worker.js
 *   ...
 *
 * Graceful shutdown per spec 03 §16: stop fetching, finish in-flight jobs,
 * close DB/Redis, exit.
 */

import fs from 'node:fs/promises'
import { testConnection, closePool } from './config/database.js'
import { closeRedis, pingRedisClients } from './config/redis.js'
import { logger } from './config/logger.js'
import { startWorkerRuntime, closeWorkerRuntime } from './runtime/workers.js'
import { env } from './config/env.js'
import { startEventLoopMonitor } from './utils/event-loop-monitor.js'

const WORKER_HEARTBEAT_FILE =
  process.env.WORKER_HEARTBEAT_FILE || '/tmp/raahi-worker-heartbeat'
const WORKER_HEARTBEAT_INTERVAL_MS = 30000

const start = async () => {
  try {
    await testConnection()
    const redisHealth = await pingRedisClients()
    logger.info({ redisHealth }, 'Worker dependency check complete')

    const pool = (await import('./config/database.js')).pool
    startWorkerRuntime(pool)
    await fs.writeFile(WORKER_HEARTBEAT_FILE, new Date().toISOString())

    const heartbeatInterval = setInterval(async () => {
      try {
        await fs.writeFile(WORKER_HEARTBEAT_FILE, new Date().toISOString())
      } catch (err) {
        logger.warn({ err: err.message }, 'Worker heartbeat write failed')
      }
    }, WORKER_HEARTBEAT_INTERVAL_MS)
    heartbeatInterval.unref()

    startEventLoopMonitor()
    logger.info(`🔧 ${env.APP_NAME} worker (${env.WORKER_PROCESS}) started`)

    if (process.send) process.send('ready')

    const shutdown = async (signal) => {
      logger.info({ signal }, 'Worker shutdown signal received — draining')
      clearInterval(heartbeatInterval)
      await closeWorkerRuntime()
      await closePool()
      await closeRedis()
      logger.info('Worker graceful shutdown complete')
      process.exit(0)
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('unhandledRejection', (err) => {
      logger.fatal({ err }, 'Unhandled rejection in worker')
      process.exit(1)
    })
    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'Uncaught exception in worker')
      process.exit(1)
    })
  } catch (err) {
    logger.fatal({ err }, 'Failed to start worker')
    process.exit(1)
  }
}

start()
