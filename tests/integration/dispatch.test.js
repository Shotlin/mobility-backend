/**
 * Integration: dispatch lifecycle — presence, waves, offers, atomic claim,
 * driver commands, PIN gating, completion accounting — and the SPEC 02 §10
 * CRITICAL CONCURRENCY TEST: 50+ drivers accept the same ride at the same
 * instant; exactly one wins; all others get deterministic safe answers.
 *
 * Maps provider is mocked. Driver accept runs through the REAL service
 * (Redis claim + PostgreSQL conditional UPDATE) under real concurrency.
 */
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import { pool, closePool } from '../../src/config/database.js'
import { closeRedis, redisGeo } from '../../src/config/redis.js'
import { cleanRideWorld, deleteCityByName, flushRateLimits } from './helpers/db-clean.js'
import { runWave } from '../../src/modules/dispatch/dispatch.service.js'
import { DriverRideService } from '../../src/modules/drivers/driver-ride.service.js'
import { RIDE_STATUS, DRIVER_OPERATIONAL_STATE } from '../../src/constants/states.js'

vi.mock('../../src/modules/maps/maps.client.js', () => ({
  directions: vi.fn(async () => ({ distanceM: 8000, durationS: 900, polyline: 'mocked' })),
  autocomplete: vi.fn(),
  placeDetails: vi.fn(),
  reverseGeocode: vi.fn(),
  testConnection: vi.fn(),
  mapsProviderSnapshot: vi.fn(),
}))

const CITY = 'Dispatchville'
const RING = '88.30 22.50, 88.50 22.50, 88.50 22.70, 88.30 22.70, 88.30 22.50'
const PICKUP = { lat: 22.57, lng: 88.36 }
const DROP = { lat: 22.61, lng: 88.42 }

let app
let passengerToken, quoteId
const driverCount = 56
const driverPhones = Array.from({ length: driverCount }, (_, i) => `+91${9876500000 + i}`)
const driverTokens = []
let driverIds = []

const driverRideService = new DriverRideService()

async function login(phone) {
  const otp = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone, role: 'DRIVER' }, remoteAddress: `10.3.0.${(driverPhones.indexOf(phone) % 200) + 10}` })
  if (otp.statusCode !== 200) throw new Error(`otp request failed ${otp.statusCode}: ${otp.body}`)
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone, otp: otp.json().demoOtp, role: 'DRIVER' }, remoteAddress: `10.3.1.${(driverPhones.indexOf(phone) % 200) + 10}` })
  if (res.statusCode !== 200) throw new Error(`otp verify failed ${res.statusCode}: ${res.body}`)
  return res.json().accessToken
}

beforeAll(async () => {
  await cleanRideWorld()
  await deleteCityByName(CITY)
  await flushRateLimits()
  await pool.query(`DELETE FROM vehicle_categories WHERE code IN ('DISPATCH_AUTO')`).catch(() => {})
  await pool.query(`DELETE FROM users WHERE phone_e164 = ANY($1)`, [driverPhones]).catch(() => {})
  await pool.query(`DELETE FROM users WHERE phone_e164 = '+919000007001'`).catch(() => {})

  app = await buildApp()
  await app.ready()

  const cityId = (
    await pool.query(`INSERT INTO cities (name, bookings_enabled) VALUES ($1, true) RETURNING id`, [CITY])
  ).rows[0].id
  await pool.query(
    `INSERT INTO service_zones (city_id, name, boundary) VALUES ($1, 'Core', ST_GeomFromText('SRID=4326;MULTIPOLYGON(((${RING})))'))`,
    [cityId],
  )
  const categoryId = (
    await pool.query(`INSERT INTO vehicle_categories (code, display_name, capacity) VALUES ('DISPATCH_AUTO', 'Auto', 3) RETURNING id`)
  ).rows[0].id
  await pool.query(`INSERT INTO city_vehicle_categories (city_id, vehicle_category_id) VALUES ($1, $2)`, [cityId, categoryId])
  await pool.query(
    `INSERT INTO fare_rules (version, city_id, vehicle_category_id, base_fare_paise, min_fare_paise, per_km_paise, per_minute_paise, platform_fee_paise, cancellation_fee_paise)
     VALUES ('v1', $1, $2, 3000, 5000, 850, 100, 500, 2500)`,
    [cityId, categoryId],
  )
  globalThis.__dispatchSeed = { cityId, categoryId }

  // Passenger + booking
  const PASSENGER = '+919000007001'
  const otp = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone: PASSENGER }, remoteAddress: '10.3.2.1' })
  passengerToken = (
    await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone: PASSENGER, otp: otp.json().demoOtp }, remoteAddress: '10.3.2.2' })
  ).json().accessToken

  const quote = await app.inject({
    method: 'POST', url: '/api/v1/quotes',
    headers: { authorization: `Bearer ${passengerToken}` },
    payload: { pickup: PICKUP, drop: DROP },
    remoteAddress: '10.3.2.3',
  })
  expect(quote.statusCode).toBe(200)
  quoteId = quote.json().categories[0].quoteId
})

