/**
 * Integration: Phase 9 surface — ratings flow, driver earnings summary,
 * support tickets.
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { buildApp } from '../../src/app.js'
import { pool, closePool } from '../../src/config/database.js'
import { closeRedis } from '../../src/config/redis.js'
import { cleanRideWorld, deleteCityByName, flushRateLimits } from './helpers/db-clean.js'

const CITY = 'Extrasville'
let app
let passengerToken, passengerId, driverId

beforeAll(async () => {
  await cleanRideWorld()
  await deleteCityByName(CITY)
  await flushRateLimits()
  await pool.query(`DELETE FROM vehicle_categories WHERE code = 'EX_AUTO'`).catch(() => {})
  await pool.query(`DELETE FROM users WHERE phone_e164 = ANY($1)`, [['+919876588888', '+919876599999']]).catch(() => {})

  app = await buildApp()
  await app.ready()

  const cityId = (await pool.query(`INSERT INTO cities (name) VALUES ($1) RETURNING id`, [CITY])).rows[0].id
  const categoryId = (await pool.query(`INSERT INTO vehicle_categories (code, display_name, capacity) VALUES ('EX_AUTO', 'Auto', 3) RETURNING id`)).rows[0].id
  await pool.query(`INSERT INTO fare_rules (version, city_id, vehicle_category_id, base_fare_paise, min_fare_paise, per_km_paise) VALUES ('v1', $1, $2, 3000, 5000, 850)`, [cityId, categoryId])

  passengerId = (await pool.query(`INSERT INTO users (phone_e164, role) VALUES ('+919876588888', 'PASSENGER') RETURNING id`)).rows[0].id
  driverId = (await pool.query(`INSERT INTO users (phone_e164, role) VALUES ('+919876599999', 'DRIVER') RETURNING id`)).rows[0].id
  await pool.query(`INSERT INTO driver_profiles (user_id, approval_state) VALUES ($1, 'APPROVED')`, [driverId])

  async function login(phone, role) {
    const otp = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone, role }, remoteAddress: '10.5.0.1' })
    return (await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone, otp: otp.json().demoOtp, role }, remoteAddress: '10.5.0.2' })).json().accessToken
  }
  passengerToken = await login('+919876588888', 'PASSENGER')

  // Completed ride with earnings
  const quoteId = (
    await pool.query(
      `INSERT INTO ride_quotes (user_id, city_id, vehicle_category_id, pickup, drop, route_provider, route_distance_m, route_duration_s, base_fare_paise, distance_fare_paise, total_paise, pricing_version, expires_at, fare_rule_id)
       VALUES ($1,$2,$3,'SRID=4326;POINT(88.36 22.57)','SRID=4326;POINT(88.42 22.61)','ola_maps',5000,600,3000,4250,7250,'v1',NOW() + INTERVAL '2 minutes',
         (SELECT id FROM fare_rules WHERE city_id = $2 AND vehicle_category_id = $3))
       RETURNING id`,
      [passengerId, cityId, categoryId],
    )
  ).rows[0].id
  const reqId = (
    await pool.query(
      `INSERT INTO ride_requests (user_id, quote_id, vehicle_category_id, payment_method, booking_snapshot, idempotency_key, request_hash) VALUES ($1,$2,$3,'CASH','{}','ex-r-1','h') RETURNING id`,
      [passengerId, quoteId, categoryId],
    )
  ).rows[0].id
  globalThis.__rideId = (
    await pool.query(
      `INSERT INTO rides (request_id, passenger_id, driver_id, vehicle_category_id, city_id, quote_id, status, payment_method, pickup, drop, route_distance_m, route_duration_s, started_at, completed_at, final_total_paise)
       VALUES ($1,$2,$3,$4,$5,$6,'COMPLETED','CASH','SRID=4326;POINT(88.36 22.57)','SRID=4326;POINT(88.42 22.61)',5000,600,NOW(),NOW(),7250) RETURNING id`,
      [reqId, passengerId, driverId, categoryId, cityId, quoteId],
    )
  ).rows[0].id
  await pool.query(
    `INSERT INTO driver_earnings (ride_id, driver_id, fare_total_paise, commission_paise, net_earning_paise, pricing_version)
     VALUES ($1, $2, 7250, 1088, 6162, 'v1')`,
    [globalThis.__rideId, driverId],
  )
})

describe('ratings + earnings + support (Phase 9 surface)', () => {
  it('passenger rates the driver once; duplicate rating rejected; aggregates update', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/rides/${globalThis.__rideId}/rating`,
      headers: { authorization: `Bearer ${passengerToken}` },
      payload: { score: 5, comment: 'Great ride' },
      remoteAddress: '10.5.0.3',
    })
    expect(res.statusCode).toBe(201)

    const dup = await app.inject({
      method: 'POST', url: `/api/v1/rides/${globalThis.__rideId}/rating`,
      headers: { authorization: `Bearer ${passengerToken}` },
      payload: { score: 1 },
      remoteAddress: '10.5.0.4',
    })
    expect(dup.statusCode).toBe(409)

    const { rows } = await pool.query(`SELECT rating_sum, rating_count FROM driver_profiles WHERE user_id = $1`, [driverId])
    expect(rows[0].rating_sum).toBe(5)
    expect(rows[0].rating_count).toBe(1)
  })

  it('driver earnings summary exposes today + ledger balance', async () => {
    // Login as driver
    const otp = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone: '+919876599999', role: 'DRIVER' }, remoteAddress: '10.5.0.5' })
    const driverToken = (
      await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone: '+919876599999', otp: otp.json().demoOtp, role: 'DRIVER' }, remoteAddress: '10.5.0.6' })
    ).json().accessToken
    const res = await app.inject({
      method: 'GET', url: '/api/v1/drivers/me/earnings',
      headers: { authorization: `Bearer ${driverToken}` },
      remoteAddress: '10.5.0.7',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().todayPaise).toBe(6162)
    expect(Array.isArray(res.json().payouts)).toBe(true)
  })

  it('passenger creates a support ticket; ticket message stored', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/support/tickets',
      headers: { authorization: `Bearer ${passengerToken}` },
      payload: { category: 'PAYMENT_ISSUE', subject: 'Charged twice?', body: 'I think I was double charged for my ride.' },
      remoteAddress: '10.5.0.8',
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().ticketNumber).toBeGreaterThan(0)

    const list = await app.inject({
      method: 'GET', url: '/api/v1/support/tickets',
      headers: { authorization: `Bearer ${passengerToken}` },
      remoteAddress: '10.5.0.9',
    })
    expect(list.json().tickets.length).toBe(1)
  })
})

afterAll(async () => {
  await cleanRideWorld().catch(() => {})
  await deleteCityByName(CITY).catch(() => {})
  await pool.query(`DELETE FROM vehicle_categories WHERE code = 'EX_AUTO'`).catch(() => {})
  await pool.query(`DELETE FROM users WHERE phone_e164 = ANY($1)`, [['+919876588888', '+919876599999']]).catch(() => {})
  await closePool().catch(() => {})
  await closeRedis().catch(() => {})
})
