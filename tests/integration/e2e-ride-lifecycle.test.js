/**
 * PHASE 14 — END-TO-END RIDE LIFECYCLE over real HTTP (spec 13 §19 gate):
 * passenger login → quote → book → dispatch wave → driver accept →
 * arrive → PIN → start → complete → cash → rating → Guardian Journey.
 *
 * Maps provider mocked; everything else is the real stack (Fastify +
 * PostgreSQL/PostGIS + Redis + socket emitter + outbox).
 */
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import { pool, closePool } from '../../src/config/database.js'
import { closeRedis } from '../../src/config/redis.js'
import { cleanRideWorld, deleteCityByName, flushRateLimits } from './helpers/db-clean.js'
import { startGuardianJourney, confirmGuardianSafe, upsertSafetySettings } from '../../src/modules/safety/safety.service.js'
import { runWave } from '../../src/modules/dispatch/dispatch.service.js'
import { DriverRideService } from '../../src/modules/drivers/driver-ride.service.js'

vi.mock('../../src/modules/maps/maps.client.js', () => ({
  directions: vi.fn(async () => ({ distanceM: 8000, durationS: 900, polyline: 'e2e' })),
  autocomplete: vi.fn(), placeDetails: vi.fn(), reverseGeocode: vi.fn(),
  testConnection: vi.fn(), mapsProviderSnapshot: vi.fn(),
}))

const CITY = 'E2Eville'
const RING = '88.30 22.50, 88.50 22.50, 88.50 22.70, 88.30 22.70, 88.30 22.50'
const PICKUP = { lat: 22.57, lng: 88.36 }
const DROP = { lat: 22.61, lng: 88.42 }
const DRIVER = '+919876570001'
const PASSENGER = '+919876580001'

let app
let passengerToken, driverToken, driverId
const driverRideService = new DriverRideService()

async function login(phone, role) {
  const otp = await app.inject({
    method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone, role }, remoteAddress: '10.9.0.1',
  })
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone, otp: otp.json().demoOtp, role }, remoteAddress: '10.9.0.2',
  })
  return { token: res.json().accessToken, userId: res.json().user.id }
}

beforeAll(async () => {
  await cleanRideWorld()
  await deleteCityByName(CITY)
  await flushRateLimits()
  await pool.query(`DELETE FROM vehicle_categories WHERE code = 'E2E_AUTO'`).catch(() => {})
  await pool.query(`DELETE FROM users WHERE phone_e164 = ANY($1)`, [[DRIVER, PASSENGER]]).catch(() => {})

  app = await buildApp()
  await app.ready()

  const cityId = (await pool.query(`INSERT INTO cities (name) VALUES ($1) RETURNING id`, [CITY])).rows[0].id
  await pool.query(`INSERT INTO service_zones (city_id, name, boundary) VALUES ($1, 'Core', ST_GeomFromText('SRID=4326;MULTIPOLYGON(((${RING})))'))`, [cityId])
  const categoryId = (await pool.query(`INSERT INTO vehicle_categories (code, display_name, capacity) VALUES ('E2E_AUTO', 'Auto', 3) RETURNING id`)).rows[0].id
  await pool.query(`INSERT INTO city_vehicle_categories (city_id, vehicle_category_id) VALUES ($1, $2)`, [cityId, categoryId])
  await pool.query(
    `INSERT INTO fare_rules (version, city_id, vehicle_category_id, base_fare_paise, min_fare_paise, per_km_paise, per_minute_paise, platform_fee_paise, commission_bps)
     VALUES ('v1', $1, $2, 3000, 5000, 850, 100, 500, 2000)`,
    [cityId, categoryId],
  )
  globalThis.__e2eSeed = { cityId, categoryId }

  const driver = await login(DRIVER, 'DRIVER')
  driverToken = driver.token
  driverId = driver.userId
  await pool.query(`INSERT INTO driver_profiles (user_id, approval_state, city_id) VALUES ($1, 'APPROVED', $2) ON CONFLICT (user_id) DO UPDATE SET approval_state = 'APPROVED', city_id = $2`, [driverId, cityId])
  const vehicleId = (await pool.query(`INSERT INTO vehicles (category_id, owner_user_id, model, registration_number) VALUES ($1, $2, 'Auto', 'KA00XY0001') RETURNING id`, [categoryId, driverId])).rows[0].id
  await pool.query(`INSERT INTO driver_vehicle_assignments (driver_id, vehicle_id) VALUES ($1, $2)`, [driverId, vehicleId])
  await pool.query(`UPDATE driver_profiles SET active_vehicle_id = $2 WHERE user_id = $1`, [driverId, vehicleId])

  const passenger = await login(PASSENGER, 'PASSENGER')
  passengerToken = passenger.token
})