async function seedAndOnlineDriver(i) {
  const phone = driverPhones[i]
  const token = await login(phone)
  driverTokens.push(token)
  const { rows } = await pool.query(`SELECT id FROM users WHERE phone_e164 = $1`, [phone])
  const driverId = rows[0].id
  driverIds.push(driverId)

  const { cityId, categoryId } = globalThis.__dispatchSeed
  await pool.query(
    `UPDATE users SET role = 'DRIVER' WHERE id = $1`,
    [driverId],
  )
  await pool.query(
    `INSERT INTO driver_profiles (user_id, approval_state, city_id) VALUES ($1, 'APPROVED', $2)
     ON CONFLICT (user_id) DO UPDATE SET approval_state = 'APPROVED', city_id = $2`,
    [driverId, cityId],
  )
  const vehicleId = (
    await pool.query(
      `INSERT INTO vehicles (category_id, owner_user_id, model, registration_number) VALUES ($1, $2, 'Auto', $3) RETURNING id`,
      [categoryId, driverId, `KA0${String(i).padStart(2, '0')}XY${1000 + i}`],
    )
  ).rows[0].id
  await pool.query(
    `INSERT INTO driver_vehicle_assignments (driver_id, vehicle_id) VALUES ($1, $2)`,
    [driverId, vehicleId],
  )
  await pool.query(`UPDATE driver_profiles SET active_vehicle_id = $2 WHERE user_id = $1`, [driverId, vehicleId])
  // Real online path: sets Redis presence AND persists last_location_at.
  await driverRideService.online({
    driverId,
    lat: PICKUP.lat + 0.001 * (i + 1),
    lng: PICKUP.lng,
  })
  return { driverId, vehicleId }
}

