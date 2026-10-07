/**
 * Rides service — booking, authoritative transitions, cancellation.
 *
 * Every transition runs in ONE transaction (spec 03 §5):
 *   SELECT ride FOR UPDATE → assertTransition → UPDATE (version+1) →
 *   INSERT ride_events → INSERT outbox_events → COMMIT.
 * The outbox worker publishes socket/queue events at-least-once, so
 * consumers are idempotent and clients resync via GET /rides/current.
 */

import crypto from 'node:crypto'
import { query } from '../../config/database.js'
import { withTransaction } from '../../utils/tx.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'
import { RIDE_STATUS } from '../../constants/states.js'
import { assertTransition, isTerminal, evaluateCancellation } from './rides.state.js'
import { emitAuditInTx } from '../../utils/audit-log.js'
import { RideQuotesService } from '../ride-quotes/ride-quotes.service.js'

const rideQuotesService = new RideQuotesService()

/** Load the active fare-rule policy for cancellation fees. */
async function loadCancellationPolicy({ cityId, vehicleCategoryId, zoneId }) {
  const { rows } = await query(
    `SELECT cancellation_fee_paise, free_cancel_after_pickup_min, free_cancel_before_assign_s
       FROM fare_rules
      WHERE is_active = true
        AND NOW() >= effective_from AND (effective_to IS NULL OR NOW() < effective_to)
        AND city_id = $1 AND vehicle_category_id = $2
        AND (zone_id IS NULL OR zone_id = $3)
      ORDER BY (zone_id IS NOT NULL) DESC, effective_from DESC
      LIMIT 1`,
    [cityId, vehicleCategoryId, zoneId],
  )
  return rows[0] || null
}

/**
 * Generate the trip PIN pair (spec 05 §9): 4-digit, hash+salt stored,
 * plaintext returned ONLY to the passenger API response here (the driver
 * payload NEVER includes it).
 */
export function generateTripPin() {
  const salt = crypto.randomBytes(16).toString('hex')
  const pin = String(crypto.randomInt(1000, 10000))
  const hash = crypto.createHash('sha256').update(`${salt}:${pin}`).digest('hex')
  return { pin, salt, hash }
}

export function verifyTripPin(ride, pin) {
  if (!ride.trip_pin_hash || !ride.trip_pin_salt) {
    throw new DomainError(ERROR_CODES.RIDE_PIN_INVALID, 'No PIN pending for this ride')
  }
  if (ride.trip_pin_locked_until && new Date(ride.trip_pin_locked_until) > new Date()) {
    throw new DomainError(ERROR_CODES.RIDE_PIN_LOCKED, 'Too many PIN attempts — try again later')
  }
  const hash = crypto
    .createHash('sha256')
    .update(`${ride.trip_pin_salt}:${String(pin)}`)
    .digest('hex')
  return hash === ride.trip_pin_hash
}

