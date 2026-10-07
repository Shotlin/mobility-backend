/**
 * Integration: quote → booking → cancel against live DB with the maps
 * provider MOCKED (no external calls). Verifies idempotent booking,
 * ownership scoping, state-guarded cancellation, and PIN issuance.
 */
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import { pool, closePool } from '../../src/config/database.js'
import { closeRedis } from '../../src/config/redis.js'
import { cleanRideWorld, deleteCityByName, flushRateLimits } from './helpers/db-clean.js'

// Mock ONLY the provider boundary — everything else is real. vi.mock is
// hoisted above imports, so app.js receives the mocked maps client.
vi.mock('../../src/modules/maps/maps.client.js', () => ({
  directions: vi.fn(async () => ({ distanceM: 8000, durationS: 900, polyline: 'mocked-polyline' })),
  autocomplete: vi.fn(),
  placeDetails: vi.fn(),
  reverseGeocode: vi.fn(),
  testConnection: vi.fn(),
  mapsProviderSnapshot: vi.fn(),
}))

const PASSENGER = '+919000003101'
const OTHER = '+919000003102'
const CITY = 'Rideville'
const POLY = 'SRID=4326;MULTIPOLYGON((({RING})))'
const RING = '88.30 22.50, 88.50 22.50, 88.50 22.70, 88.30 22.70, 88.30 22.50'

let app
let passengerToken, otherToken
let cityId, categoryId, quoteId

beforeAll(async () => {
  for (const phone of [PASSENGER, OTHER]) {
    await pool.query(`DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE phone_e164 = $1)`, [phone])
    await pool.query(`DELETE FROM users WHERE phone_e164 = $1`, [phone])
  }
  await cleanRideWorld()
  await deleteCityByName(CITY)
  await flushRateLimits()

  app = await buildApp()
  await app.ready()

  cityId = (
    await pool.query(
      `INSERT INTO cities (name, bookings_enabled) VALUES ($1, true) RETURNING id`,
      [CITY],
    )
  ).rows[0].id
  await pool.query(
    `INSERT INTO service_zones (city_id, name, boundary) VALUES ($1, 'Core', ST_GeomFromText($2))`,
    [cityId, POLY.replace('{RING}', RING)],
  )
  categoryId = (
    await pool.query(
      `INSERT INTO vehicle_categories (code, display_name, capacity) VALUES ('AUTO_T', 'Auto', 3) RETURNING id`,
    )
  ).rows[0].id
  await pool.query(
    `INSERT INTO city_vehicle_categories (city_id, vehicle_category_id) VALUES ($1, $2)`,
    [cityId, categoryId],
  )
  await pool.query(
    `INSERT INTO fare_rules (version, city_id, vehicle_category_id, base_fare_paise, min_fare_paise,
       per_km_paise, per_minute_paise, platform_fee_paise, cancellation_fee_paise)
     VALUES ('v1', $1, $2, 3000, 5000, 850, 100, 500, 2500)`,
    [cityId, categoryId],
  )

  async function login(phone) {
    const otp = await app.inject({
      method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone }, remoteAddress: '10.2.0.1',
    })
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone, otp: otp.json().demoOtp },
      remoteAddress: '10.2.0.2',
    })
    return res.json().accessToken
  }
  passengerToken = await login(PASSENGER)
  otherToken = await login(OTHER)

  // Create a quote (maps mocked).
  const quote = await app.inject({
    method: 'POST',
    url: '/api/v1/quotes',
    headers: { authorization: `Bearer ${passengerToken}` },
    payload: {
      pickup: { lat: 22.57, lng: 88.36 },
      drop: { lat: 22.61, lng: 88.42 },
      vehicleCategoryId: categoryId,
    },
    remoteAddress: '10.2.0.3',
  })
  expect(quote.statusCode).toBe(200)
  quoteId = quote.json().categories[0].quoteId
})

