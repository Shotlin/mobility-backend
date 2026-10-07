/**
 * Integration: maps proxy authorization + failure semantics (spec 13 §4,
 * spec 03 §12). No real Ola key in CI — we verify the no-key failure path,
 * which must be a stable 503 MAPS_NOT_CONFIGURED, never fabricated data.
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { buildApp } from '../../src/app.js'
import { pool, closePool } from '../../src/config/database.js'
import { closeRedis } from '../../src/config/redis.js'

const PHONE = '+919000002101'
let app
let accessToken

beforeAll(async () => {
  await pool.query(`DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE phone_e164 = $1)`, [PHONE])
  await pool.query(`DELETE FROM users WHERE phone_e164 = $1`, [PHONE])
  app = await buildApp()
  await app.ready()

  const otp = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/request',
    payload: { phone: PHONE },
    remoteAddress: '10.1.0.1',
  })
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    payload: { phone: PHONE, otp: otp.json().demoOtp },
    remoteAddress: '10.1.0.2',
  })
  accessToken = login.json().accessToken
})

describe('maps proxy (spec 13 §4)', () => {
  it('requires authentication — no token → 401 AUTH_REQUIRED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/maps/autocomplete',
      payload: { input: 'Koramangala' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('AUTH_REQUIRED')
  })

  it('without a configured provider key → stable 503 MAPS_NOT_CONFIGURED (no fabricated data)', async () => {
    // Ensure no env key and no dashboard settings row.
    delete process.env.OLA_MAPS_API_KEY
    await pool.query(`DELETE FROM platform_settings WHERE key = 'ola_maps_settings'`)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/maps/autocomplete',
      payload: { input: 'Koramangala' },
      headers: { authorization: `Bearer ${accessToken}` },
      remoteAddress: '10.1.0.3',
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('MAPS_NOT_CONFIGURED')
  })

  it('rejects malformed payloads with 400 (validation)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/maps/autocomplete',
      payload: { input: 'x' }, // too short
      headers: { authorization: `Bearer ${accessToken}` },
      remoteAddress: '10.1.0.4',
    })
    expect(res.statusCode).toBe(400)
  })

  it('directions payload validation rejects bad coordinates', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/maps/directions',
      payload: { origin: { lat: 999, lng: 88 }, destination: { lat: 22, lng: 88 } },
      headers: { authorization: `Bearer ${accessToken}` },
      remoteAddress: '10.1.0.5',
    })
    expect(res.statusCode).toBe(400)
  })
})

afterAll(async () => {
  await pool.query(`DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE phone_e164 = $1)`, [PHONE]).catch(() => {})
  await pool.query(`DELETE FROM users WHERE phone_e164 = $1`, [PHONE]).catch(() => {})
  await closePool().catch(() => {})
  await closeRedis().catch(() => {})
})