export class RidesService {
  /**
   * Book a ride from an accepted quote (spec 13 §7).
   * Idempotency: (user, Idempotency-Key) unique on ride_requests — replays
   * return the ORIGINAL ride, same-key-different-body → 409 (spec 09 §6).
   */
  async createRide({ userId, body, idempotencyKey }) {
    if (!idempotencyKey) {
      throw new DomainError(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED, 'Idempotency-Key header is required for booking')
    }
    const quote = await rideQuotesService.getUsableQuote({ quoteId: body.quoteId, userId })

    // Replay with the same key returns the original ride (deterministic).
    const existing = await query(
      `SELECT r.id AS ride_id, rr.request_hash
         FROM ride_requests rr
         LEFT JOIN rides r ON r.request_id = rr.id
        WHERE rr.user_id = $1 AND rr.idempotency_key = $2
        LIMIT 1`,
      [userId, idempotencyKey],
    )
    if (existing.rows.length > 0) {
      const requestHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')
      if (existing.rows[0].request_hash !== requestHash) {
        throw new DomainError(ERROR_CODES.IDEMPOTENCY_KEY_REUSED, 'Idempotency key was used with a different payload')
      }
      const rideId = existing.rows[0].ride_id
      if (!rideId) {
        // Request cancelled before dispatch — treat as replay of a cancelled booking.
        throw new DomainError(ERROR_CODES.RIDE_ALREADY_CANCELLED, 'This booking was already cancelled before dispatch')
      }
      return this.getRideForActor({ rideId, userId, actorRole: 'PASSENGER' })
    }

    return withTransaction(async (client) => {
      // Re-check under lock to make concurrent double-clicks safe.
      const locked = await client.query(
        `SELECT id, request_hash FROM ride_requests
          WHERE user_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [userId, idempotencyKey],
      )
      if (locked.rows.length > 0) {
        throw new DomainError(ERROR_CODES.CONCURRENT_REQUEST_CONFLICT, 'Booking already in progress for this key')
      }

      const requestHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')
      const bookingSnapshot = {
        quoteId: quote.id,
        totalPaise: Number(quote.total_paise),
        pricingVersion: quote.pricing_version,
        pickup: { lat: body.pickup?.lat ?? null, lng: body.pickup?.lng ?? null },
        drop: { lat: body.drop?.lat ?? null, lng: body.drop?.lng ?? null },
        routeDistanceM: quote.route_distance_m,
        routeDurationS: quote.route_duration_s,
      }

      const { rows: reqRows } = await client.query(
        `INSERT INTO ride_requests (user_id, quote_id, vehicle_category_id, payment_method, booking_snapshot, idempotency_key, request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [userId, quote.id, quote.vehicle_category_id, body.paymentMethod, JSON.stringify(bookingSnapshot), idempotencyKey, requestHash],
      )
      const requestId = reqRows[0].id

      const { rows: rideRows } = await client.query(
        `INSERT INTO rides (request_id, passenger_id, vehicle_category_id, city_id, zone_id, quote_id,
            status, payment_method, pickup, drop, route_distance_m, route_duration_s, route_polyline_enc,
            search_started_at, ride_version)
         VALUES ($1,$2,$3,$4,$5,$6,'SEARCHING',$7,
            ST_SetSRID(ST_MakePoint($8,$9),4326), ST_SetSRID(ST_MakePoint($10,$11),4326),
            $12,$13,$14, NOW(), 1)
         RETURNING id`,
        [
          requestId, userId, quote.vehicle_category_id, quote.city_id, quote.zone_id, quote.id,
          body.paymentMethod,
          body.pickup?.lng ?? 0, body.pickup?.lat ?? 0,
          body.drop?.lng ?? 0, body.drop?.lat ?? 0,
          quote.route_distance_m, quote.route_duration_s, quote.route_polyline_enc,
        ],
      )
      const rideId = rideRows[0].id

      await client.query(
        `INSERT INTO ride_events (ride_id, ride_version, event_type, payload, actor_id, actor_role)
         VALUES ($1, 1, 'RIDE_CREATED', $2, $3, 'PASSENGER')`,
        [rideId, JSON.stringify({ quoteId: quote.id, totalPaise: Number(quote.total_paise) }), userId],
      )
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, correlation_id)
         VALUES ('RIDE_CREATED', 'RIDE', $1, $2, $3)`,
        [rideId, JSON.stringify({ rideId, status: RIDE_STATUS.SEARCHING }), idempotencyKey],
      )

      return this.getRideForActor({ rideId, userId, actorRole: 'PASSENGER', client })
    })
  }

  /**
   * Authoritative status projection for an actor (spec 13 §7: clients
   * reconcile with THIS on reconnect). Compact payload — no big histories.
   */
  async getRideForActor({ rideId, userId, actorRole, client = null }) {
    const runner = client ?? { query: (t, p) => query(t, p) }
    const { rows } = await runner.query(
      `SELECT r.id, r.status, r.ride_version, r.payment_method, r.created_at, r.assigned_at,
              r.driver_arrived_at, r.started_at, r.completed_at, r.cancelled_at,
              r.cancellation_fee_paise, r.final_total_paise,
              ST_Y(r.pickup::geometry) AS pickup_lat, ST_X(r.pickup::geometry) AS pickup_lng,
              ST_Y(r.drop::geometry) AS drop_lat, ST_X(r.drop::geometry) AS drop_lng,
              r.pickup_address, r.drop_address,
              vc.code AS category_code, vc.display_name AS category_name,
              u.full_name AS passenger_name,
              du.full_name AS driver_name, du.id AS driver_id,
              d.rating_sum, d.rating_count, v.model AS vehicle_model,
              v.registration_number, v.color AS vehicle_color
         FROM rides r
         JOIN vehicle_categories vc ON vc.id = r.vehicle_category_id
         JOIN users u ON u.id = r.passenger_id
         LEFT JOIN users du ON du.id = r.driver_id
         LEFT JOIN driver_profiles d ON d.user_id = r.driver_id
         LEFT JOIN vehicles v ON v.id = (SELECT active_vehicle_id FROM driver_profiles WHERE user_id = r.driver_id)
        WHERE r.id = $1`,
      [rideId],
    )
    if (rows.length === 0) throw new DomainError(ERROR_CODES.RIDE_NOT_FOUND)
    const r = rows[0]
    const isPassenger = r.passenger_name && actorRole === 'PASSENGER'
    // Ownership/scope check happens in routes via explicit columns; here we
    // shape the payload per actor (driver never sees the PIN).
    void isPassenger
    return {
      rideId: r.id,
      status: r.status,
      rideVersion: r.ride_version,
      paymentMethod: r.payment_method,
      pickup: { lat: Number(r.pickup_lat), lng: Number(r.pickup_lng), address: r.pickup_address },
      drop: { lat: Number(r.drop_lat), lng: Number(r.drop_lng), address: r.drop_address },
      vehicleCategory: { code: r.category_code, displayName: r.category_name },
      driver: r.driver_id
        ? {
            id: r.driver_id,
            name: r.driver_name,
            vehicleModel: r.vehicle_model,
            registrationNumber: r.registration_number,
            vehicleColor: r.vehicle_color,
            rating: r.rating_count > 0 ? Number((r.rating_sum / r.rating_count).toFixed(2)) : null,
          }
        : null,
      timestamps: {
        createdAt: r.created_at,
        assignedAt: r.assigned_at,
        driverArrivedAt: r.driver_arrived_at,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        cancelledAt: r.cancelled_at,
      },
      fare: {
        finalTotalPaise: r.final_total_paise != null ? Number(r.final_total_paise) : null,
        cancellationFeePaise: Number(r.cancellation_fee_paise || 0),
      },
    }
  }

  async getCurrentRide({ userId, actorRole }) {
    const column = actorRole === 'DRIVER' ? 'driver_id' : 'passenger_id'
    const { rows } = await query(
      `SELECT id FROM rides
        WHERE ${column} = $1
          AND status IN ('REQUESTED','SEARCHING','ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','IN_PROGRESS')
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId],
    )
    if (rows.length === 0) return null
    return this.getRideForActor({ rideId: rows[0].id, userId, actorRole })
  }

