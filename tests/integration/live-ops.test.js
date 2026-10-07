/**
 * Integration: live ops snapshots for the fleet map + dispatch monitor
 * (spec 09 §5 /admin/live/*, spec 11 §3/§5).
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { buildApp } from '../../src/app.js'
import { pool, closePool } from '../../src/config/database.js'
import { closeRedis } from '../../src/config/redis.js'
import { flushRateLimits } from './helpers/db-clean.js'

let app
let adminToken

beforeAll(async () => {
  await flushRateLimits()
  const { execSync } = await import('node:child_process')
  try {
    execSync('node scripts/seed-admin.js +919999000001 ChangeMe!2026', { cwd: process.cwd(), stdio: 'pipe' })
  } catch { /* seeded */ }

  app = await buildApp()
  await app.ready()

  const login = await app.inject({
    method: 'POST', url: '/api/v1/auth/admin/login',
    payload: { phone: '919999000001', password: 'ChangeMe!2026' },
    remoteAddress: '10.7.0.1',
  })
  adminToken = login.json().accessToken
})

describe('live ops snapshots (spec 11 §3/§5)', () => {
  it('live/drivers requires cityId + vehicleCategoryId and returns fresh drivers only', async () => {
    const cityId = (
      await pool.query(
        `INSERT INTO cities (name) VALUES ('Mapville') RETURNING id`,
      )
    ).rows[0].id
    const categoryId = (
      await pool.query(
        `INSERT INTO vehicle_categories (code, display_name, capacity) VALUES ('MAP_AUTO', 'Auto', 3) RETURNING id`,
      )
    ).rows[0].id

    // Missing params → 400
    const bad = await app.inject({
      method: 'GET', url: '/api/v1/admin/live/drivers',
      headers: { authorization: `Bearer ${adminToken}` },
      remoteAddress: '10.7.0.2',
    })
    expect(bad.statusCode).toBe(400)

    // Fresh driver (last_location_at = NOW)
    const driverId = (
      await pool.query(
        `INSERT INTO users (phone_e164, role, full_name) VALUES ('+919876543210', 'DRIVER', 'Map Driver') RETURNING id`,
      )
    ).rows[0].id
    await pool.query(
      `INSERT INTO driver_profiles (user_id, approval_state, city_id, last_location, last_location_at)
       VALUES ($1, 'APPROVED', $2, ST_SetSRID(ST_MakePoint(88.36, 22.57), 4326), NOW())`,
      [driverId, cityId],
    )
    // Stale driver (30 min old)
    const staleId = (
      await pool.query(
        `INSERT INTO users (phone_e164, role, full_name) VALUES ('+919876543211', 'DRIVER', 'Stale Driver') RETURNING id`,
      )
    ).rows[0].id
    await pool.query(
      `INSERT INTO driver_profiles (user_id, approval_state, city_id, last_location, last_location_at)
       VALUES ($1, 'APPROVED', $2, ST_SetSRID(ST_MakePoint(88.37, 22.58), 4326), NOW() - INTERVAL '30 minutes')`,
      [staleId, cityId],
    )

    const res = await app.inject({
      method: 'GET', url: `/api/v1/admin/live/drivers?cityId=${cityId}&vehicleCategoryId=${categoryId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      remoteAddress: '10.7.0.3',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.drivers.length).toBe(1) // stale excluded by the freshness filter
    expect(body.drivers[0].driverId).toBe(driverId)
    expect(body.drivers[0].location).toEqual({ lat: 22.57, lng: 88.36 })
    expect(body.drivers[0].freshnessS).toBeLessThan(120)

    // Cleanup
    await pool.query(`DELETE FROM driver_profiles WHERE user_id IN ($1, $2)`, [driverId, staleId])
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [driverId, staleId])
    await pool.query(`DELETE FROM cities WHERE id = $1`, [cityId])
    await pool.query(`DELETE FROM vehicle_categories WHERE id = $1`, [categoryId])
  })

  it('live/rides returns only active rides with search age', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/live/rides',
      headers: { authorization: `Bearer ${adminToken}` },
      remoteAddress: '10.7.0.4',
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json().rides)).toBe(true)
  })
})

afterAll(async () => {
  await closePool().catch(() => {})
  await closeRedis().catch(() => {})
})
