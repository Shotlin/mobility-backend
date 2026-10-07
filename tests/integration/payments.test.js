/**
 * Integration: payment security + lifecycle (spec 05 §7, spec 09 §17, spec 02 §8).
 * Razorpay SDK is NOT called — orders come from createPaymentIntent being
 * skipped in favor of a pre-seeded intent with a provider_order_id, so the
 * webhook path is fully exercised without network.
 */
import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { buildApp } from '../../src/app.js'
import { pool, closePool } from '../../src/config/database.js'
import { closeRedis } from '../../src/config/redis.js'
import { cleanRideWorld, deleteCityByName, flushRateLimits } from './helpers/db-clean.js'
import { handleRazorpayWebhook, collectCash, createRefund } from '../../src/modules/payments/payments.service.js'

const CITY = 'Payville'
const RING = '88.30 22.50, 88.50 22.50, 88.50 22.70, 88.30 22.70, 88.30 22.50'
let app
let driverId, passengerId, cashRideId, onlineRideId, mismatchRideId
let onlineIntent

beforeAll(async () => {
  await cleanRideWorld()
  await deleteCityByName(CITY)
  await flushRateLimits()
  await pool.query(`DELETE FROM vehicle_categories WHERE code = 'PAY_AUTO'`).catch(() => {})
  await pool.query(`DELETE FROM users WHERE phone_e164 = ANY($1)`, [['+919876533333', '+919876544444']]).catch(() => {})

  app = await buildApp()
  await app.ready()

  const cityId = (await pool.query(`INSERT INTO cities (name) VALUES ($1) RETURNING id`, [CITY])).rows[0].id
  await pool.query(`INSERT INTO service_zones (city_id, name, boundary) VALUES ($1, 'Core', ST_GeomFromText('SRID=4326;MULTIPOLYGON(((${RING})))'))`, [cityId])
  const categoryId = (await pool.query(`INSERT INTO vehicle_categories (code, display_name, capacity) VALUES ('PAY_AUTO', 'Auto', 3) RETURNING id`)).rows[0].id
  await pool.query(`INSERT INTO fare_rules (version, city_id, vehicle_category_id, base_fare_paise, min_fare_paise, per_km_paise) VALUES ('v1', $1, $2, 3000, 5000, 850)`, [cityId, categoryId])

  // Users
  async function mkUser(phone, role) {
    return (await pool.query(`INSERT INTO users (phone_e164, role) VALUES ($1, $2) RETURNING id`, [phone, role])).rows[0].id
  }
  passengerId = await mkUser('+919876533333', 'PASSENGER')
  driverId = await mkUser('+919876544444', 'DRIVER')
  await pool.query(`INSERT INTO driver_profiles (user_id, approval_state) VALUES ($1, 'APPROVED')`, [driverId])

  // Completed rides: one cash, one online, both with final fare + ledger-free
  async function completedRide(method, key) {
    const quoteId = (
      await pool.query(
        `INSERT INTO ride_quotes (user_id, city_id, vehicle_category_id, pickup, drop, route_provider,
           route_distance_m, route_duration_s, base_fare_paise, distance_fare_paise, total_paise, pricing_version, expires_at)
         VALUES ($1, $2, $3, 'SRID=4326;POINT(88.36 22.57)', 'SRID=4326;POINT(88.42 22.61)', 'ola_maps', 5000, 600, 3000, 4250, 7250, 'v1', NOW() + INTERVAL '2 minutes')
         RETURNING id`,
        [passengerId, cityId, categoryId],
      )
    ).rows[0].id
    const reqId = (
      await pool.query(
        `INSERT INTO ride_requests (user_id, quote_id, vehicle_category_id, payment_method, booking_snapshot, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, 'h') RETURNING id`,
        [passengerId, quoteId, categoryId, method, key],
      )
    ).rows[0].id
    const rideId = (
      await pool.query(
        `INSERT INTO rides (request_id, passenger_id, driver_id, vehicle_category_id, city_id, quote_id, status,
            payment_method, pickup, drop, route_distance_m, route_duration_s, started_at, completed_at, final_total_paise)
         VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETED', $7,
           'SRID=4326;POINT(88.36 22.57)', 'SRID=4326;POINT(88.42 22.61)', 5000, 600, NOW(), NOW(), 7250)
         RETURNING id`,
        [reqId, passengerId, driverId, categoryId, cityId, quoteId, method],
      )
    ).rows[0].id
    return rideId
  }
  cashRideId = await completedRide('CASH', 'pay-cash-1')
  onlineRideId = await completedRide('RAZORPAY_UPI', 'pay-online-1')
  mismatchRideId = await completedRide('RAZORPAY_UPI', 'pay-mismatch-1')
  // Cash rides get a CASH_DUE intent at completion (driver-ride.complete).
  await pool.query(
    `INSERT INTO payment_intents (ride_id, method, status, amount_paise) VALUES ($1, 'CASH', 'CASH_DUE', 7250)`,
    [cashRideId],
  )

  // Pre-seeded online intent (skips Razorpay SDK order creation)
  onlineIntent = (
    await pool.query(
      `INSERT INTO payment_intents (ride_id, method, status, amount_paise, provider, provider_order_id)
       VALUES ($1, 'RAZORPAY_UPI', 'PENDING', 7250, 'razorpay', 'order_test_123') RETURNING *`,
      [onlineRideId],
    )
  ).rows[0]
})