  async listHistory({ userId, actorRole, before, limit = 20 }) {
    const column = actorRole === 'DRIVER' ? 'driver_id' : 'passenger_id'
    const params = [userId]
    let where = `WHERE ${column} = $1 AND status IN ('COMPLETED','CANCELLED','NO_DRIVER_FOUND')`
    if (before) {
      params.push(new Date(before))
      where += ` AND created_at < $${params.length}`
    }
    params.push(Math.min(50, Math.max(1, limit)))
    const { rows } = await query(
      `SELECT r.id, r.status, r.created_at, r.completed_at, r.cancelled_at,
              r.final_total_paise, r.cancellation_fee_paise,
              ST_Y(r.pickup::geometry) AS pickup_lat, ST_X(r.pickup::geometry) AS pickup_lng,
              ST_Y(r.drop::geometry) AS drop_lat, ST_X(r.drop::geometry) AS drop_lng,
              vc.code AS category_code
         FROM rides r JOIN vehicle_categories vc ON vc.id = r.vehicle_category_id
         ${where}
        ORDER BY r.created_at DESC
        LIMIT $${params.length}`,
      params,
    )
    return {
      rides: rows.map((r) => ({
        rideId: r.id,
        status: r.status,
        createdAt: r.created_at,
        completedAt: r.completed_at,
        cancelledAt: r.cancelled_at,
        finalTotalPaise: r.final_total_paise != null ? Number(r.final_total_paise) : null,
        cancellationFeePaise: Number(r.cancellation_fee_paise || 0),
        pickup: { lat: Number(r.pickup_lat), lng: Number(r.pickup_lng) },
        drop: { lat: Number(r.drop_lat), lng: Number(r.drop_lng) },
        category: r.category_code,
      })),
      nextCursor: rows.length === Math.min(50, Math.max(1, limit)) ? rows[rows.length - 1].created_at : null,
    }
  }