describe('E2E ride lifecycle (spec 13 §19 acceptance gate)', () => {
  let rideId, offerId, tripPin

  it('driver goes online with a fresh GPS fix', async () => {
    const { cityId } = globalThis.__e2eSeed
    const res = await app.inject({
      method: 'POST', url: '/api/v1/drivers/me/online',
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { lat: PICKUP.lat + 0.002, lng: PICKUP.lng },
      remoteAddress: '10.9.0.3',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().online).toBe(true)
    void cityId
  })

  it('passenger gets a route-based quote (server-authoritative fare)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/quotes',
      headers: { authorization: `Bearer ${passengerToken}` },
      payload: { pickup: PICKUP, drop: DROP },
      remoteAddress: '10.9.0.4',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().categories[0].totalPaise).toBeGreaterThan(0)
    globalThis.__quote = res.json().categories[0]
  })

  it('passenger books; ride is SEARCHING with an idempotency key', async () => {
    const quote = globalThis.__quote
    const res = await app.inject({
      method: 'POST', url: '/api/v1/rides',
      headers: { authorization: `Bearer ${passengerToken}`, 'idempotency-key': 'e2e-book-1' },
      payload: { quoteId: quote.quoteId, pickup: PICKUP, drop: DROP, paymentMethod: 'CASH' },
      remoteAddress: '10.9.0.5',
    })
    expect(res.statusCode).toBe(201)
    rideId = res.json().rideId
    expect(res.json().status).toBe('SEARCHING')
  })

  it('dispatch waves the offer; driver accepts; ride ASSIGNED', async () => {
    const wave = await runWave(rideId, 0)
    expect(wave.offers).toBeGreaterThan(0)
    const { rows: offers } = await pool.query(`SELECT id, driver_id FROM ride_offers WHERE ride_id = $1 AND state = 'OFFERED'`, [rideId])
    expect(offers[0].driver_id).toBe(driverId)
    offerId = offers[0].id

    const res = await app.inject({
      method: 'POST', url: `/api/v1/rides/${rideId}/accept`,
      headers: { authorization: `Bearer ${driverToken}` },
      payload: { offerId },
      remoteAddress: '10.9.0.6',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('ASSIGNED')
  })

  it('passenger receives the trip PIN; driver payload never contains it', async () => {
    const pinRes = await app.inject({
      method: 'POST', url: `/api/v1/rides/${rideId}/pin`,
      headers: { authorization: `Bearer ${passengerToken}` },
      remoteAddress: '10.9.0.7',
    })
    expect(pinRes.statusCode).toBe(200)
    tripPin = pinRes.json().pin
    expect(tripPin).toMatch(/^\d{4}$/)

    const driverView = await app.inject({
      method: 'GET', url: `/api/v1/rides/${rideId}`,
      headers: { authorization: `Bearer ${driverToken}` },
      remoteAddress: '10.9.0.8',
    })
    expect(driverView.body).not.toContain(tripPin)
  })

  it('driver arrives, verifies PIN, starts the trip', async () => {
    const arrived = await driverRideService.arrived({ rideId, driverId })
    expect(arrived.status).toBe('DRIVER_ARRIVED')

    const pin = await driverRideService.verifyPin({ rideId, driverId, pin: tripPin })
    expect(pin.verified).toBe(true)

    const started = await driverRideService.start({ rideId, driverId })
    expect(started.status).toBe('IN_PROGRESS')
  })

  it('completion returns the server-authoritative earning + cash due', async () => {
    const res = await driverRideService.complete({ rideId, driverId })
    expect(res.status).toBe('COMPLETED')
    expect(res.earning.netEarningPaise).toBeGreaterThan(0)
    expect(res.cashDuePaise).toBe(res.earning.totalPaise)
    expect(res.cashDuePaise).toBe(res.earning.totalPaise)
  })

  it('passenger rates the ride; rating aggregate updates', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/rides/${rideId}/rating`,
      headers: { authorization: `Bearer ${passengerToken}` },
      payload: { score: 5, comment: 'E2E smooth ride' },
      remoteAddress: '10.9.0.9',
    })
    expect(res.statusCode).toBe(201)
    const { rows } = await pool.query(`SELECT rating_count FROM driver_profiles WHERE user_id = $1`, [driverId])
    expect(rows[0].rating_count).toBe(1)
  })

  it('Guardian Journey opens after completion and closes on I-AM-SAFE', async () => {
    await upsertSafetySettings(
      (await pool.query(`SELECT id FROM users WHERE phone_e164 = $1`, [PASSENGER])).rows[0].id,
      { guardian_all_rides: true },
    )
    const passengerId = (await pool.query(`SELECT id FROM users WHERE phone_e164 = $1`, [PASSENGER])).rows[0].id
    const started = await startGuardianJourney({ rideId, passengerId })
    expect(started.started).toBe(true)
    const confirmed = await confirmGuardianSafe({ rideId, userId: passengerId })
    expect(confirmed.confirmed).toBe(true)
  })

  it('resync endpoint replays the full versioned timeline (spec 09 §15)', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/rides/${rideId}/events?sinceVersion=0`,
      headers: { authorization: `Bearer ${passengerToken}` },
      remoteAddress: '10.9.0.10',
    })
    expect(res.statusCode).toBe(200)
    const events = res.json().events.map((e) => e.eventType)
    expect(events).toEqual(
      expect.arrayContaining(['RIDE_CREATED', 'RIDE_ASSIGNED', 'RIDE_DRIVER_ARRIVED', 'RIDE_STARTED', 'RIDE_COMPLETED']),
    )
  })
})

afterAll(async () => {
  await cleanRideWorld().catch(() => {})
  await deleteCityByName(CITY).catch(() => {})
  await pool.query(`DELETE FROM vehicle_categories WHERE code = 'E2E_AUTO'`).catch(() => {})
  await pool.query(`DELETE FROM users WHERE phone_e164 = ANY($1)`, [[DRIVER, PASSENGER]]).catch(() => {})
  await closePool().catch(() => {})
  await closeRedis().catch(() => {})
})
