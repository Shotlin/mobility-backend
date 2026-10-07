import Fastify from 'fastify'
import { env } from './config/env.js'
import { query, testConnection } from './config/database.js'
import { redisApi, pingRedisClients } from './config/redis.js'
import { queueHealthSnapshot } from './config/bullmq.js'
import { sanitize } from './middlewares/sanitize.js'
import { MAINTENANCE_ENVELOPE } from './constants/maintenance.js'

/**
 * Ride-hailing module registry (Raahi spec 03 §4).
 * Each entry registers when its phase lands; app.js never imports domain
 * code directly, only through this list.
 */
const MODULES = [
  { path: './modules/auth/auth.routes.js', prefix: '/api/v1/auth' },
  { path: './modules/users/users.routes.js', prefix: '/api/v1/users' },
  { path: './modules/maps/maps.routes.js', prefix: '/api/v1/maps' },
  { path: './modules/ride-quotes/ride-quotes.routes.js', prefix: '/api/v1/quotes' },
  { path: './modules/rides/rides.routes.js', prefix: '/api/v1/rides' },
  { path: './modules/drivers/drivers.routes.js', prefix: '/api/v1/drivers' },
  { path: './modules/drivers/drivers.routes.js', prefix: '/api/v1/rides', named: 'driverRideRoutes' },
  { path: './modules/realtime/realtime.routes.js', prefix: '/api/v1' },
  { path: './modules/payments/payments.routes.js', prefix: '/api/v1/payments' },
  { path: './modules/safety/safety.routes.js', prefix: '/api/v1/safety' },
  { path: './modules/extras/extras.routes.js', prefix: '/api/v1' },
  { path: './modules/drivers/drivers.routes.js', prefix: '/api/v1/drivers', named: 'driverDocumentRoutes' },
  { path: './modules/admin/admin.routes.js', prefix: '/api/v1/admin', named: 'adminRoutes' },
  { path: './modules/admin/admin.routes.js', prefix: '/api/v1/auth/admin', named: 'adminAuthRoutes' },
  { path: './modules/auth/auth.routes.js', prefix: '/api/v1/auth', named: 'registerMeRoute' },
]

/** Modules mounted under /api/v1/admin with dashboard auth. */
const ADMIN_MODULES = []

/**
 * Build and configure the Fastify application.
 * Plugin order matters; health endpoints follow spec 08 §3.
 */
