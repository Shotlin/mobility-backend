/**
 * Integration: database invariant tests (spec 04 §15) — the database must
 * block catastrophic invalid states even if service code has a bug.
 * Requires docker compose up + migrations applied.
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { pool, closePool } from '../../src/config/database.js'
import { closeRedis } from '../../src/config/redis.js'

const q = (text, params) => pool.query(text, params)

let cityId, categoryId, userId, driverId, quoteId, requestId

async function seedBase() {
  const city = await q(
    `INSERT INTO cities (name, state) VALUES ('Invariant City', 'TC') RETURNING id`,
  )
  cityId = city.rows[0].id
  const cat = await q(
    `INSERT INTO vehicle_categories (code, display_name, capacity) VALUES ('BIKE_INV', 'Bike', 1) RETURNING id`,
  )
  categoryId = cat.rows[0].id
  const users = await q(
    `INSERT INTO users (phone_e164, role, full_name) VALUES
       ('+919000000001', 'PASSENGER', 'Inv Passenger'),
       ('+919000000002', 'DRIVER', 'Inv Driver'),
       ('+919000000003', 'DRIVER', 'Inv Driver2')
     RETURNING id`,
  )
  userId = users.rows[0].id
  driverId = users.rows[1].id
  await q(`INSERT INTO driver_profiles (user_id, approval_state) VALUES ($1, 'APPROVED'), ($2, 'APPROVED')`, [
    users.rows[1].id,
    users.rows[2].id,
  ])
  const quote = await q(
    `INSERT INTO ride_quotes (user_id, city_id, vehicle_category_id, pickup, drop, route_provider,
       route_distance_m, route_duration_s, base_fare_paise, distance_fare_paise, total_paise,
       pricing_version, expires_at)
     VALUES ($1, $2, $3, 'SRID=4326;POINT(88.3639 22.5726)', 'SRID=4326;POINT(88.42 22.60)', 'ola_maps',
       8000, 900, 3000, 5000, 8000, 'v1', NOW() + INTERVAL '2 minutes')
     RETURNING id`,
    [userId, cityId, categoryId],
  )
  quoteId = quote.rows[0].id
}

async function seedRide(overrides = {}) {
  const req = await q(
    `INSERT INTO ride_requests (user_id, quote_id, vehicle_category_id, payment_method, booking_snapshot)
     VALUES ($1, $2, $3, 'CASH', '{"seed": true}'::jsonb) RETURNING id`,
    [overrides.passengerId || userId, quoteId, categoryId],
  )
  requestId = req.rows[0].id
  const ride = await q(
    `INSERT INTO rides (request_id, passenger_id, vehicle_category_id, city_id, quote_id,
       status, payment_method, pickup, drop, route_distance_m, route_duration_s)
     VALUES ($1, $2, $3, $4, $5, $6, 'CASH',
       'SRID=4326;POINT(88.3639 22.5726)', 'SRID=4326;POINT(88.42 22.60)', 8000, 900)
     RETURNING id`,
    [
      requestId,
      overrides.passengerId || userId,
      categoryId,
      cityId,
      quoteId,
      overrides.status || 'SEARCHING',
    ],
  )
  return ride.rows[0].id
}

async function cleanup() {
  // Ride-referencing children first (no cascade on these FKs), then parents.
  await q(`DELETE FROM guardian_sessions`)
  await q(`DELETE FROM safety_incidents`)
  await q(`DELETE FROM ratings`)
  await q(`DELETE FROM driver_earnings`)
  await q(`DELETE FROM payment_intents`)
  await q(`DELETE FROM rides`) // ride_events/stops/samples cascade
  await q(`DELETE FROM ride_requests`)
  await q(`DELETE FROM ride_quotes`)
  await q(`DELETE FROM idempotency_keys`)
  await q(`DELETE FROM driver_profiles WHERE user_id IN (SELECT id FROM users WHERE phone_e164 LIKE '+919000000%')`)
  await q(`DELETE FROM users WHERE phone_e164 LIKE '+919000000%'`)
  await q(`DELETE FROM vehicle_categories WHERE code = 'BIKE_INV'`)
  await q(`DELETE FROM cities WHERE name = 'Invariant City'`)
}

beforeAll(async () => {
  await cleanup()
  await seedBase()
})

describe('database invariants (spec 04 §15)', () => {
  it('rejects negative money in quotes (spec 04 §3)', async () => {
    await expect(
      q(
        `INSERT INTO ride_quotes (user_id, city_id, vehicle_category_id, pickup, drop, route_provider,
           route_distance_m, route_duration_s, base_fare_paise, distance_fare_paise, total_paise,
           pricing_version, expires_at)
         VALUES ($1, $2, $3, 'SRID=4326;POINT(88 22)', 'SRID=4326;POINT(88 23)', 'ola_maps',
           1000, 100, -5, 0, 0, 'v1', NOW() + INTERVAL '1 minute')`,
        [userId, cityId, categoryId],
      ),
    ).rejects.toThrow(/check|positive/i)
  })

  it('money columns are BIGINT paise — non-integers never persist as floats', async () => {
    // Postgres rounds a numeric literal into BIGINT (10.5 → 11): floats can
    // never be STORED, but service-layer zod validation must reject them
    // before they are silently rounded. Documented behavior test:
    const { rows } = await q(
      `INSERT INTO ride_quotes (user_id, city_id, vehicle_category_id, pickup, drop, route_provider,
         route_distance_m, route_duration_s, base_fare_paise, distance_fare_paise, total_paise,
         pricing_version, expires_at)
       VALUES ($1, $2, $3, 'SRID=4326;POINT(88 22)', 'SRID=4326;POINT(88 23)', 'ola_maps',
         1000, 100, 10.5, 0, 0, 'v1', NOW() + INTERVAL '1 minute')
       RETURNING base_fare_paise`,
      [userId, cityId, categoryId],
    )
    expect(Number(rows[0].base_fare_paise)).toBe(11)
    expect(Number.isInteger(Number(rows[0].base_fare_paise))).toBe(true)
    // Garbage strings are rejected outright.
    await expect(
      q(
        `UPDATE ride_quotes SET base_fare_paise = 'not-a-number' WHERE user_id = $1`,
        [userId],
      ),
    ).rejects.toThrow(/invalid input/i)
  })

  it('a driver cannot own two active rides (partial unique index)', async () => {
    const ride1 = await seedRide({ status: 'SEARCHING' })
    await q(`UPDATE rides SET driver_id = $1, status = 'ASSIGNED' WHERE id = $2`, [driverId, ride1])

    const ride2 = await seedRide({ status: 'SEARCHING' })
    await expect(
      q(`UPDATE rides SET driver_id = $1, status = 'ASSIGNED' WHERE id = $2`, [driverId, ride2]),
    ).rejects.toThrow(/rides_driver_active_uidx/)

    // After completing the first ride, the same driver CAN be assigned ride2.
    await q(`UPDATE rides SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1`, [ride1])
    await q(`UPDATE rides SET driver_id = $1, status = 'ASSIGNED' WHERE id = $2`, [driverId, ride2])
    const { rows } = await q(`SELECT status FROM rides WHERE id = $1`, [ride2])
    expect(rows[0].status).toBe('ASSIGNED')
  })

  it('invalid status values are rejected by CHECK constraint', async () => {
    const ride = await seedRide()
    await expect(
      q(`UPDATE rides SET status = 'TELEPORTED' WHERE id = $1`, [ride]),
    ).rejects.toThrow(/rides_status_chk/)
  })

  it('ride_events enforce monotonic versions per ride (spec 04 §16)', async () => {
    const ride = await seedRide({ status: 'ASSIGNED' })
    await q(
      `INSERT INTO ride_events (ride_id, ride_version, event_type, payload) VALUES ($1, 1, 'RIDE_ASSIGNED', '{}'::jsonb)`,
      [ride],
    )
    await expect(
      q(
        `INSERT INTO ride_events (ride_id, ride_version, event_type, payload) VALUES ($1, 1, 'RIDE_STARTED', '{}'::jsonb)`,
        [ride],
      ),
    ).rejects.toThrow(/ride_events_ride_id_ride_version_key/)
  })

  it('booking idempotency: same (user, key) rejects a second request row', async () => {
    const key = 'inv-test-key-1'
    await q(
      `INSERT INTO ride_requests (user_id, quote_id, vehicle_category_id, payment_method, booking_snapshot, idempotency_key)
       VALUES ($1, $2, $3, 'CASH', '{}'::jsonb, $4)`,
      [userId, quoteId, categoryId, key],
    )
    await expect(
      q(
        `INSERT INTO ride_requests (user_id, quote_id, vehicle_category_id, payment_method, booking_snapshot, idempotency_key)
         VALUES ($1, $2, $3, 'CASH', '{}'::jsonb, $4)`,
        [userId, quoteId, categoryId, key],
      ),
    ).rejects.toThrow(/ride_requests_idem_uidx/)
  })

  it('one ACTIVE safety incident per ride — repeated SOS dedupes at DB level (spec 10 §6)', async () => {
    const ride = await seedRide({ status: 'IN_PROGRESS' })
    await q(
      `INSERT INTO safety_incidents (ride_id, reporter_id, reporter_role, source, severity, status)
       VALUES ($1, $2, 'PASSENGER', 'PASSENGER_SOS', 'CRITICAL', 'OPEN')`,
      [ride, userId],
    )
    await expect(
      q(
        `INSERT INTO safety_incidents (ride_id, reporter_id, reporter_role, source, severity, status)
         VALUES ($1, $2, 'PASSENGER', 'PASSENGER_SOS', 'CRITICAL', 'OPEN')`,
        [ride, userId],
      ),
    ).rejects.toThrow(/safety_incidents_active_ride_uidx/)
    // Resolving the first incident allows a new one later.
    await q(`UPDATE safety_incidents SET status = 'RESOLVED' WHERE ride_id = $1`, [ride])
    await q(
      `INSERT INTO safety_incidents (ride_id, reporter_id, reporter_role, source, severity, status)
       VALUES ($1, $2, 'PASSENGER', 'ROUTE_ANOMALY', 'MEDIUM', 'OPEN')`,
      [ride, userId],
    )
  })

  it('PostGIS geography columns accept points and reject garbage', async () => {
    const ride = await seedRide()
    await q(`UPDATE rides SET pickup = 'SRID=4326;POINT(88.5 22.7)' WHERE id = $1`, [ride])
    await expect(
      q(`UPDATE rides SET pickup = 'not a geometry' WHERE id = $1`, [ride]),
    ).rejects.toThrow()
  })

  it('conditional assignment race: only one of two concurrent claimers wins (spec 04 §14)', async () => {
    // Free drivers from earlier tests so this test is self-contained.
    await q(
      `UPDATE rides SET status = 'CANCELLED', cancelled_at = NOW()
        WHERE status NOT IN ('COMPLETED','CANCELLED','NO_DRIVER_FOUND')`,
    )
    const ride = await seedRide({ status: 'SEARCHING' })
    const driver2 = (await q(`SELECT id FROM users WHERE phone_e164 = '+919000000003'`)).rows[0].id

    const claim = (client, driver) =>
      client.query(
        `UPDATE rides SET driver_id = $1, status = 'ASSIGNED', assigned_at = NOW(), ride_version = ride_version + 1
          WHERE id = $2 AND status = 'SEARCHING' AND driver_id IS NULL RETURNING id`,
        [driver, ride],
      )

    const clientA = await pool.connect()
    const clientB = await pool.connect()
    try {
      await clientA.query('BEGIN')
      await clientB.query('BEGIN')
      const resA = await claim(clientA, driverId) // A takes the row lock
      // B blocks behind A's lock — do NOT await before A commits (deadlock).
      const resBPromise = claim(clientB, driver2)
      await clientA.query('COMMIT')
      const resB = await resBPromise // re-check after A's commit → zero rows
      expect(resA.rowCount).toBe(1)
      expect(resB.rowCount).toBe(0)
      const { rows } = await q(`SELECT driver_id FROM rides WHERE id = $1`, [ride])
      expect(rows[0].driver_id).toBe(driverId)
    } finally {
      clientA.release()
      clientB.release()
    }
  })
})

afterAll(async () => {
  await cleanup().catch(() => {})
  await closePool().catch(() => {})
  await closeRedis().catch(() => {})
})
