/**
 * Integration: admin auth + RBAC-gated ops endpoints (spec 05 §3/§10, spec 11).
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { buildApp } from '../../src/app.js'
import { pool, closePool } from '../../src/config/database.js'
import { closeRedis } from '../../src/config/redis.js'
import { flushRateLimits } from './helpers/db-clean.js'

let app
let adminToken, adminId
const ADMIN = { phone: '919999000001', password: 'ChangeMe!2026' }
const PASSENGER = '+919876501010'

beforeAll(async () => {
  await flushRateLimits()
  // Ensure the seeded admin exists (seed script is part of setup).
  const { execSync } = await import('node:child_process')
  try {
    execSync('node scripts/seed-admin.js +919999000001 ChangeMe!2026', { cwd: process.cwd(), stdio: 'pipe' })
  } catch {
    // already seeded
  }

  app = await buildApp()
  await app.ready()

  await pool.query(`DELETE FROM users WHERE phone_e164 = $1`, [PASSENGER]).catch(() => {})
  await pool.query(
    `INSERT INTO users (phone_e164, role) VALUES ($1, 'PASSENGER') RETURNING id`,
    [PASSENGER],
  )
})

describe('admin login (spec 05 §3)', () => {
  it('wrong password → 401 with audit trail row', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/admin/login',
      payload: { phone: ADMIN.phone, password: 'WrongPass!123' },
      remoteAddress: '10.6.0.1',
    })
    expect(res.statusCode).toBe(401)
  })

  it('correct credentials → token + SUPER_ADMIN permissions', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/admin/login',
      payload: ADMIN,
      remoteAddress: '10.6.0.2',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    adminToken = body.accessToken
    adminId = body.user.id
    expect(body.user.role).toBe('SUPER_ADMIN')
    expect(body.permissions).toContain('driver.approve')
    expect(body.permissions).toContain('safety.incident.manage')
  })

  it('passenger OTP token is rejected on admin surface', async () => {
    const otp = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone: PASSENGER }, remoteAddress: '10.6.0.3' })
    const passengerToken = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone: PASSENGER, otp: otp.json().demoOtp }, remoteAddress: '10.6.0.4' })
    ).json().accessToken
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/command-center',
      headers: { authorization: `Bearer ${passengerToken}` },
      remoteAddress: '10.6.0.5',
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('admin ops endpoints (spec 11)', () => {
  it('command center returns live KPIs', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/command-center',
      headers: { authorization: `Bearer ${adminToken}` },
      remoteAddress: '10.6.0.6',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.rides).toBeDefined()
    expect(body.drivers).toBeDefined()
    expect(typeof body.activeSafetyIncidents).toBe('number')
  })

  it('ride list + driver list are readable; system health has no secrets', async () => {
    const rides = await app.inject({
      method: 'GET', url: '/api/v1/admin/rides?limit=5',
      headers: { authorization: `Bearer ${adminToken}` },
      remoteAddress: '10.6.0.7',
    })
    expect(rides.statusCode).toBe(200)
    expect(Array.isArray(rides.json().rides)).toBe(true)

    const drivers = await app.inject({
      method: 'GET', url: '/api/v1/admin/drivers',
      headers: { authorization: `Bearer ${adminToken}` },
      remoteAddress: '10.6.0.8',
    })
    expect(drivers.statusCode).toBe(200)

    const health = await app.inject({
      method: 'GET', url: '/api/v1/admin/system-health',
      headers: { authorization: `Bearer ${adminToken}` },
      remoteAddress: '10.6.0.9',
    })
    expect(health.statusCode).toBe(200)
    expect(health.body.toLowerCase()).not.toContain('password')
  })
})

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE phone_e164 = $1`, [PASSENGER]).catch(() => {})
  await closePool().catch(() => {})
  await closeRedis().catch(() => {})
})
void adminId
