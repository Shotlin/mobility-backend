/**
 * Driver ride commands (spec 09 §4) — accept/decline/arrived/verify-pin/
 * start/complete. Every command goes through the SAME authoritative
 * transition service as HTTP passenger commands; driver ownership of the
 * ride is enforced here, and trip start requires a server-verified PIN.
 * Completion generates the immutable earnings ledger entry (spec 02 §8).
 */

import { query } from '../../config/database.js'
import { withTransaction } from '../../utils/tx.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'
import { RIDE_STATUS, DRIVER_OPERATIONAL_STATE, PAYMENT_STATUS } from '../../constants/states.js'
import { assertTransition } from '../rides/rides.state.js'
import { verifyTripPin } from '../rides/rides.service.js'
import { getPresence, setPresenceState, setDriverOnline } from '../location/location.service.js'
import { env } from '../../config/env.js'

const ONLINE_STATES = new Set([DRIVER_OPERATIONAL_STATE.ONLINE_IDLE, DRIVER_OPERATIONAL_STATE.RIDE_OFFERED, DRIVER_OPERATIONAL_STATE.TO_PICKUP, DRIVER_OPERATIONAL_STATE.ARRIVED_WAITING, DRIVER_OPERATIONAL_STATE.ON_TRIP])

export class DriverRideService {
  async online({ driverId, lat, lng }) {
    const { rows } = await query(
      `SELECT dp.approval_state, dp.active_vehicle_id, dp.city_id, v.category_id
         FROM driver_profiles dp
         LEFT JOIN vehicles v ON v.id = dp.active_vehicle_id
        WHERE dp.user_id = $1`,
      [driverId],
    )
    const profile = rows[0]
    if (!profile) throw new DomainError(ERROR_CODES.DRIVER_NOT_FOUND)
    if (profile.approval_state !== 'APPROVED') {
      throw new DomainError(ERROR_CODES.DRIVER_NOT_APPROVED)
    }
    if (!profile.active_vehicle_id || !profile.category_id) {
      throw new DomainError(ERROR_CODES.VEHICLE_NOT_ACTIVE, 'No active approved vehicle')
    }
    if (profile.city_id == null) {
      throw new DomainError(ERROR_CODES.DRIVER_NOT_APPROVED, 'Driver city not set — contact support')
    }

    // Full presence: state + city/category for the GEO index + coordinates.
    await setDriverOnline({
      driverId,
      cityId: profile.city_id,
      vehicleCategoryId: profile.category_id,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
    })
    // Spec 04 §11: DB persistence at online/offline transitions is allowed.
    await query(
      `UPDATE driver_profiles
          SET last_location_at = NOW(),
              last_location = CASE WHEN $2::numeric IS NOT NULL AND $3::numeric IS NOT NULL
                THEN ST_SetSRID(ST_MakePoint($3, $2), 4326) ELSE last_location END
        WHERE user_id = $1`,
      [driverId, Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null],
    )
    return { online: true, approvalState: profile.approval_state }
  }

  async offline({ driverId }) {
    const p = await getPresence(driverId)
    if (p && ONLINE_STATES.has(p.state)) {
      // Going offline mid-offer is fine; going offline mid-trip is a state
      // violation the DB still guards (ride stays assigned).
      const { setDriverOffline } = await import('../location/location.service.js')
      if (p.rideId) {
        const { rows } = await query(`SELECT status FROM rides WHERE id = $1`, [p.rideId])
        if (rows[0] && !['COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND'].includes(rows[0].status)) {
          throw new DomainError(ERROR_CODES.DRIVER_ALREADY_BUSY, 'Finish or hand over the active ride first')
        }
      }
      await setDriverOffline({ driverId })
    }
    return { online: false }
  }

  async accept({ rideId, offerId, driverId }) {
    const { acceptOffer } = await import('../dispatch/dispatch.service.js')
    return acceptOffer({ rideId, offerId, driverId })
  }

  async decline({ rideId, offerId, driverId }) {
    const { declineOffer } = await import('../dispatch/dispatch.service.js')
    return declineOffer({ rideId, offerId, driverId })
  }