  /**
   * Single-transition executor used by every command (cancel, arrived,
   * start, complete, no-driver-found…). See module docblock for the
   * transaction shape.
   */
  async transitionRide({ rideId, to, actorId, actorRole, extraSet = '', extraParams = [], eventType, payload = {} }) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM rides WHERE id = $1 FOR UPDATE`, [rideId])
      const ride = rows[0]
      if (!ride) throw new DomainError(ERROR_CODES.RIDE_NOT_FOUND)

      assertTransition(ride.status, to)

      const timestampColumn = {
        [RIDE_STATUS.ASSIGNED]: 'assigned_at',
        [RIDE_STATUS.DRIVER_EN_ROUTE]: 'driver_en_route_at',
        [RIDE_STATUS.DRIVER_ARRIVED]: 'driver_arrived_at',
        [RIDE_STATUS.IN_PROGRESS]: 'started_at',
        [RIDE_STATUS.COMPLETED]: 'completed_at',
        [RIDE_STATUS.CANCELLED]: 'cancelled_at',
      }[to]

      const setFragments = [
        'status = $2',
        'ride_version = ride_version + 1',
        timestampColumn ? `${timestampColumn} = NOW()` : null,
        extraSet || null,
      ].filter(Boolean)

      const params = [rideId, to, ...extraParams]
      const { rows: updated } = await client.query(
        `UPDATE rides SET ${setFragments.join(', ')} WHERE id = $1 RETURNING *`,
        params,
      )
      const next = updated[0]

      await client.query(
        `INSERT INTO ride_events (ride_id, ride_version, event_type, payload, actor_id, actor_role)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [rideId, next.ride_version, eventType, JSON.stringify(payload), actorId, actorRole],
      )
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, correlation_id)
         VALUES ($1, 'RIDE', $2, $3, $4)`,
        [eventType, rideId, JSON.stringify({ rideId, status: to, rideVersion: next.ride_version, ...payload }), String(rideId)],
      )
      return next
    })
  }

  async cancelRide({ rideId, userId, actorRole, reason, comment }) {
    const { rows } = await query(`SELECT * FROM rides WHERE id = $1`, [rideId])
    const ride = rows[0]
    if (!ride) throw new DomainError(ERROR_CODES.RIDE_NOT_FOUND)

    // Ownership/scope: passenger owns the ride, assigned driver owns it, admins need ride.cancel (checked in routes).
    if (actorRole === 'PASSENGER' && ride.passenger_id !== userId) {
      throw new DomainError(ERROR_CODES.FORBIDDEN, 'Not your ride')
    }
    if (actorRole === 'DRIVER' && ride.driver_id !== userId) {
      throw new DomainError(ERROR_CODES.FORBIDDEN, 'Not your ride')
    }

    const policy = await loadCancellationPolicy({
      cityId: ride.city_id,
      zoneId: ride.zone_id,
      vehicleCategoryId: ride.vehicle_category_id,
    })
    const evaluation = evaluateCancellation({
      status: ride.status,
      actorRole,
      policy: policy
        ? {
            cancellationFeePaise: Number(policy.cancellation_fee_paise || 0),
            freeCancelBeforeAssignS: policy.free_cancel_before_assign_s,
            freeCancelAfterPickupMin: policy.free_cancel_after_pickup_min,
          }
        : null,
      assignedAt: ride.assigned_at,
      arrivedAt: ride.driver_arrived_at,
    })
    if (!evaluation.allowed) {
      throw new DomainError(
        evaluation.reasonCode === 'RIDE_NOT_CANCELLABLE' ? ERROR_CODES.RIDE_NOT_CANCELLABLE : ERROR_CODES.RIDE_INVALID_STATE,
        'This ride can no longer be cancelled',
      )
    }
    if (isTerminal(ride.status)) {
      throw new DomainError(ERROR_CODES.RIDE_ALREADY_CANCELLED, 'Ride already reached a terminal state')
    }

    return this.transitionRide({
      rideId,
      to: RIDE_STATUS.CANCELLED,
      actorId: userId,
      actorRole,
      extraSet: 'cancelled_by = $3, cancelled_by_role = $4, cancellation_reason = $5, cancellation_comment = $6, cancellation_fee_paise = $7',
      extraParams: [userId, actorRole, reason || 'USER_CANCELLED', comment || null, evaluation.feePaise],
      eventType: 'RIDE_CANCELLED',
      payload: { reason, byRole: actorRole, feePaise: evaluation.feePaise },
    })
  }

  /** Explicit admin cancellation — separate path for audit clarity. */
  async adminCancelRide({ rideId, adminId, reason }) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM rides WHERE id = $1 FOR UPDATE`, [rideId])
      const ride = rows[0]
      if (!ride) throw new DomainError(ERROR_CODES.RIDE_NOT_FOUND)
      if (isTerminal(ride.status)) {
        throw new DomainError(ERROR_CODES.RIDE_ALREADY_CANCELLED, 'Ride already terminal')
      }
      assertTransition(ride.status, RIDE_STATUS.CANCELLED)
      const { rows: updated } = await client.query(
        `UPDATE rides SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = $2,
            cancelled_by_role = 'ADMIN', cancellation_reason = 'ADMIN_CANCELLED',
            cancellation_comment = $3, ride_version = ride_version + 1
          WHERE id = $1 RETURNING *`,
        [rideId, adminId, reason || null],
      )
      await emitAuditInTx(client, {
        actorId: adminId,
        actorType: 'ADMIN',
        action: 'RIDE_CANCELLED_ADMIN',
        targetType: 'RIDE',
        targetId: rideId,
        before: { status: ride.status },
        after: { status: 'CANCELLED', reason },
      })
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
         VALUES ('RIDE_CANCELLED', 'RIDE', $1, $2)`,
        [rideId, JSON.stringify({ rideId, status: 'CANCELLED', byRole: 'ADMIN' })],
      )
      return updated[0]
    })
  }

  /** Trip PIN issue — passenger-only plaintext (spec 05 §9). */
  async issueTripPin({ rideId, userId }) {
    const { rows } = await query(`SELECT * FROM rides WHERE id = $1`, [rideId])
    const ride = rows[0]
    if (!ride) throw new DomainError(ERROR_CODES.RIDE_NOT_FOUND)
    if (ride.passenger_id !== userId) throw new DomainError(ERROR_CODES.FORBIDDEN, 'Not your ride')
    if (ride.status !== RIDE_STATUS.ASSIGNED && ride.status !== RIDE_STATUS.DRIVER_EN_ROUTE) {
      throw new DomainError(ERROR_CODES.RIDE_INVALID_STATE, 'PIN is available once a driver is assigned')
    }
    if (ride.trip_pin_hash) {
      // PIN already issued for this ride — do not re-issue (single PIN per ride).
      throw new DomainError(ERROR_CODES.RIDE_PIN_INVALID, 'PIN already issued — see your ride screen')
    }
    const { pin, salt, hash } = generateTripPin()
    await query(
      `UPDATE rides SET trip_pin_hash = $2, trip_pin_salt = $3 WHERE id = $1`,
      [rideId, hash, salt],
    )
    return { pin }
  }
}