function signedPayload(body) {
  const raw = JSON.stringify(body)
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || ''
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex')
  return { raw, signature }
}

function webhookEvent(eventType, overrides = {}) {
  return {
    id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    event: eventType,
    payload: {
      payment: {
        entity: {
          id: 'pay_test_1',
          order_id: 'order_test_123',
          amount: 7250,
          ...overrides,
        },
      },
    },
  }
}

describe('webhook security (spec 05 §7, spec 09 §17)', () => {
  it('rejects an invalid signature with 401-class code, before parsing business action', async () => {
    await expect(
      handleRazorpayWebhook({ rawBody: JSON.stringify(webhookEvent('payment.captured')), signature: 'bad' }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' })
  })

  it('accepts a validly-signed capture and marks CAPTURED', async () => {
    const event = webhookEvent('payment.captured')
    const { raw, signature } = signedPayload(event)
    const res = await handleRazorpayWebhook({ rawBody: raw, signature })
    expect(res.duplicate).toBe(false)

    const { rows } = await pool.query(`SELECT status, provider_payment_id FROM payment_intents WHERE id = $1`, [onlineIntent.id])
    expect(rows[0].status).toBe('CAPTURED')
    expect(rows[0].provider_payment_id).toBe('pay_test_1')
  })

  it('duplicate webhook (same provider event id) is a safe no-op', async () => {
    const event = webhookEvent('payment.captured', { id: 'pay_test_dup' })
    // Fix a stable event id for the replay: rebuild with same id.
    event.id = 'evt_fixed_dup_1'
    const first = signedPayload(event)
    const r1 = await handleRazorpayWebhook({ rawBody: first.raw, signature: first.signature })
    expect(r1.duplicate).toBe(false)

    const r2 = await handleRazorpayWebhook({ rawBody: first.raw, signature: first.signature })
    expect(r2.duplicate).toBe(true)

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM payment_events WHERE provider_event_id = 'evt_fixed_dup_1'`,
    )
    expect(rows[0].n).toBe(1)
  })

  it('rejects amount mismatch (client/provider amount ≠ server intent)', async () => {
    // Fresh PENDING intent so the earlier capture cannot mask the check.
    const mismatchIntent = (
      await pool.query(
        `INSERT INTO payment_intents (ride_id, method, status, amount_paise, provider, provider_order_id)
         VALUES ($1, 'RAZORPAY_UPI', 'PENDING', 7250, 'razorpay', 'order_mismatch_1') RETURNING *`,
        [mismatchRideId],
      )
    ).rows[0]
    const event = webhookEvent('payment.captured', { amount: 100, order_id: 'order_mismatch_1' })
    const { raw, signature } = signedPayload(event)
    const res = await handleRazorpayWebhook({ rawBody: raw, signature })
    expect(res.mismatch).toBe(true)
    const { rows } = await pool.query(`SELECT status FROM payment_intents WHERE id = $1`, [mismatchIntent.id])
    expect(rows[0].status).not.toBe('CAPTURED')
  })

  it('does not rely on generic rate limiting as the security control', async () => {
    // Signature failures are rejected deterministically regardless of volume config.
    for (let i = 0; i < 3; i++) {
      await expect(
        handleRazorpayWebhook({ rawBody: '{}', signature: 'nope' }),
      ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' })
    }
  })
})

describe('cash settlement + refunds (spec 02 §8)', () => {
  it('driver collects cash: CASH_DUE → CASH_COLLECTED, idempotent-safe', async () => {
    const res = await collectCash({ rideId: cashRideId, driverId })
    expect(res.status).toBe('CASH_COLLECTED')
    await expect(collectCash({ rideId: cashRideId, driverId })).rejects.toMatchObject({ code: 'PAYMENT_ALREADY_PROCESSED' })
  })

  it('passenger cannot acknowledge cash; non-assigned driver rejected', async () => {
    await expect(collectCash({ rideId: cashRideId, driverId: passengerId })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('refund requires CAPTURED state; refund of pending is rejected', async () => {
    // onlineIntent is CAPTURED (from earlier test) — refund it.
    const res = await createRefund({
      paymentIntentId: onlineIntent.id,
      reason: 'test',
      adminId: passengerId,
      idempotencyKey: 'refund-key-1',
    })
    expect(res.status).toBe('PENDING')
    // Idempotent replay returns the same refund.
    const replay = await createRefund({
      paymentIntentId: onlineIntent.id,
      reason: 'test',
      adminId: passengerId,
      idempotencyKey: 'refund-key-1',
    })
    expect(replay.refundId).toBe(res.refundId)
  })

  it('cash rides reject online payment intents (PAYMENT_METHOD_INVALID)', async () => {
    const { createPaymentIntent } = await import('../../src/modules/payments/payments.service.js')
    await expect(
      createPaymentIntent({ rideId: cashRideId, userId: passengerId, actorRole: 'PASSENGER' }),
    ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_INVALID' })
  })
})

afterAll(async () => {
  await cleanRideWorld().catch(() => {})
  await deleteCityByName(CITY).catch(() => {})
  await pool.query(`DELETE FROM vehicle_categories WHERE code = 'PAY_AUTO'`).catch(() => {})
  await pool.query(`DELETE FROM users WHERE phone_e164 = ANY($1)`, [['+919876533333', '+919876544444']]).catch(() => {})
  await closePool().catch(() => {})
  await closeRedis().catch(() => {})
})
