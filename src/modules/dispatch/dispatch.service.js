/**
 * Dispatch engine (spec 04 §12-§15, spec 06 §5).
 *
 * Stage 1 (cheap): Redis GEOSEARCH by city/category/radius.
 * Stage 2: eligibility filter against DB (approved, docs valid, not
 *          dispatch-blocked, no active ride) + freshness of GPS.
 * Ranking: straight-line distance for PRUNING only — never fare.
 * Waves: closest small set → wider → wider; TTL per offer; stop after
 *        max search time; NO_DRIVER_FOUND terminal.
 * Claim: Redis SET NX reduces stampede; PostgreSQL conditional UPDATE is
 *        the final authority (spec 04 §14).
 */

import { env, dispatchWaves } from '../../config/env.js'
import { query } from '../../config/database.js'
import { withTransaction } from '../../utils/tx.js'
import { redisApi } from '../../config/redis.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'
import { RIDE_STATUS, OFFER_STATUS, DRIVER_OPERATIONAL_STATE } from '../../constants/states.js'
import { getSocketEmitter } from '../../plugins/socket-emitter.js'
import { notificationQueue, dispatchQueue } from '../../config/bullmq.js'
import {
  findNearbyDrivers,
  straightLineDistanceM,
  getPresence,
  setPresenceState,
} from '../location/location.service.js'

const CLAIM_KEY = (rideId) => `ride:claim:${rideId}`

/** Eligibility filter — one bounded query + presence freshness (spec 04 §12). */
async function filterEligible({ candidateIds, ride }) {
  if (candidateIds.length === 0) return []
  const cutoff = new Date(Date.now() - env.DISPATCH_CANDIDATE_STALE_GPS_S * 1000)
  const { rows } = await query(
    `SELECT dp.user_id AS driver_id,
            dp.approval_state, dp.dispatch_blocked_until, dp.operational_state,
            dp.last_location_at,
            dva.vehicle_id,
            u.is_blocked
       FROM driver_profiles dp
       JOIN users u ON u.id = dp.user_id
       LEFT JOIN driver_vehicle_assignments dva
         ON dva.driver_id = dp.user_id AND dva.is_active = true
      WHERE dp.user_id = ANY($1::uuid[])
        AND dp.approval_state = 'APPROVED'
        AND u.is_blocked = false
        AND dp.last_location_at > $2
        AND (dp.dispatch_blocked_until IS NULL OR dp.dispatch_blocked_until < NOW())
      LIMIT 100`,
    [candidateIds, cutoff],
  )
  // Cross-check Redis presence freshness (heartbeat recency beats DB cache).
  const eligible = []
  for (const row of rows) {
    const p = await getPresence(row.driver_id)
    if (!p || p.state !== DRIVER_OPERATIONAL_STATE.ONLINE_IDLE) continue
    if (p.rideId) continue
    if (row.vehicle_id == null) continue
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue
    eligible.push({
      driverId: row.driver_id,
      vehicleId: row.vehicle_id,
      lat: p.lat,
      lng: p.lng,
    })
  }
  void ride
  return eligible
}

