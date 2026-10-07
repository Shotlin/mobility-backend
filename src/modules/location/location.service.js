/**
 * Driver presence — Redis hot state (spec 04 §9, spec 07 §8).
 *
 * Key model (spec 04 §9):
 *   geo:drivers:{cityId}:{vehicleCategoryId}   GEO index of online drivers
 *   presence:driver:{driverId}                  hash: state/loc/ts/rideId (TTL = heartbeat)
 *
 * Latest coordinates live ONLY here on the hot path — PostgreSQL is NOT
 * written per location event (spec 04 §11). Presence entries expire when
 * heartbeats stop; the GEO index is pruned by staleness filters at
 * dispatch time plus the maintenance sweep.
 */

import { redisGeo, redisApi } from '../../config/redis.js'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'

const PRESENCE_KEY = (driverId) => `presence:driver:${driverId}`
export const GEO_KEY = (cityId, vehicleCategoryId) => `geo:drivers:${cityId}:${vehicleCategoryId}`

const presence = redisGeo

export async function setDriverOnline({ driverId, cityId, vehicleCategoryId, lat, lng }) {
  const now = Date.now()
  const multi = presence.multi()
  multi.hset(PRESENCE_KEY(driverId), {
    state: 'ONLINE_IDLE',
    cityId: String(cityId),
    vehicleCategoryId: String(vehicleCategoryId),
    rideId: '',
    lat: String(lat),
    lng: String(lng),
    updatedAt: String(now),
  })
  multi.expire(PRESENCE_KEY(driverId), env.PRESENCE_TTL_S)
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    multi.geoadd(GEO_KEY(cityId, vehicleCategoryId), lng, lat, driverId)
  }
  await multi.exec()
  logger.debug({ driverId }, 'Driver online')
}

export async function setDriverOffline({ driverId, cityId, vehicleCategoryId }) {
  const p = await getPresence(driverId)
  const multi = presence.multi()
  multi.del(PRESENCE_KEY(driverId))
  if (p?.cityId && p?.vehicleCategoryId) {
    multi.zrem(GEO_KEY(p.cityId, p.vehicleCategoryId), driverId)
  } else if (cityId && vehicleCategoryId) {
    multi.zrem(GEO_KEY(cityId, vehicleCategoryId), driverId)
  }
  await multi.exec()
}

/**
 * Hot location ingest: refresh presence + GEO only. NO PostgreSQL write.
 * @returns {boolean} accepted (false = no presence → driver effectively offline)
 */
export async function updateDriverLocation({ driverId, lat, lng, rideId = null }) {
  const p = await getPresence(driverId)
  if (!p) return false
  const multi = presence.multi()
  multi.hset(PRESENCE_KEY(driverId), {
    lat: String(lat),
    lng: String(lng),
    updatedAt: String(Date.now()),
    ...(rideId ? { rideId: String(rideId) } : {}),
  })
  multi.expire(PRESENCE_KEY(driverId), env.PRESENCE_TTL_S)
  multi.geoadd(GEO_KEY(p.cityId, p.vehicleCategoryId), lng, lat, driverId)
  await multi.exec()
  return true
}

export async function getPresence(driverId) {
  const data = await presence.hgetall(PRESENCE_KEY(driverId))
  if (!data || !data.updatedAt) return null
  return {
    state: data.state,
    cityId: data.cityId || null,
    vehicleCategoryId: data.vehicleCategoryId || null,
    rideId: data.rideId || null,
    lat: Number(data.lat),
    lng: Number(data.lng),
    updatedAt: Number(data.updatedAt),
  }
}

export async function setPresenceState(driverId, state, { rideId = null } = {}) {
  const fields = { state: String(state), updatedAt: String(Date.now()) }
  if (rideId !== null) fields.rideId = String(rideId)
  const multi = presence.multi()
  multi.hset(PRESENCE_KEY(driverId), fields)
  multi.expire(PRESENCE_KEY(driverId), env.PRESENCE_TTL_S)
  await multi.exec()
}

/** Cheap candidate discovery (spec 04 §12 stage 1): Redis GEOSEARCH. */
export async function findNearbyDrivers({ cityId, vehicleCategoryId, lat, lng, radiusM, limit = 30 }) {
  const ids = await presence.geosearch(
    GEO_KEY(cityId, vehicleCategoryId),
    'FROMLONLAT', lng, lat,
    'BYRADIUS', radiusM, 'm',
    'ASC',
    'COUNT', limit,
  )
  return ids
}

/** Haversine straight-line distance (m) — candidate pruning ONLY (spec 07 §9). */
export function straightLineDistanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(a)))
}

/** Latency probe for readiness deep-diagnostics. */
export async function presenceHealth() {
  try {
    await redisApi.ping()
    return 'up'
  } catch (err) {
    return `down: ${err.message}`
  }
}
