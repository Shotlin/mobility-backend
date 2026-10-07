/**
 * Integration: full OTP auth flow against live DB+Redis (spec 05 §3,
 * spec 09 §3, spec 06 §4). Demo OTP is enabled in test env.
 * Each test uses its OWN phone so per-phone OTP budgets don't interfere.
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { buildApp } from '../../src/app.js'
import { pool, closePool } from '../../src/config/database.js'
import { closeRedis, redisRateLimit } from '../../src/config/redis.js'

const PHONES = Array.from({ length: 10 }, (_, i) => `+9190000012${String(i).padStart(2, '0')}`)
const ALL_PHONES = PHONES

let app
let p = 0
let ipCounter = 0
const nextPhone = () => PHONES[p++]
const nextAddr = () => `127.0.0.${++ipCounter}`

async function flushRateLimitState() {
  // Phone OTP counters AND route-level IP counters persist in Redis across
  // runs — clear both so the suite is deterministic.
  for (const pattern of ['rl:phone:+9190000012*:otp:*', 'raahi:ratelimit:*']) {
    let cursor = '0'
    do {
      const [next, keys] = await redisRateLimit.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = next
      if (keys.length > 0) await redisRateLimit.del(...keys)
    } while (cursor !== '0')
  }
}

beforeAll(async () => {
  await pool.query(
    `DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE phone_e164 = ANY($1))`,
    [ALL_PHONES],
  )
  await pool.query(
    `DELETE FROM driver_profiles WHERE user_id IN (SELECT id FROM users WHERE phone_e164 = ANY($1))`,
    [ALL_PHONES],
  )
  await pool.query(`DELETE FROM users WHERE phone_e164 = ANY($1)`, [ALL_PHONES])
  await flushRateLimitState()
  app = await buildApp()
  await app.ready()
})

async function requestOtp(phone, role = 'PASSENGER') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/request',
    payload: { phone, role },
    remoteAddress: nextAddr(),
  })
  return { res, body: res.json() }
}

async function login(phone, role = 'PASSENGER') {
  const { body: otpBody } = await requestOtp(phone, role)
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    payload: { phone, otp: otpBody.demoOtp, role },
    remoteAddress: nextAddr(),
  })
  return { res, body: res.json() }
}

describe('OTP auth flow (spec 05 §3)', () => {
  it('request → verify → tokens; unknown phone creates PASSENGER identity', async () => {
    const phone = nextPhone()
    const { res: reqRes, body: reqBody } = await requestOtp(phone)
    expect(reqRes.statusCode).toBe(200)
    expect(reqBody.sent).toBe(true)
    expect(reqBody.demoOtp).toMatch(/^\d{6}$/)

    const { res: verRes, body } = await login(phone)
    expect(verRes.statusCode).toBe(200)
    expect(body.accessToken).toBeDefined()
    expect(body.refreshToken).toBeDefined()
    expect(body.user.phone).toBe(phone)
    expect(body.user.role).toBe('PASSENGER')
  })

  it('invalid OTP is rejected with a stable code', async () => {
    const phone = nextPhone()
    await requestOtp(phone)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { phone, otp: '000000' },
      remoteAddress: nextAddr(),
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('OTP_INVALID')
  })

  it('driver login upgrades identity and seeds PENDING driver profile (spec 12 §3)', async () => {
    const phone = nextPhone()
    const { body } = await login(phone, 'DRIVER')
    expect(body.user.role).toBe('DRIVER')
    expect(body.user.approvalState).toBe('PENDING')
  })

  it('access token authenticates /users/me; anonymous access is rejected', async () => {
    const phone = nextPhone()
    const { body } = await login(phone)
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().phone).toBe(phone)

    const noAuth = await app.inject({ method: 'GET', url: '/api/v1/users/me' })
    expect(noAuth.statusCode).toBe(401)
    expect(noAuth.json().error.code).toBe('AUTH_REQUIRED')
  })

  it('PATCH /users/me updates profile; unknown fields are stripped', async () => {
    const phone = nextPhone()
    const { body: loginBody } = await login(phone)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${loginBody.accessToken}` },
      payload: { fullName: 'Test Passenger', gender: 'FEMALE', isAdmin: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().fullName).toBe('Test Passenger')
    expect(res.json().isAdmin).toBeUndefined()
  })

  it('refresh rotation: rotated token works, replayed old token is rejected', async () => {
    const phone = nextPhone()
    const { body: loginBody } = await login(phone)

    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: loginBody.refreshToken },
    })
    expect(r1.statusCode).toBe(200)
    const rotated = r1.json()
    expect(rotated.refreshToken).not.toBe(loginBody.refreshToken)

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: loginBody.refreshToken },
    })
    expect(replay.statusCode).toBe(401)

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: rotated.refreshToken },
    })
    expect(r2.statusCode).toBe(200)
  })

  it('logout revokes the session; subsequent refresh is rejected', async () => {
    const phone = nextPhone()
    const { body: loginBody } = await login(phone)

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${loginBody.accessToken}` },
    })
    expect(logout.statusCode).toBe(200)

    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: loginBody.refreshToken },
    })
    expect(after.statusCode).toBe(401)
  })

  it('logout-all revokes every session and bumps session_version (old access token dies)', async () => {
    const phone = nextPhone()
    const { body: first } = await login(phone)
    const { body: second } = await login(phone) // second device, same identity

    const wipe = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout-all',
      headers: { authorization: `Bearer ${first.accessToken}` },
    })
    expect(wipe.statusCode).toBe(200)

    for (const token of [first.accessToken, second.accessToken]) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(401)
    }
  })

  it('OTP request budget: 4th request in 15 minutes for same phone is rate limited (spec 06 §4)', async () => {
    const phone = nextPhone()
    for (let i = 0; i < 3; i++) {
      const { res } = await requestOtp(phone)
      expect(res.statusCode).toBe(200)
    }
    const fourth = await requestOtp(phone)
    expect(fourth.res.statusCode).toBe(429)
    expect(fourth.body.error.code).toBe('OTP_RATE_LIMITED')
    expect(fourth.body.error.retryable).toBe(true)
  })

  it('invalid Indian phone numbers are rejected deterministically', async () => {
    for (const bad of ['12345', '1234567890', 'abc', '+999000001234']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/request',
        payload: { phone: bad },
        remoteAddress: nextAddr(),
      })
      expect([400, 422]).toContain(res.statusCode)
    }
  })
})

afterAll(async () => {
  await pool
    .query(`DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE phone_e164 = ANY($1))`, [ALL_PHONES])
    .catch(() => {})
  await pool
    .query(`DELETE FROM driver_profiles WHERE user_id IN (SELECT id FROM users WHERE phone_e164 = ANY($1))`, [ALL_PHONES])
    .catch(() => {})
  await pool.query(`DELETE FROM users WHERE phone_e164 = ANY($1)`, [ALL_PHONES]).catch(() => {})
  await closePool().catch(() => {})
  await closeRedis().catch(() => {})
})
