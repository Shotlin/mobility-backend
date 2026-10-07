/**
 * API server entrypoint — Raahi spec 03 §3 (api process).
 * Worker-only process types start via `src/worker.js`.
 */

import { buildApp } from './app.js'
import { env } from './config/env.js'
import { testConnection, closePool } from './config/database.js'
import { closeRedis } from './config/redis.js'
import { logger } from './config/logger.js'
import { refreshRazorpayClient } from './config/razorpay.js'
import { startEventLoopMonitor } from './utils/event-loop-monitor.js'

const start = async () => {
  try {
    await testConnection()
    // Load dashboard-managed Razorpay credentials (falls back to env vars)
    // before anything that might touch payments can run.
    await refreshRazorpayClient()

    const app = await buildApp()
    await app.ready()

    await app.listen({ port: env.PORT, host: env.HOST })

    logger.info(`🚀 ${env.APP_NAME} API running on http://${env.HOST}:${env.PORT}`)
    if (env.ENABLE_SWAGGER) {
      logger.info(`📖 Swagger docs at http://localhost:${env.PORT}/documentation`)
    }
    if (app.io) {
      logger.info(`🔌 Socket.IO ready on ws://${env.HOST}:${env.PORT}`)
    }

    startEventLoopMonitor(logger)

    // PM2 ready signal
    if (process.send) {
      process.send('ready')
    }

    // ─── GRACEFUL SHUTDOWN (spec 03 §16) ──────────────────────────
    // 1. stop accepting new work → 2. drain HTTP → 3. close io →
    // 4. close db/redis → 5. exit before orchestrator hard-kill deadline.
    const shutdown = async (signal) => {
      logger.info({ signal }, 'Shutdown signal received — draining')
      try {
        if (app.io) {
          app.io.close()
          logger.info('Socket.IO closed')
        }
        await app.close()
        logger.info('Fastify closed')
        await closePool()
        logger.info('PostgreSQL pool closed')
        await closeRedis()
        logger.info('Redis closed')
        logger.info('Graceful shutdown complete')
        process.exit(0)
      } catch (err) {
        logger.fatal({ err }, 'Error during graceful shutdown')
        process.exit(1)
      }
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('unhandledRejection', (err) => {
      logger.fatal({ err }, 'Unhandled rejection')
      process.exit(1)
    })
    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'Uncaught exception')
      process.exit(1)
    })
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server')
    process.exit(1)
  }
}

start()
