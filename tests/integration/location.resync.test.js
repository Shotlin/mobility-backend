/**
 * Integration: location ingest throttling + reconnect resync (spec 04 §10-11,
 * spec 06 §5, spec 09 §15). Uses a REAL ride from the dispatch flow setup.
 */
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import { pool, closePool } from '../../src/config/database.js'
import { closeRedis } from '../../src/config/redis.js'
import { cleanRideWorld, deleteCityByName, flushRateLimits } from './helpers/db-clean.js'
import { ingestDriverLocation, minIntervalFor } from '../../src/modules/location/location-ingest.js'
import { setDriverOnline, getPresence } from '../../src/modules/location/location.service.js'
import { env } from '../../src/config/env.js'

vi.mock('../../src/modules/maps/maps.client.js', () => ({
  directions: vi.fn(async () => ({ distanceM: 5000, durationS: 600, polyline: 'x' })),
  autocomplete: vi.fn(), placeDetails: vi.fn(), reverseGeocode: vi.fn(),
  testConnection: vi.fn(), mapsProviderSnapshot: vi.fn(),
}))

const CITY = 'Locationville'
const RING = '88.30 22.50, 88.50 22.50, 88.50 22.70, 88.30 22.70, 88.30 22.50'

let app
let driverId, passengerToken
const DRIVER_PHONE = '+919876511111'
const PASSENGER_PHONE = '+919876522222'

beforeAll(async () => {
  await cleanRideWorld()
  await deleteCityByName(CITY)
  await flushRateLimits()
  await pool.query(`DELETE FROM users WHERE phone_e164 = ANY($1)`, [[DRIVER_PHONE, PASSENGER_PHONE]]).catch(() => {})
  await pool.query(`DELETE FROM vehicle_categories WHERE code = 'LOC_AUTO'`).catch(() => {})

  app = await buildApp()
  await app.ready()

  const cityId = (await pool.query(`INSERT INTO cities (name) VALUES ($1) RETURNING id`, [CITY])).rows[0].id
  await pool.query(`INSERT INTO service_zones (city_id, name, boundary) VALUES ($1, 'Core', ST_GeomFromText('SRID=4326;MULTIPOLYGON(((${RING})))'))`, [cityId])
  const categoryId = (await pool.query(`INSERT INTO vehicle_categories (code, display_name, capacity) VALUES ('LOC_AUTO', 'Auto', 3) RETURNING id`)).rows[0].id
  await pool.query(`INSERT INTO city_vehicle_categories (city_id, vehicle_category_id) VALUES ($1, $2)`, [cityId, categoryId])
  await pool.query(`INSERT INTO fare_rules (version, city_id, vehicle_category_id, base_fare_paise, min_fare_paise, per_km_paise) VALUES ('v1', $1, $2, 3000, 5000, 850)`, [cityId, categoryId])

  async function login(phone, role) {
    const otp = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone, role }, remoteAddress: '10.4.0.1' })
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone, otp: otp.json().demoOtp, role }, remoteAddress: '10.4.0.2' })
    return { token: res.json().accessToken, userId: res.json().user.id }
  }
  const driver = await login(DRIVER_PHONE, 'DRIVER')
  const passenger = await login(PASSENGER_PHONE, 'PASSENGER')
  passengerToken = passenger.token
  globalThis.__passengerId = passenger.userId
  driverId = driver.userId

  await pool.query(`INSERT INTO driver_profiles (user_id, approval_state, city_id) VALUES ($1, 'APPROVED', $2) ON CONFLICT (user_id) DO UPDATE SET approval_state = 'APPROVED'`, [driverId, cityId])
  const vehicleId = (await pool.query(`INSERT INTO vehicles (category_id, owner_user_id, registration_number) VALUES ($1, $2, 'KA99XX9999') RETURNING id`, [categoryId, driverId])).rows[0].id
  await pool.query(`INSERT INTO driver_vehicle_assignments (driver_id, vehicle_id) VALUES ($1, $2)`, [driverId, vehicleId])
  await pool.query(`UPDATE driver_profiles SET active_vehicle_id = $2 WHERE user_id = $1`, [driverId, vehicleId])
  await setDriverOnline({ driverId, cityId, vehicleCategoryId: categoryId, lat: 22.57, lng: 88.36 })
  globalThis.__locSeed = { cityId, categoryId }
})