describe('booking + cancellation flow (spec 13 §7-§13)', () => {
  let rideId

  it('books a ride from a quote with Idempotency-Key → SEARCHING', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rides',
      headers: { authorization: `Bearer ${passengerToken}`, 'idempotency-key': 'book-key-1' },
      payload: {
        quoteId,
        pickup: { lat: 22.57, lng: 88.36 },
        drop: { lat: 22.61, lng: 88.42 },
        paymentMethod: 'CASH',
      },
      remoteAddress: '10.2.0.4',
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.status).toBe('SEARCHING')
    expect(body.rideVersion).toBe(1)
    rideId = body.rideId
  })

  it('replays the same key → SAME ride (no duplicate rows)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rides',
      headers: { authorization: `Bearer ${passengerToken}`, 'idempotency-key': 'book-key-1' },
      payload: {
        quoteId,
        pickup: { lat: 22.57, lng: 88.36 },
        drop: { lat: 22.61, lng: 88.42 },
        paymentMethod: 'CASH',
      },
      remoteAddress: '10.2.0.5',
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().rideId).toBe(rideId)
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM rides WHERE passenger_id IN (SELECT id FROM users WHERE phone_e164 = $1)`, [PASSENGER])
    expect(rows[0].n).toBe(1)
  })

  it('same key with different payload → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rides',
      headers: { authorization: `Bearer ${passengerToken}`, 'idempotency-key': 'book-key-1' },
      payload: {
        quoteId,
        pickup: { lat: 22.58, lng: 88.37 }, // different pickup
        drop: { lat: 22.61, lng: 88.42 },
        paymentMethod: 'CASH',
      },
      remoteAddress: '10.2.0.6',
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('missing idempotency key → 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rides',
      headers: { authorization: `Bearer ${passengerToken}` },
      payload: {
        quoteId,
        pickup: { lat: 22.57, lng: 88.36 },
        drop: { lat: 22.61, lng: 88.42 },
        paymentMethod: 'CASH',
      },
      remoteAddress: '10.2.0.7',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
  })

  it('another passenger cannot read or cancel someone else’s ride', async () => {
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}`,
      headers: { authorization: `Bearer ${otherToken}` },
      remoteAddress: '10.2.0.8',
    })
    expect(read.statusCode).toBe(403)

    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/cancel`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { reason: 'SNOOP' },
      remoteAddress: '10.2.0.9',
    })
    expect(cancel.statusCode).toBe(403)
  })

  it('/rides/current returns the searching ride for its passenger', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/rides/current',
      headers: { authorization: `Bearer ${passengerToken}` },
      remoteAddress: '10.2.0.10',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().rideId).toBe(rideId)
  })

  it('passenger cancels while SEARCHING — free, terminal, version bumped', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/cancel`,
      headers: { authorization: `Bearer ${passengerToken}` },
      payload: { reason: 'CHANGE_OF_PLAN' },
      remoteAddress: '10.2.0.11',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('CANCELLED')
    expect(body.rideVersion).toBe(2)

    const double = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/cancel`,
      headers: { authorization: `Bearer ${passengerToken}` },
      payload: { reason: 'AGAIN' },
      remoteAddress: '10.2.0.12',
    })
    expect(double.statusCode).toBe(409)
    expect(['RIDE_ALREADY_CANCELLED', 'RIDE_INVALID_STATE']).toContain(double.json().error.code)
  })

  it('PIN cannot be issued for a terminal ride', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/pin`,
      headers: { authorization: `Bearer ${passengerToken}` },
      remoteAddress: '10.2.0.13',
    })
    expect(res.statusCode).toBe(409)
  })

  it('outbox holds RIDE_CREATED and RIDE_CANCELLED events', async () => {
    const { rows } = await pool.query(
      `SELECT event_type, published_at FROM outbox_events
        WHERE aggregate_type = 'RIDE' AND aggregate_id = $1
        ORDER BY created_at`,
      [rideId],
    )
    expect(rows.map((r) => r.event_type)).toEqual(['RIDE_CREATED', 'RIDE_CANCELLED'])
    // Not yet published (no worker running in test) — poller will pick up.
    expect(rows.every((r) => r.published_at === null)).toBe(true)
  })
})

afterAll(async () => {
  await cleanRideWorld().catch(() => {})
  await deleteCityByName(CITY).catch(() => {})
  await pool.query(`DELETE FROM vehicle_categories WHERE code = 'AUTO_T'`).catch(() => {})
  await pool.query(`DELETE FROM users WHERE phone_e164 = ANY($1)`, [[PASSENGER, OTHER]]).catch(() => {})
  await closePool().catch(() => {})
  await closeRedis().catch(() => {})
})