/** Wave candidates: presence freshness + straight-line pruning, top N. */
async function candidatesForWave({ ride, wave }) {
  const pickupLat = Number(ride.pickup_lat)
  const pickupLng = Number(ride.pickup_lng)
  const geoIds = await findNearbyDrivers({
    cityId: ride.city_id,
    vehicleCategoryId: ride.vehicle_category_id,
    lat: pickupLat,
    lng: pickupLng,
    radiusM: wave.radiusM,
    limit: 60,
  })
  const eligible = await filterEligible({ candidateIds: geoIds, ride })
  const ranked = eligible
    .map((c) => ({
      ...c,
      distanceM: straightLineDistanceM(pickupLat, pickupLng, c.lat, c.lng),
    }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, wave.size)
  return ranked
}

/**
 * Run one dispatch wave for a SEARCHING ride: create OFFERED rows for the
 * wave's candidates and notify them. Returns number of offers made.
 */
export async function runWave(rideId, waveNumber) {
  const { rows } = await query(
    `SELECT r.*, ST_Y(r.pickup::geometry) AS pickup_lat, ST_X(r.pickup::geometry) AS pickup_lng
       FROM rides r WHERE r.id = $1`,
    [rideId],
  )
  const ride = rows[0]
  if (!ride) throw new DomainError(ERROR_CODES.RIDE_NOT_FOUND)
  if (ride.status !== RIDE_STATUS.SEARCHING) return { offers: 0, done: true }

  const waves = dispatchWaves()
  const wave = waves[Math.min(waveNumber, waves.length - 1)]
  const candidates = await candidatesForWave({ ride, wave })
  if (candidates.length === 0) {
    return { offers: 0, wave: waveNumber, done: false }
  }

  const expiresAt = new Date(Date.now() + env.DISPATCH_OFFER_TTL_S * 1000)
  const emitter = getSocketEmitter()
  let offered = 0

  await withTransaction(async (client) => {
    // Re-check ride still SEARCHING under lock (driver may have been assigned
    // between candidates query and now).
    const { rows: check } = await client.query(`SELECT status FROM rides WHERE id = $1 FOR UPDATE`, [rideId])
    if (check[0].status !== RIDE_STATUS.SEARCHING) return

    for (const candidate of candidates) {
      const { rows: offerRows } = await client.query(
        `INSERT INTO ride_offers (ride_id, driver_id, dispatch_wave, distance_to_pickup_m, offered_at, expires_at, state)
         VALUES ($1,$2,$3,$4, NOW(), $5, 'OFFERED')
         ON CONFLICT (ride_id, driver_id) DO NOTHING
         RETURNING id`,
        [rideId, candidate.driverId, waveNumber, candidate.distanceM, expiresAt],
      )
      if (offerRows.length === 0) continue
      offered += 1
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
         VALUES ('OFFER_CREATED', 'RIDE_OFFER', $1, $2)`,
        [offerRows[0].id, JSON.stringify({ rideId, driverId: candidate.driverId, offerId: offerRows[0].id, expiresAt: expiresAt.toISOString() })],
      )
    }
    if (offered > 0) {
      await client.query(
        `UPDATE rides SET search_wave_count = GREATEST(search_wave_count, $2) WHERE id = $1`,
        [rideId, waveNumber + 1],
      )
    }
  })

  if (offered > 0) {
    // Immediate socket push (offer is time-critical); FCM wake-up via queue.
    for (const candidate of candidates.slice(0, offered)) {
      emitter.to(`driver:${candidate.driverId}`).emit('ride:offer', {
        rideId,
        dispatchWave: waveNumber,
        pickup: { lat: Number(ride.pickup_lat), lng: Number(ride.pickup_lng) },
        distanceToPickupM: candidate.distanceM,
        expiresAt: expiresAt.toISOString(),
      })
    }
    await notificationQueue.add('PUSH_DRIVER_NEW_OFFER', {
      driverIds: candidates.slice(0, offered).map((c) => c.driverId),
      type: 'RIDE_OFFER',
      rideId,
    })
    // Expiry sweep for this wave.
    await dispatchQueue.add(
      'EXPIRE_OFFERS',
      { rideId, waveNumber },
      { delay: env.DISPATCH_OFFER_TTL_S * 1000 + 500 },
    )
  }

  return { offers: offered, wave: waveNumber, done: false }
}

/**
 * Offer expiry sweep (delayed job handler): expire stale OFFERED rows;
 * if the ride is still SEARCHING, fire the next wave or end with
 * NO_DRIVER_FOUND.
 */
export async function processOfferExpiry({ rideId, waveNumber }) {
  const { rows } = await query(`SELECT status FROM rides WHERE id = $1`, [rideId])
  if (!rows[0] || rows[0].status !== RIDE_STATUS.SEARCHING) return { expired: 0, done: true }

  await withTransaction(async (client) => {
    const { rows: expired } = await client.query(
      `UPDATE ride_offers SET state = 'EXPIRED', responded_at = NOW()
        WHERE ride_id = $1 AND state = 'OFFERED' AND expires_at <= NOW()
        RETURNING driver_id`,
      [rideId],
    )
    // Return RIDE_OFFERED presence state to ONLINE_IDLE for expired drivers.
    for (const row of expired.rows) {
      const p = await getPresence(row.driver_id)
      if (p && p.state === DRIVER_OPERATIONAL_STATE.RIDE_OFFERED) {
        await setPresenceState(row.driver_id, DRIVER_OPERATIONAL_STATE.ONLINE_IDLE)
      }
    }
  })

  const waves = dispatchWaves()
  const nextWave = waveNumber + 1
  if (nextWave < waves.length) {
    return runWave(rideId, nextWave)
  }

  // All waves exhausted → NO_DRIVER_FOUND (spec 04 §13).
  const { rows: stillSearching } = await query(
    `SELECT id FROM rides WHERE id = $1 AND status = 'SEARCHING' FOR UPDATE`,
    [rideId],
  ).catch(() => ({ rows: [] }))
  if (stillSearching.length === 0) return { expired: 0, done: true }

  await withTransaction(async (client) => {
    const { rows: check } = await client.query(`SELECT status FROM rides WHERE id = $1 FOR UPDATE`, [rideId])
    if (check[0].status !== RIDE_STATUS.SEARCHING) return
    await client.query(
      `UPDATE rides SET status = 'NO_DRIVER_FOUND', no_driver_reason = 'WAVES_EXHAUSTED',
          ride_version = ride_version + 1 WHERE id = $1`,
      [rideId],
    )
    await client.query(
      `INSERT INTO ride_events (ride_id, ride_version, event_type, payload)
       SELECT $1, ride_version, 'RIDE_NO_DRIVER_FOUND', '{"reason":"WAVES_EXHAUSTED"}'::jsonb FROM rides WHERE id = $1`,
      [rideId],
    )
    await client.query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
       VALUES ('RIDE_NO_DRIVER_FOUND', 'RIDE', $1, $2::jsonb)`,
      [rideId, JSON.stringify({ rideId, status: 'NO_DRIVER_FOUND' })],
    )
  })
  return { expired: 0, done: true, noDriverFound: true }
}

/**
 * ATOMIC CLAIM (spec 04 §14) — the single most contended write path.
 * Fast path: Redis SET NX claim to cut the stampede to ~one DB txn.
 * Authority: conditional UPDATE … WHERE status='SEARCHING' AND driver_id IS NULL.
 * Exactly one driver wins; everyone else gets a deterministic, safe answer.
 */
export async function acceptOffer({ rideId, offerId, driverId }) {
  // 1. Offer ownership + TTL (cheap pre-checks outside the txn).
  const { rows: offerRows } = await query(
    `SELECT id, state, expires_at, driver_id FROM ride_offers WHERE id = $1 AND ride_id = $2`,
    [offerId, rideId],
  )
  const offer = offerRows[0]
  if (!offer) throw new DomainError(ERROR_CODES.OFFER_INVALID)
  if (offer.driver_id !== driverId) throw new DomainError(ERROR_CODES.OFFER_NOT_OWNER)
  if (offer.state === OFFER_STATUS.ACCEPTED) {
    // Idempotent replay of a successful accept.
    const { rows: mine } = await query(`SELECT id, status FROM rides WHERE id = $1`, [rideId])
    if (mine[0]?.driver_id === driverId) {
      return { rideId, status: mine[0].status, alreadyWon: true }
    }
  }
  if (offer.state === OFFER_STATUS.LOST_TO_ANOTHER_DRIVER) {
    throw new DomainError(ERROR_CODES.RIDE_ALREADY_ASSIGNED, 'This ride is no longer available')
  }
  if (offer.state !== OFFER_STATUS.OFFERED || new Date(offer.expires_at) <= new Date()) {
    throw new DomainError(ERROR_CODES.OFFER_EXPIRED)
  }

  // 2. Redis fast-path claim (best-effort; DB is authoritative).
  let claimed = false
  try {
    claimed = (await redisApi.set(CLAIM_KEY(rideId), driverId, 'NX', 'EX', env.DISPATCH_CLAIM_TTL_S)) === 'OK'
  } catch {
    claimed = true // Redis unavailable → proceed to DB authority
  }
  if (!claimed) {
    throw new DomainError(ERROR_CODES.RIDE_ALREADY_ASSIGNED, 'Another driver already accepted this ride')
  }

  try {
    return await withTransaction(async (client) => {
      // THE authoritative conditional update (spec 04 §14).
      const { rows: claimedRide } = await client.query(
        `UPDATE rides
            SET driver_id = $2, vehicle_id = (SELECT vehicle_id FROM driver_vehicle_assignments WHERE driver_id = $2 AND is_active = true),
                status = 'ASSIGNED', assigned_at = NOW(), assigned_wave = (SELECT dispatch_wave FROM ride_offers WHERE id = $3),
                ride_version = ride_version + 1
          WHERE id = $1 AND status = 'SEARCHING' AND driver_id IS NULL
          RETURNING id, ride_version, passenger_id`,
        [rideId, driverId, offerId],
      )
      if (claimedRide.length === 0) {
        throw new DomainError(ERROR_CODES.RIDE_ALREADY_ASSIGNED, 'This ride is no longer available')
      }
      const ride = claimedRide[0]

      const now = new Date()
      await client.query(
        `UPDATE ride_offers SET state = 'ACCEPTED', responded_at = $2 WHERE id = $1`,
        [offerId, now],
      )
      await client.query(
        `UPDATE ride_offers SET state = 'LOST_TO_ANOTHER_DRIVER', responded_at = $2
          WHERE ride_id = $1 AND state = 'OFFERED' AND id != $3`,
        [rideId, now, offerId],
      )

      // PIN is generated lazily by POST /rides/:id/pin (PASSENGER-only
      // route, spec 05 §9) — never at assignment, never to the driver.
      await setPresenceState(driverId, DRIVER_OPERATIONAL_STATE.TO_PICKUP, { rideId })

      await client.query(
        `INSERT INTO ride_events (ride_id, ride_version, event_type, payload, actor_id, actor_role)
         VALUES ($1, $2, 'RIDE_ASSIGNED', $3, $4, 'DRIVER')`,
        [rideId, ride.ride_version, JSON.stringify({ driverId }), driverId],
      )
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
         VALUES ('RIDE_ASSIGNED', 'RIDE', $1, $2)`,
        [rideId, JSON.stringify({ rideId, driverId, passengerId: ride.passenger_id, rideVersion: ride.ride_version })],
      )

      return { rideId, status: RIDE_STATUS.ASSIGNED, rideVersion: ride.ride_version }
    })
  } catch (err) {
    if (err.code !== 'RIDE_ALREADY_ASSIGNED') {
      // Release the fast-path claim so a retry isn't blocked by stale NX.
      await redisApi.del(CLAIM_KEY(rideId)).catch(() => {})
    }
    throw err
  }
}

export async function declineOffer({ rideId, offerId, driverId }) {
  const { rowCount } = await query(
    `UPDATE ride_offers SET state = 'DECLINED', responded_at = NOW()
      WHERE id = $1 AND ride_id = $2 AND driver_id = $3 AND state = 'OFFERED'`,
    [offerId, rideId, driverId],
  )
  if (rowCount > 0) {
    const p = await getPresence(driverId)
    if (p && p.state === DRIVER_OPERATIONAL_STATE.RIDE_OFFERED) {
      await setPresenceState(driverId, DRIVER_OPERATIONAL_STATE.ONLINE_IDLE)
    }
    // Brief dispatch cooldown (spec 04 §9 optional cooldowns).
    await redisApi
      .set(`dispatch:cooldown:${driverId}`, '1', 'EX', 5)
      .catch(() => {})
  }
  return { declined: rowCount > 0 }
}

/** Mark offers as delivered presence (driver app saw the offer). */
export async function markDriverOffered(driverId) {
  const p = await getPresence(driverId)
  if (p && p.state === DRIVER_OPERATIONAL_STATE.ONLINE_IDLE) {
    await setPresenceState(driverId, DRIVER_OPERATIONAL_STATE.RIDE_OFFERED)
  }
}