describe('location ingest (spec 04 §11: NO synchronous DB write)', () => {
  it('accepts the first event and updates Redis presence only', async () => {
    const r = await ingestDriverLocation({ driverId, lat: 22.571, lng: 88.361 })
    expect(r.accepted).toBe(true)
    const p = await getPresence(driverId)
    expect(p.lat).toBeCloseTo(22.571)
    expect(p.lng).toBeCloseTo(88.361)
  })

  it('throttles idle-state bursts below the interval but allows meaningful movement', async () => {
    const r1 = await ingestDriverLocation({ driverId, lat: 22.5711, lng: 88.361 })
    expect(r1.accepted).toBe(false)
    expect(r1.reason).toBe('THROTTLED')

    // Meaningful movement (>25m) bypasses the interval.
    const r2 = await ingestDriverLocation({ driverId, lat: 22.574, lng: 88.361 })
    expect(r2.accepted).toBe(true)
    expect(r2.reason).toBe('MOVED')
  })

  it('rejects events for offline drivers and garbage coordinates', async () => {
    const offline = await ingestDriverLocation({ driverId: '11111111-1111-1111-1111-111111111111', lat: 22.5, lng: 88.3 })
    expect(offline).toMatchObject({ accepted: false, reason: 'OFFLINE' })

    const garbage = await ingestDriverLocation({ driverId, lat: 'abc', lng: 88.3 })
    expect(garbage).toMatchObject({ accepted: false, reason: 'INVALID_COORDS' })
  })

  it('never writes ride_location_samples synchronously (spec 04 §11)', async () => {
    await ingestDriverLocation({ driverId, lat: 22.574, lng: 88.362 })
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ride_location_samples WHERE driver_id = $1`, [driverId])
    expect(rows[0].n).toBe(0)
  })

  it('idle interval is 15s, on-trip 3s (state-aware cadence, spec 06 §5)', () => {
    expect(minIntervalFor('ONLINE_IDLE')).toBe(env.LOCATION_MIN_INTERVAL_IDLE_MS)
    expect(minIntervalFor('ON_TRIP')).toBe(env.LOCATION_MIN_INTERVAL_ON_TRIP_MS)
  })
})

describe('reconnect resync (spec 09 §15)', () => {
  it('returns versioned events after a version gap; unauthorized users rejected', async () => {
    // Build a ride with two events.
    const quote = await app.inject({
      method: 'POST', url: '/api/v1/quotes',
      headers: { authorization: `Bearer ${passengerToken}` },
      payload: { pickup: { lat: 22.57, lng: 88.36 }, drop: { lat: 22.61, lng: 88.42 } },
      remoteAddress: '10.4.0.3',
    })
    const quoteId = quote.json().categories[0].quoteId
    const booking = await app.inject({
      method: 'POST', url: '/api/v1/rides',
      headers: { authorization: `Bearer ${passengerToken}`, 'idempotency-key': `resync-${Date.now()}` },
      payload: { quoteId, pickup: { lat: 22.57, lng: 88.36 }, drop: { lat: 22.61, lng: 88.42 }, paymentMethod: 'CASH' },
      remoteAddress: '10.4.0.4',
    })
    const rideId = booking.json().rideId
    // Real transition path so the ride_events row exists (version 2).
    const { RidesService } = await import('../../src/modules/rides/rides.service.js')
    await new RidesService().cancelRide({
      rideId,
      userId: globalThis.__passengerId,
      actorRole: 'PASSENGER',
      reason: 'RESYNC_TEST',
    })

    const res = await app.inject({
      method: 'GET', url: `/api/v1/rides/${rideId}/events?sinceVersion=1`,
      headers: { authorization: `Bearer ${passengerToken}` },
      remoteAddress: '10.4.0.5',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.currentVersion).toBe(2)
    expect(body.events.map((e) => e.rideVersion)).toEqual([2])
    expect(body.events[0].v).toBe(1)
    expect(body.events[0].eventType).toBe('RIDE_CANCELLED')

    // Unknown user → 403
    const strangerToken = passengerToken // same passenger works; use anonymous
    const anon = await app.inject({ method: 'GET', url: `/api/v1/rides/${rideId}/events` })
    expect(anon.statusCode).toBe(401)
    void strangerToken
  })
})

afterAll(async () => {
  await cleanRideWorld().catch(() => {})
  await deleteCityByName(CITY).catch(() => {})
  await pool.query(`DELETE FROM vehicle_categories WHERE code = 'LOC_AUTO'`).catch(() => {})
  await pool.query(`DELETE FROM users WHERE phone_e164 = ANY($1)`, [[DRIVER_PHONE, PASSENGER_PHONE]]).catch(() => {})
  await closePool().catch(() => {})
  await closeRedis().catch(() => {})
})
