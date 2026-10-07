/**
 * Ride event publisher — turns outbox rows into versioned socket envelopes
 * (spec 04 §16, spec 09 §14) delivered to authorized rooms only:
 *   ride:{rideId}, user:{passengerId}, driver:{driverId}, ops:city:{cityId}
 *
 * Envelope: { v, eventId, eventType, rideId, rideVersion, occurredAt, data }
 * Clients resync via GET /rides/:id/events when they detect version gaps —
 * no websocket frame is guaranteed exactly-once.
 */

import { getSocketEmitter } from '../../plugins/socket-emitter.js'
import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'

const PASSENGER_EVENTS = new Set([
  'RIDE_CREATED',
  'RIDE_ASSIGNED',
  'RIDE_DRIVER_EN_ROUTE',
  'RIDE_DRIVER_ARRIVED',
  'RIDE_STARTED',
  'RIDE_COMPLETED',
  'RIDE_CANCELLED',
  'RIDE_NO_DRIVER_FOUND',
  'PAYMENT_UPDATED',
  'SAFETY_CHECK',
])

const DRIVER_EVENTS = new Set([
  'RIDE_ASSIGNED',
  'RIDE_CANCELLED',
  'RIDE_UPDATED',
  'RIDE_COMPLETED',
  'PAYMENT_UPDATED',
  'SAFETY_ALERT',
])

/** Wire event type → socket event name (spec 09 §10/§11 naming). */
function socketEventName(eventType) {
  return 'ride:event'
}

/**
 * @param {object} args {eventType, rideId, payload}
 * @returns {Promise<{delivered: number}>}
 */
export async function publishRideEventFromOutbox({ eventType, rideId, payload = {} }) {
  const { rows } = await query(
    `SELECT r.ride_version, r.passenger_id, r.driver_id, r.city_id
       FROM rides r WHERE r.id = $1`,
    [rideId],
  )
  const ride = rows[0]
  if (!ride) {
    logger.warn({ rideId, eventType }, 'Cannot publish ride event — ride missing')
    return { delivered: 0 }
  }

  const emitter = getSocketEmitter()
  const envelope = {
    v: 1,
    eventId: `${rideId}:${ride.ride_version}:${eventType}`,
    eventType,
    rideId,
    rideVersion: ride.ride_version,
    occurredAt: new Date().toISOString(),
    data: payload,
  }

  let delivered = 0
  const name = socketEventName(eventType)

  if (PASSENGER_EVENTS.has(eventType)) {
    emitter.to(`ride:${rideId}`).emit(name, envelope)
    emitter.to(`user:${ride.passenger_id}`).emit(name, envelope)
    delivered += 2
  }
  if (DRIVER_EVENTS.has(eventType) && ride.driver_id) {
    emitter.to(`driver:${ride.driver_id}`).emit(name, envelope)
    delivered += 1
  }
  // Ops dashboards: city-scoped snapshot stream (throttled upstream by the
  // dashboard's own join policy — spec 04 §18).
  if (ride.city_id && PASSENGER_EVENTS.has(eventType)) {
    emitter.to(`ops:city:${ride.city_id}`).emit(name, envelope)
    delivered += 1
  }

  return { delivered }
}