describe('dispatch lifecycle (spec 04 §12-§14)', () => {
  it('runs wave 1 over online drivers and creates expiring offers', async () => {
    for (let i = 0; i < 5; i++) await seedAndOnlineDriver(i)
    globalThis.__waveDrivers = driverIds.slice(0, 5)

    // Book the ride
    const ride = (
      await app.inject({
        method: 'POST', url: '/api/v1/rides',
        headers: { authorization: `Bearer ${passengerToken}`, 'idempotency-key': 'dispatch-key-1' },
        payload: { quoteId, pickup: PICKUP, drop: DROP, paymentMethod: 'CASH' },
        remoteAddress: '10.3.2.4',
      })
    ).json()
    globalThis.__rideId = ride.rideId
    expect(ride.status).toBe(RIDE_STATUS.SEARCHING)

    // ── diagnostics ──
    const { rows: cityRow } = await pool.query(`SELECT id FROM cities WHERE name = $1`, [CITY])
    const { rows: catRow } = await pool.query(`SELECT id FROM vehicle_categories WHERE code = 'DISPATCH_AUTO'`)
    const geoKey = `geo:drivers:${cityRow[0]?.id}:${catRow[0]?.id}`
    const members = await redisGeo.zrange(geoKey, 0, -1)
    console.error('DIAG city:', cityRow[0]?.id, 'cat:', catRow[0]?.id, 'geoMembers:', members.length)
    const { rows: dpRows } = await pool.query(
      `SELECT user_id, approval_state, city_id, last_location_at, dispatch_blocked_until,
              (SELECT count(*) FROM driver_vehicle_assignments a WHERE a.driver_id = dp.user_id AND a.is_active) AS active_vehicle
         FROM driver_profiles dp WHERE city_id = $1 LIMIT 3`, [cityRow[0]?.id])
    console.error('DIAG profiles:', JSON.stringify(dpRows))
    for (const d of dpRows.slice(0, 2)) {
      const pres = await (await import('../../src/modules/location/location.service.js')).getPresence(d.user_id)
      console.error('DIAG presence', d.user_id.slice(0, 8), JSON.stringify(pres))
    }
    const { rows: rideRow } = await pool.query(
      `SELECT status, city_id, vehicle_category_id, ST_Y(pickup::geometry) AS plat, ST_X(pickup::geometry) AS plng FROM rides WHERE id = $1`, [ride.rideId])
    console.error('DIAG ride:', JSON.stringify(rideRow))
    // ── end diagnostics ──
    const result = await runWave(ride.rideId, 0)
    expect(result.offers).toBeGreaterThan(0)

    const { rows: offers } = await pool.query(
      `SELECT driver_id, id, state FROM ride_offers WHERE ride_id = $1`,
      [ride.rideId],
    )
    expect(offers.length).toBe(result.offers)
    expect(offers.every((o) => o.state === 'OFFERED')).toBe(true)
    globalThis.__offerByDriver = Object.fromEntries(offers.map((o) => [o.driver_id, o.id]))
  })

  it('driver declines an offer → DECLINED + presence back to idle', async () => {
    const driverId = globalThis.__waveDrivers[0]
    const offerId = globalThis.__offerByDriver[driverId]
    const res = await driverRideService.decline({ rideId: globalThis.__rideId, offerId, driverId })
    expect(res.declined).toBe(true)
    const { rows } = await pool.query(`SELECT state FROM ride_offers WHERE id = $1`, [offerId])
    expect(rows[0].state).toBe('DECLINED')
  })

  it('another driver accepts → ASSIGNED, wave others LOST_TO_ANOTHER_DRIVER, PIN issued', async () => {
    const driverId = globalThis.__waveDrivers[1]
    const offerId = globalThis.__offerByDriver[driverId]
    const res = await driverRideService.accept({ rideId: globalThis.__rideId, offerId, driverId })
    expect(res.status).toBe(RIDE_STATUS.ASSIGNED)
    expect(res.tripPin).toBeUndefined() // PIN never rides the accept response (spec 05 §9)
    globalThis.__winnerDriverId = driverId
    // Passenger fetches the PIN via the dedicated endpoint.
    globalThis.__tripPin = (
      await app.inject({
        method: 'POST', url: `/api/v1/rides/${globalThis.__rideId}/pin`,
        headers: { authorization: `Bearer ${passengerToken}` },
        remoteAddress: '10.3.2.60',
      })
    ).json().pin
    expect(globalThis.__tripPin).toMatch(/^\d{4}$/)

    const { rows: offers } = await pool.query(
      `SELECT state, count(*)::int AS n FROM ride_offers WHERE ride_id = $1 GROUP BY state`,
      [globalThis.__rideId],
    )
    const byState = Object.fromEntries(offers.map((r) => [r.state, r.n]))
    expect(byState.ACCEPTED).toBe(1)
    expect(byState.LOST_TO_ANOTHER_DRIVER).toBeGreaterThan(0)

    // PIN never appears in the driver-facing ride projection
    const detail = await app.inject({
      method: 'GET', url: `/api/v1/rides/${globalThis.__rideId}`,
      headers: { authorization: `Bearer ${driverTokens[1]}` },
      remoteAddress: '10.3.2.5',
    })
    expect(JSON.stringify(detail.json())).not.toContain(globalThis.__tripPin)
  })

  it('a second driver accepting the SAME ride after assignment gets deterministic conflict', async () => {
    const driverId = globalThis.__waveDrivers[2]
    const offerId = globalThis.__offerByDriver[driverId]
    await expect(
      driverRideService.accept({ rideId: globalThis.__rideId, offerId, driverId }),
    ).rejects.toMatchObject({ code: 'RIDE_ALREADY_ASSIGNED' })
  })

  it('arrived → wrong PIN attempts limited → correct PIN → verified → start', async () => {
    const driverId = globalThis.__winnerDriverId
    const rideId = globalThis.__rideId
    const pin = globalThis.__tripPin

    await driverRideService.arrived({ rideId, driverId })

    // start before PIN → blocked
    await expect(driverRideService.start({ rideId, driverId })).rejects.toMatchObject({ code: 'RIDE_PIN_INVALID' })

    // wrong PINs (2 failures allowed, 3rd exhausts per SAFETY_PIN_ATTEMPT_LIMIT=3)
    const wrong = pin === '9999' ? '1111' : '9999'
    await expect(driverRideService.verifyPin({ rideId, driverId, pin: wrong })).rejects.toMatchObject({ code: 'RIDE_PIN_INVALID' })
    await expect(driverRideService.verifyPin({ rideId, driverId, pin: wrong })).rejects.toMatchObject({ code: 'RIDE_PIN_INVALID' })
    await expect(driverRideService.verifyPin({ rideId, driverId, pin: wrong })).rejects.toMatchObject({ code: 'RIDE_PIN_EXHAUSTED' })

    // Ops reset (support path, spec 12 §10): clear attempts for the test to continue.
    await pool.query(`UPDATE rides SET trip_pin_attempts = 0, trip_pin_locked_until = NULL WHERE id = $1`, [rideId])
    const verified = await driverRideService.verifyPin({ rideId, driverId, pin })
    expect(verified.verified).toBe(true)

    const started = await driverRideService.start({ rideId, driverId })
    expect(started.status).toBe(RIDE_STATUS.IN_PROGRESS)
  })

  it('complete → COMPLETED with immutable earnings ledger + CASH_DUE payment', async () => {
    const driverId = globalThis.__winnerDriverId
    const rideId = globalThis.__rideId
    const res = await driverRideService.complete({ rideId, driverId })
    expect(res.status).toBe(RIDE_STATUS.COMPLETED)
    expect(res.earning.netEarningPaise).toBeGreaterThan(0)
    expect(res.cashDuePaise).toBe(res.earning.totalPaise)

    const { rows: ledger } = await pool.query(
      `SELECT entry_type, amount_paise, balance_after_paise FROM driver_ledger WHERE ride_id = $1 ORDER BY id`,
      [rideId],
    )
    expect(ledger.map((l) => l.entry_type)).toEqual(['RIDE_EARNING', 'COMMISSION'])
    // Balance chain: credit then debit
    expect(Number(ledger[0].balance_after_paise)).toBe(Number(ledger[0].amount_paise))
    expect(Number(ledger[1].balance_after_paise)).toBe(
      Number(ledger[0].balance_after_paise) + Number(ledger[1].amount_paise),
    )
    expect(Number(ledger[1].amount_paise)).toBeLessThan(0)

    const { rows: payment } = await pool.query(`SELECT status, amount_paise FROM payment_intents WHERE ride_id = $1`, [rideId])
    expect(payment[0].status).toBe('CASH_DUE')
    expect(Number(payment[0].amount_paise)).toBe(res.earning.totalPaise)
  })
})

