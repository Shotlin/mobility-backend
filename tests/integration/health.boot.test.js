/**
 * Integration: boots the real Fastify app (plugin chain, health endpoints).
 * Requires docker compose up (Postgres+PostGIS, Redis) — see 15_IMPLEMENTATION_PHASES.md.
 */
import { afterAll, describe, it, expect } from 'vitest'
import { buildApp } from '../../src/app.js'
import { closePool } from '../../src/config/database.js'
import { closeRedis } from '../../src/config/redis.js'

let app

describe('app boot + health endpoints (spec 08 §3)', () => {
  it('builds and boots the full plugin chain', async () => {
    app = await buildApp()
    await app.ready()
    expect(app).toBeDefined()
  })

  it('GET /health — liveness works without touching dependencies', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('OK')
    expect(typeof body.uptime).toBe('number')
  })

  it('GET / — root reports service identity', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.json().health).toBe('/health')
  })

  it('GET /health/ready — readiness reflects real DB+Redis state', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect([200, 503]).toContain(res.statusCode)
    const body = res.json()
    expect(['READY', 'NOT_READY']).toContain(body.status)
    // With docker compose up, both must be up.
    expect(body.dependencies.postgres.status).toBe('up')
    expect(body.dependencies.redis.status).toBe('up')
  })

  it('GET /health/deep — diagnostics expose queue snapshot without secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/deep' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.postgres).toBe('up')
    expect(body.redisClients).toBeDefined()
    expect(body.queues).toBeDefined()
    const serialized = res.body
    expect(serialized.toLowerCase()).not.toContain('password')
  })

  it('error envelope follows spec 09 §7 shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/definitely-not-a-route' })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.error).toBeDefined()
    expect(body.error.code).toBe('NOT_FOUND')
    expect(typeof body.error.requestId).toBe('string')
    expect(typeof body.error.retryable).toBe('boolean')
  })

  afterAll(async () => {
    if (app) await app.close()
    await closePool().catch(() => {})
    await closeRedis().catch(() => {})
  })
})
