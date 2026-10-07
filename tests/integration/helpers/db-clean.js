/**
 * Shared integration-test cleanup — deletes the ride test world in
 * FK-safe order. Idempotent; tolerates missing rows/tables.
 */
import { pool } from '../../../src/config/database.js'

const STATEMENTS = [
  // Children first (no cascade on these FKs)
  `DELETE FROM guardian_sessions`,
  `DELETE FROM safety_incident_events`,
  `DELETE FROM safety_incidents`,
  `DELETE FROM ratings`,
  `DELETE FROM support_ticket_messages`,
  `DELETE FROM support_tickets`,
  `DELETE FROM driver_reverifications`,
  `DELETE FROM driver_ledger`,
  `DELETE FROM driver_earnings`,
  `DELETE FROM driver_payouts`,
  `DELETE FROM refunds`,
  `DELETE FROM payment_events`,
  `DELETE FROM payment_intents`,
  `DELETE FROM coupon_redemptions`,
  `DELETE FROM notification_logs`,
  `DELETE FROM ride_location_samples`,
  `DELETE FROM ride_events`,
  `DELETE FROM ride_stops`,
  `DELETE FROM outbox_events WHERE aggregate_type = 'RIDE'`,
  `DELETE FROM rides`,
  `DELETE FROM ride_requests`,
  `DELETE FROM ride_quotes`,
  `DELETE FROM driver_vehicle_assignments`,
  `DELETE FROM vehicles`,
  `DELETE FROM driver_documents`,
  `DELETE FROM driver_profiles`,
  `DELETE FROM idempotency_keys`,
]

/** Delete all ride-domain rows. Use in beforeAll/afterAll. */
export async function cleanRideWorld() {
  for (const sql of STATEMENTS) {
    await pool.query(sql).catch(() => {})
  }
}

/** Delete by test phone prefix — users + sessions + profiles. */
export async function deleteUsersByPhones(phones) {
  await pool
    .query(`DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE phone_e164 = ANY($1))`, [phones])
    .catch(() => {})
  await pool.query(`DELETE FROM users WHERE phone_e164 = ANY($1)`, [phones]).catch(() => {})
}

/** Delete config rows created by a test (pricing refs cleared first). */
export async function deleteCityByName(name) {
  await pool
    .query(
      `DELETE FROM fare_rules WHERE city_id IN (SELECT id FROM cities WHERE name = $1)`,
      [name],
    )
    .catch(() => {})
  await pool
    .query(
      `DELETE FROM surge_rules WHERE city_id IN (SELECT id FROM cities WHERE name = $1)`,
      [name],
    )
    .catch(() => {})
  await pool.query(`DELETE FROM cities WHERE name = $1`, [name]).catch(() => {})
}

import { redisRateLimit } from '../../../src/config/redis.js'

/** Clear rate-limit state (route-level + OTP phone budgets) for determinism. */
export async function flushRateLimits() {
  for (const pattern of ['raahi:ratelimit:*', 'rl:phone:*:otp:*', 'rl:ip:*']) {
    let cursor = '0'
    do {
      const [next, keys] = await redisRateLimit.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
      cursor = next
      if (keys.length > 0) await redisRateLimit.del(...keys)
    } while (cursor !== '0')
  }
}