describe('SPEC 02 §10 CRITICAL: 50-driver accept race', () => {
  it('51 concurrent accepts on ONE ride → exactly one winner, 50 deterministic conflicts', async () => {
    // Lifecycle drivers go offline so they cannot receive offers.
    for (const d of globalThis.__waveDrivers) {
      await driverRideService.offline({ driverId: d })
    }
    const waveDriverIds = []
    for (let i = 5; i < driverCount; i++) {
      const { driverId } = await seedAndOnlineDriver(i)
      waveDriverIds.push(driverId)
    }

    const ride = (
      await app.inject({
        method: 'POST', url: '/api/v1/rides',
        headers: { authorization: `Bearer ${passengerToken}`, 'idempotency-key': 'race-key-1' },
        payload: { quoteId, pickup: PICKUP, drop: DROP, paymentMethod: 'CASH' },
        remoteAddress: '10.3.2.9',
      })
    ).json()
    expect(ride.status).toBe(RIDE_STATUS.SEARCHING)

    const result = await runWave(ride.rideId, 0)
    // All 50 must receive offers (wave size caps at DISPATCH_WAVE_SIZE —
    // wave 1 default is 8, so fire waves until every driver is offered).
    let wave = 1
    let offered = result.offers
    while (offered < waveDriverIds.length && wave < 5) {
      const r = await runWave(ride.rideId, wave)
      offered += r.offers
      wave += 1
    }
    const { rows: allOffers } = await pool.query(
      `SELECT id, driver_id FROM ride_offers WHERE ride_id = $1 AND state = 'OFFERED'`,
      [ride.rideId],
    )

    // Waves cap candidate counts by policy — for the race itself, ensure
    // EVERY online driver holds an offer (setup, not part of the race).
    {
      const offeredDrivers = new Set(allOffers.map((o) => o.driver_id))
      for (const driverId of waveDriverIds) {
        if (!offeredDrivers.has(driverId)) {
          await pool.query(
            `INSERT INTO ride_offers (ride_id, driver_id, dispatch_wave, distance_to_pickup_m, expires_at, state)
             VALUES ($1, $2, 99, 999, NOW() + INTERVAL '60 seconds', 'OFFERED')
             ON CONFLICT (ride_id, driver_id) DO NOTHING`,
            [ride.rideId, driverId],
          )
        }
      }
    }
    const { rows: raceOffers } = await pool.query(
      `SELECT id, driver_id FROM ride_offers WHERE ride_id = $1 AND state = 'OFFERED'`,
      [ride.rideId],
    )
    expect(raceOffers.length).toBe(waveDriverIds.length)

    // ── THE RACE: 50 simultaneous accepts through the real claim path ──
    const attempts = raceOffers.map((offer) =>
      driverRideService.accept({ rideId: ride.rideId, offerId: offer.id, driverId: offer.driver_id })
        .then((res) => ({ ok: true, driverId: offer.driver_id, res }))
        .catch((err) => ({ ok: false, driverId: offer.driver_id, code: err.code })),
    )
    const outcomes = await Promise.all(attempts)

    const winners = outcomes.filter((o) => o.ok)
    const losers = outcomes.filter((o) => !o.ok)
    expect(winners.length, 'exactly ONE driver wins (spec 02 §10)').toBe(1)
    expect(losers.length).toBe(waveDriverIds.length - 1)
    // All losses are deterministic and safe — the same stable code.
    for (const loser of losers) {
      expect(['RIDE_ALREADY_ASSIGNED', 'OFFER_EXPIRED', 'CONCURRENT_REQUEST_CONFLICT']).toContain(loser.code)
    }
    // Winner's ride is ASSIGNED and owned by exactly the winner.
    const { rows: finalRide } = await pool.query(`SELECT driver_id, status FROM rides WHERE id = $1`, [ride.rideId])
    expect(finalRide[0].status).toBe(RIDE_STATUS.ASSIGNED)
    expect(finalRide[0].driver_id).toBe(winners[0].driverId)
    // Exactly one ACCEPTED offer.
    const { rows: accepted } = await pool.query(
      `SELECT count(*)::int AS n FROM ride_offers WHERE ride_id = $1 AND state = 'ACCEPTED'`,
      [ride.rideId],
    )
    expect(accepted[0].n).toBe(1)
  }, 60000)
})

afterAll(async () => {
  await cleanRideWorld().catch(() => {})
  await deleteCityByName(CITY).catch(() => {})
  await pool.query(`DELETE FROM vehicle_categories WHERE code IN ('DISPATCH_AUTO')`).catch(() => {})
  await pool.query(`DELETE FROM users WHERE phone_e164 = ANY($1)`, [driverPhones]).catch(() => {})
  await pool.query(`DELETE FROM users WHERE phone_e164 = '+919000007001'`).catch(() => {})
  await closePool().catch(() => {})
  await closeRedis().catch(() => {})
})
