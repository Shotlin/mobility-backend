/**
 * Location ingest policy (spec 04 §10-§11, spec 06 §5).
 *
 * The hot path is: validate → throttle check (Redis) → Redis presence/GEO
 * → ride-room broadcast → breadcrumb buffer for ASYNC batch persistence.
 * PostgreSQL is NEVER written synchronously per location event.
 *
 * Throttle: state-aware minimum interval + movement threshold. Excess
 * events are DROPPED (coalesced to the newest), never queued.
 */

import { env } from '../../config/env.js'
import { redisGeo } from '../../config/redis.js'
import { getPresence, updateDriverLocation, setPresenceState } from './location.service.js'
import { DRIVER_OPERATIONAL_STATE } from '../../constants/states.js'
import { getSocketEmitter } from '../../plugins/socket-emitter.js'

const THROTTLE_KEY = (driverId) => `loc:throttle:${driverId}`
const BREADCRUMB_STREAM = 'loc:breadcrumbs'

const INTERVAL_BY_STATE = {
  [DRIVER_OPERATIONAL_STATE.ONLINE_IDLE]: env.LOCATION_MIN_INTERVAL_IDLE_MS,
  [DRIVER_OPERATIONAL_STATE.RIDE_OFFERED]: env.LOCATION_MIN_INTERVAL_IDLE_MS,
  [DRIVER_OPERATIONAL_STATE.TO_PICKUP]: env.LOCATION_MIN_INTERVAL_TO_PICKUP_MS,
  [DRIVER_OPERATIONAL_STATE.ARRIVED_WAITING]: env.LOCATION_MIN_INTERVAL_TO_PICKUP_MS,
  [DRIVER_OPERATIONAL_STATE.ON_TRIP]: env.LOCATION_MIN_INTERVAL_ON_TRIP_MS,
}

/** Approximate movement threshold (metres) that overrides the interval. */
function movedEnough(prevLat, prevLng, lat, lng) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat - prevLat)
  const dLng = toRad(lng - prevLng)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(prevLat)) * Math.cos(toRad(lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a)) >= env.LOCATION_MOVEMENT_THRESHOLD_M
}

export function minIntervalFor(state) {
  return INTERVAL_BY_STATE[state] ?? env.LOCATION_MIN_INTERVAL_IDLE_MS
}

/**
 * Ingest one driver location event. Returns:
 *   { accepted, reason, persisted } — persisted=false ALWAYS on this path
 *   (breadcrumbs flush to PostgreSQL only via the location queue).
 */
export async function ingestDriverLocation({ driverId, lat, lng, accuracyM, heading, speedMps, capturedAt }) {
  const presence = await getPresence(driverId)
  if (!presence) {
    return { accepted: false, reason: 'OFFLINE' }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { accepted: false, reason: 'INVALID_COORDS' }
  }

  // State-aware throttle (spec 06 §5): coalesce — drop stale bursts.
  const now = Date.now()
  const last = presence.updatedAt
  const interval = minIntervalFor(presence.state)
  const moved = movedEnough(presence.lat, presence.lng, lat, lng)
  if (!moved && now - last < interval) {
    return { accepted: false, reason: 'THROTTLED', intervalMs: interval }
  }

  await updateDriverLocation({ driverId, lat, lng, rideId: presence.rideId })

  // Active-trip broadcast to the authorized ride room only (spec 04 §18).
  if (presence.rideId && presence.state !== DRIVER_OPERATIONAL_STATE.ONLINE_IDLE) {
    const emitter = getSocketEmitter()
    emitter.to(`ride:${presence.rideId}`).emit('ride:driver_location', {
      v: 1,
      driverId,
      rideId: presence.rideId,
      lat,
      lng,
      ...(Number.isFinite(accuracyM) ? { accuracyM } : {}),
      ...(Number.isFinite(heading) ? { heading } : {}),
      ...(Number.isFinite(speedMps) ? { speedMps } : {}),
      capturedAt: Number.isFinite(capturedAt) ? capturedAt : now,
    })
  }

  // Breadcrumb buffer → sampled async persistence (Redis stream; the
  // location queue worker flushes samples to ride_location_samples).
  await redisGeo.xadd(
    BREADCRUMB_STREAM,
    'MAXLEN', '~', '100000',
    '*',
    'driverId', String(driverId),
    'rideId', presence.rideId ? String(presence.rideId) : '',
    'lat', String(lat),
    'lng', String(lng),
    'state', String(presence.state),
    'capturedAt', String(Number.isFinite(capturedAt) ? capturedAt : now),
  )

  return { accepted: true, reason: moved ? 'MOVED' : 'INTERVAL_OK', persisted: false }
}

/**
 * Offer-aware presence: when a driver is shown an offer, mark RIDE_OFFERED
 * so they aren't offered again while deciding.
 */
export async function markOfferShown(driverId) {
  const p = await getPresence(driverId)
  if (p && p.state === DRIVER_OPERATIONAL_STATE.ONLINE_IDLE) {
    await setPresenceState(driverId, DRIVER_OPERATIONAL_STATE.RIDE_OFFERED)
  }
}