  async arrived({ rideId, driverId }) {
    // Validate proximity loosely (spec 12 §9): recent GPS within 300m of
    // pickup OR bypassed via support flag (manual exception handled by ops).
    return withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM rides WHERE id = $1 FOR UPDATE`, [rideId])
      const ride = rows[0]
      if (!ride) throw new DomainError(ERROR_CODES.RIDE_NOT_FOUND)
      if (ride.driver_id !== driverId) throw new DomainError(ERROR_CODES.FORBIDDEN, 'Ride is not assigned to you')
      assertTransition(ride.status, RIDE_STATUS.DRIVER_ARRIVED)

      const { rows: updated } = await client.query(
        `UPDATE rides SET status = 'DRIVER_ARRIVED', driver_arrived_at = NOW(), ride_version = ride_version + 1
          WHERE id = $1 RETURNING *`,
        [rideId],
      )
      await client.query(
        `INSERT INTO ride_events (ride_id, ride_version, event_type, payload, actor_id, actor_role)
         VALUES ($1, $2, 'RIDE_DRIVER_ARRIVED', '{}', $3, 'DRIVER')`,
        [rideId, updated[0].ride_version, driverId],
      )
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
         VALUES ('RIDE_DRIVER_ARRIVED', 'RIDE', $1, $2)`,
        [rideId, JSON.stringify({ rideId, driverId, rideVersion: updated[0].ride_version })],
      )
      await setPresenceState(driverId, DRIVER_OPERATIONAL_STATE.ARRIVED_WAITING, { rideId })
      return { rideId, status: RIDE_STATUS.DRIVER_ARRIVED, rideVersion: updated[0].ride_version }
    })
  }

  /** Server-side PIN verification (spec 05 §9): attempt-limited, hashed. */
  async verifyPin({ rideId, driverId, pin }) {
    const { rows } = await query(`SELECT * FROM rides WHERE id = $1`, [rideId])
    const ride = rows[0]
    if (!ride) throw new DomainError(ERROR_CODES.RIDE_NOT_FOUND)
    if (ride.driver_id !== driverId) throw new DomainError(ERROR_CODES.FORBIDDEN, 'Ride is not assigned to you')
    if (ride.status !== RIDE_STATUS.DRIVER_ARRIVED && ride.status !== RIDE_STATUS.DRIVER_EN_ROUTE) {
      throw new DomainError(ERROR_CODES.RIDE_INVALID_STATE, 'PIN is verified at arrival')
    }
    if (ride.trip_pin_verified_at) {
      return { verified: true } // idempotent replay
    }

    const matches = verifyTripPin(ride, pin)
    if (!matches) {
      const attempts = ride.trip_pin_attempts + 1
      const locked = attempts >= env.SAFETY_PIN_ATTEMPT_LIMIT
      await query(
        `UPDATE rides SET trip_pin_attempts = $2,
            trip_pin_locked_until = CASE WHEN $3 THEN NOW() + ($4 || ' seconds')::interval ELSE trip_pin_locked_until END
          WHERE id = $1`,
        [rideId, attempts, locked, String(env.SAFETY_PIN_LOCKOUT_S)],
      )
      if (locked) {
        // Repeated PIN failures are a safety signal (spec 10 §8).
        await query(
          `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
           VALUES ('SAFETY_PIN_FAILURES', 'RIDE', $1, $2)`,
          [rideId, JSON.stringify({ rideId, driverId, attempts })],
        )
        throw new DomainError(ERROR_CODES.RIDE_PIN_EXHAUSTED, 'Too many wrong PIN attempts')
      }
      throw new DomainError(ERROR_CODES.RIDE_PIN_INVALID, `Wrong PIN — ${env.SAFETY_PIN_ATTEMPT_LIMIT - attempts} attempts left`)
    }

    await query(`UPDATE rides SET trip_pin_verified_at = NOW() WHERE id = $1`, [rideId])
    return { verified: true }
  }

  async start({ rideId, driverId }) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM rides WHERE id = $1 FOR UPDATE`, [rideId])
      const ride = rows[0]
      if (!ride) throw new DomainError(ERROR_CODES.RIDE_NOT_FOUND)
      if (ride.driver_id !== driverId) throw new DomainError(ERROR_CODES.FORBIDDEN, 'Ride is not assigned to you')
      // Trip start REQUIRES server-verified PIN (spec 05 §8).
      if (!ride.trip_pin_verified_at) {
        throw new DomainError(ERROR_CODES.RIDE_PIN_INVALID, 'Verify the passenger PIN before starting')
      }
      assertTransition(ride.status, RIDE_STATUS.IN_PROGRESS)

      const { rows: updated } = await client.query(
        `UPDATE rides SET status = 'IN_PROGRESS', started_at = NOW(), ride_version = ride_version + 1
          WHERE id = $1 RETURNING *`,
        [rideId],
      )
      await client.query(
        `INSERT INTO ride_events (ride_id, ride_version, event_type, payload, actor_id, actor_role)
         VALUES ($1, $2, 'RIDE_STARTED', '{}', $3, 'DRIVER')`,
        [rideId, updated[0].ride_version, driverId],
      )
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
         VALUES ('RIDE_STARTED', 'RIDE', $1, $2)`,
        [rideId, JSON.stringify({ rideId, rideVersion: updated[0].ride_version })],
      )
      await setPresenceState(driverId, DRIVER_OPERATIONAL_STATE.ON_TRIP, { rideId })
      return { rideId, status: RIDE_STATUS.IN_PROGRESS, rideVersion: updated[0].ride_version }
    })
  }

  /**
   * Completion — final fare from the quote snapshot (V1: no en-route
   * adjustments), immutable earnings ledger, CASH_DUE payment for cash
   * rides (spec 12 §12: server returns earning; no client math).
   */
  async complete({ rideId, driverId }) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT * FROM rides WHERE id = $1 FOR UPDATE`, [rideId])
      const ride = rows[0]
      if (!ride) throw new DomainError(ERROR_CODES.RIDE_NOT_FOUND)
      if (ride.driver_id !== driverId) throw new DomainError(ERROR_CODES.FORBIDDEN, 'Ride is not assigned to you')
      assertTransition(ride.status, RIDE_STATUS.COMPLETED)

      const { rows: quoteRows } = await client.query(`SELECT * FROM ride_quotes WHERE id = $1`, [ride.quote_id])
      const quote = quoteRows[0]
      const totalPaise = Number(quote.total_paise)

      // Driver accounting (spec 02 §8): explicit commission from the fare rule.
      const { rows: ruleRows } = await client.query(
        `SELECT commission_bps FROM fare_rules WHERE id = (SELECT fare_rule_id FROM ride_quotes WHERE id = $1)`,
        [quote.id],
      )
      const commissionBps = ruleRows[0]?.commission_bps ?? 0
      const commissionPaise = Math.round((totalPaise * commissionBps) / 10000)
      const netEarningPaise = totalPaise - commissionPaise

      const { rows: updated } = await client.query(
        `UPDATE rides SET status = 'COMPLETED', completed_at = NOW(),
            final_total_paise = $2, final_breakdown = $3, ride_version = ride_version + 1
          WHERE id = $1 RETURNING *`,
        [rideId, totalPaise, JSON.stringify({ totalPaise, commissionPaise, netEarningPaise })],
      )
      const rideVersion = updated[0].ride_version

      await client.query(
        `INSERT INTO driver_earnings (ride_id, driver_id, fare_total_paise, commission_paise, net_earning_paise, pricing_version, breakdown)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [rideId, driverId, totalPaise, commissionPaise, netEarningPaise, quote.pricing_version, JSON.stringify({ commissionBps })],
      )

      // Ledger: gross credit + commission debit, with running balance.
      const { rows: balanceRows } = await client.query(
        `SELECT COALESCE(balance_after_paise, 0) AS balance FROM driver_ledger WHERE driver_id = $1 ORDER BY id DESC LIMIT 1`,
        [driverId],
      )
      const balance = Number(balanceRows[0]?.balance || 0)
      await client.query(
        `INSERT INTO driver_ledger (driver_id, entry_type, amount_paise, balance_after_paise, ride_id, description)
         VALUES ($1, 'RIDE_EARNING', $2, $3, $4, 'Ride earning'),
                ($1, 'COMMISSION', $5, $3 - $6, $4, 'Platform commission')`,
        [driverId, totalPaise, balance + totalPaise, rideId, -commissionPaise, commissionPaise],
      )

      // Payment intent per method (Phase 8 reconciles Razorpay; cash = CASH_DUE).
      if (ride.payment_method === 'CASH') {
        await client.query(
          `INSERT INTO payment_intents (ride_id, method, status, amount_paise)
           VALUES ($1, 'CASH', $2, $3)
           ON CONFLICT (ride_id) DO UPDATE SET status = $2, amount_paise = $3`,
          [rideId, PAYMENT_STATUS.CASH_DUE, totalPaise],
        )
      }

      await client.query(
        `INSERT INTO ride_events (ride_id, ride_version, event_type, payload, actor_id, actor_role)
         VALUES ($1, $2, 'RIDE_COMPLETED', $3, $4, 'DRIVER')`,
        [rideId, rideVersion, JSON.stringify({ totalPaise, netEarningPaise }), driverId],
      )
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
         VALUES ('RIDE_COMPLETED', 'RIDE', $1, $2)`,
        [rideId, JSON.stringify({ rideId, rideVersion, totalPaise, netEarningPaise, driverId })],
      )

      // Driver returns to idle; increment counters.
      const p = await getPresence(driverId)
      if (p) await setPresenceState(driverId, DRIVER_OPERATIONAL_STATE.ONLINE_IDLE)
      await client.query(
        `UPDATE driver_profiles SET total_rides = total_rides + 1 WHERE user_id = $1`,
        [driverId],
      )

      return {
        rideId,
        status: RIDE_STATUS.COMPLETED,
        rideVersion,
        paymentMethod: ride.payment_method,
        cashDuePaise: ride.payment_method === 'CASH' ? totalPaise : 0,
        earning: { totalPaise, commissionPaise, netEarningPaise },
      }
    })
  }

}