export const buildApp = async () => {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.LOG_PRETTY && {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }),
    },
    trustProxy: true,
    // Spec 03 §14: compile validation once, reject unknown fields.
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        useDefaults: true,
        coerceTypes: 'array',
      },
    },
    // Spec 06 §13: request protection defaults.
    bodyLimit: 1 * 1024 * 1024, // 1 MiB; webhooks/uploads override per-route
    requestTimeout: 30000,
    keepAliveTimeout: 72000,
  })

  // ─── PLUGINS (order matters) ────────────────────────────
  await app.register(import('./plugins/errorHandler.plugin.js'))
  await app.register(import('./plugins/cors.plugin.js'))
  await app.register(import('./plugins/helmet.plugin.js'))
  // Captures exact raw request bytes onto `request.rawBody` for routes with
  // `config: { rawBody: true }` — required to verify Razorpay webhook
  // signatures against what Razorpay actually signed (spec 05 §7).
  await app.register(import('fastify-raw-body'), {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  })
  await app.register(import('./plugins/rateLimit.plugin.js'))
  await app.register(import('./plugins/auth.plugin.js'))
  await app.register(import('./plugins/swagger.plugin.js'))
  await app.register(import('./plugins/multipart.plugin.js'))
  if (env.DISABLE_SOCKETIO !== true) {
    await app.register(import('./plugins/socketio.plugin.js'))
  }

  // ─── GLOBAL HOOKS ──────────────────────────────────────
  app.addHook('onRequest', sanitize)

  // User-scoped responses are never cacheable by intermediaries — mobile
  // networks run transparent proxies that happily serve stale ride state.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.user && request.user.id) {
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
      reply.header('Pragma', 'no-cache')
      reply.header('Expires', '0')
    }
    return payload
  })

  // Maintenance gate (spec 11 §14 platform controls). Safety and health
  // routes opt out via `config: { maintenanceExempt: true }`.
  app.addHook('onRequest', async (request, reply) => {
    if (!env.MAINTENANCE_MODE) return
    if (request.routeOptions?.config?.maintenanceExempt) return
    if (request.url.startsWith('/health') || request.url.startsWith('/api/webhook')) return
    return reply.code(503).send(MAINTENANCE_ENVELOPE(request.id))
  })

  // ─── MODULE ROUTES ─────────────────────────────────────
  for (const mod of MODULES) {
    const plugin = mod.named
      ? import(mod.path).then((module) => module[mod.named])
      : import(mod.path)
    await app.register(plugin, { prefix: mod.prefix })
  }
  for (const mod of ADMIN_MODULES) {
    await app.register(import(mod.path), { prefix: mod.prefix })
  }

  // ─── RAZORPAY WEBHOOK (outside /api/v1 — no auth, raw-body verified) ──
  {
    const { razorpayWebhookRoutes } = await import('./modules/payments/payments.routes.js')
    await app.register(razorpayWebhookRoutes, { prefix: '/api/webhook/razorpay' })
  }

  // ─── HEALTH CHECKS (spec 08 §3) ─────────────────────────
  // Liveness: is the process alive enough to keep running? Deliberately
  // does NOT touch external providers — an Ola outage must not cause a
  // restart storm (spec 08 §3).
  app.get(
    '/health',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['Health'],
        summary: 'Liveness probe — process-local only',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              timestamp: { type: 'string' },
              uptime: { type: 'number' },
            },
          },
        },
      },
    },
    async () => ({
      status: 'OK',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    }),
  )

  // Readiness: can this process safely accept traffic? DB + required Redis.
  app.get(
    '/health/ready',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['Health'],
        summary: 'Readiness probe — dependency-aware',
      },
    },
    async (request, reply) => {
      const [postgresResult, redisResult] = await Promise.allSettled([
        testConnection(),
        redisApi.ping(),
      ])

      const dependencies = {
        postgres:
          postgresResult.status === 'fulfilled'
            ? { status: 'up' }
            : {
                status: 'down',
                error: postgresResult.reason?.message || 'Unknown PostgreSQL error',
              },
        redis:
          redisResult.status === 'fulfilled'
            ? { status: 'up' }
            : { status: 'down', error: redisResult.reason?.message || 'Unknown Redis error' },
      }

      const ready = Object.values(dependencies).every((d) => d.status === 'up')
      if (!ready) {
        request.log.error({ dependencies }, 'Readiness check failed')
        return reply.code(503).send({
          status: 'NOT_READY',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          dependencies,
        })
      }

      return {
        status: 'READY',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        dependencies,
      }
    },
  )

  // Root convenience endpoint
  app.get(
    '/',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['Health'],
        summary: 'Root status endpoint',
      },
    },
    async () => ({
      status: 'OK',
      service: env.APP_NAME,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      health: '/health',
      readiness: '/health/ready',
    }),
  )

  // Deep diagnostics: INTERNAL — mount only behind admin auth in shared
  // deployments; exposes dependency detail, never secrets (spec 08 §3).
  app.get(
    '/health/deep',
    {
      config: { rateLimit: false },
      schema: { tags: ['Health'], summary: 'Deep dependency diagnostics (internal)' },
    },
    async () => {
      const redisClients = await pingRedisClients()
      let postgres = 'up'
      try {
        await query('SELECT 1')
      } catch (err) {
        postgres = `down: ${err.message}`
      }
      const queues = await queueHealthSnapshot().catch(() => ({ error: 'unavailable' }))
      return {
        timestamp: new Date().toISOString(),
        process: {
          pid: process.pid,
          uptime: process.uptime(),
          memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
          node: process.version,
        },
        postgres,
        redisClients,
        queues,
      }
    },
  )

  return app
}
