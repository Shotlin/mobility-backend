/**
 * Pricing service — loads applicable fare rules, surge, zone serviceability
 * (spec 04 §12 stage-0: a ride must start in an active serviceable zone).
 */

import { query } from '../../config/database.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'
import { cacheGet, cacheSet } from '../../utils/cache.js'

/**
 * Resolve city + zone for a point. Returns null city when the point is
 * outside every active city zone (serviceability = zone polygons).
 */
export async function resolveCityZone(lat, lng) {
  const { rows } = await query(
    `SELECT z.id AS zone_id, z.city_id, z.bookings_enabled AS zone_bookings_enabled,
            c.is_active AS city_active, c.bookings_enabled AS city_bookings_enabled
       FROM service_zones z
       JOIN cities c ON c.id = z.city_id
      WHERE z.is_active = true
        AND ST_Contains(z.boundary, ST_SetSRID(ST_MakePoint($1, $2), 4326))
      ORDER BY z.created_at
      LIMIT 1`,
    [lng, lat],
  )
  if (rows.length === 0) {
    throw new DomainError(ERROR_CODES.SERVICE_ZONE_UNAVAILABLE, 'This area is not serviceable yet')
  }
  const row = rows[0]
  if (!row.city_active || !row.city_bookings_enabled || !row.zone_bookings_enabled) {
    throw new DomainError(ERROR_CODES.CITY_UNAVAILABLE, 'Bookings are currently disabled in this area')
  }
  return { cityId: row.city_id, zoneId: row.zone_id }
}

/** Applicable surge multiplier (bps) for city/zone/category right now. */
export async function resolveSurgeBps({ cityId, zoneId, vehicleCategoryId, at = new Date() }) {
  const { rows } = await query(
    `SELECT multiplier_bps FROM surge_rules
      WHERE is_active = true
        AND city_id = $1
        AND (zone_id IS NULL OR zone_id = $2)
        AND (vehicle_category_id IS NULL OR vehicle_category_id = $3)
        AND (days_of_week IS NULL OR $4 = ANY(days_of_week))
        AND (start_time IS NULL OR end_time IS NULL
             OR (start_time <= end_time AND $5::time >= start_time AND $5::time < end_time)
             OR (start_time > end_time AND ($5::time >= start_time OR $5::time < end_time)))
      ORDER BY multiplier_bps DESC
      LIMIT 1`,
    [cityId, zoneId, vehicleCategoryId, at.getDay(), at.toTimeString().slice(0, 8)],
  )
  return rows[0]?.multiplier_bps ?? 10000
}

/** Active fare rule for city/zone/category (cached briefly — config data). */
export async function resolveFareRule({ cityId, zoneId, vehicleCategoryId }) {
  const cacheKey = `pricing:rule:${cityId}:${zoneId}:${vehicleCategoryId}`
  const cached = await cacheGet(cacheKey)
  if (cached) return cached

  const { rows } = await query(
    `SELECT * FROM fare_rules
      WHERE is_active = true
        AND NOW() >= effective_from AND (effective_to IS NULL OR NOW() < effective_to)
        AND city_id = $1
        AND vehicle_category_id = $2
        AND (zone_id IS NULL OR zone_id = $3)
      ORDER BY (zone_id IS NOT NULL) DESC, effective_from DESC
      LIMIT 1`,
    [cityId, vehicleCategoryId, zoneId],
  )
  if (rows.length === 0) {
    throw new DomainError(
      ERROR_CODES.VEHICLE_CATEGORY_UNAVAILABLE,
      'No fare configuration for this vehicle category in this area',
    )
  }
  await cacheSet(cacheKey, rows[0], 60) // 60s: admin changes take effect quickly
  return rows[0]
}

/** Validate a coupon for use; returns the row or throws a stable code. */
export async function resolveCoupon({ code, cityId, vehicleCategoryId, userId }) {
  if (!code) return null
  const { rows } = await query(
    `SELECT * FROM coupons
      WHERE upper(code) = upper($1) AND is_active = true
        AND valid_from <= NOW() AND (valid_to IS NULL OR valid_to > NOW())
      LIMIT 1`,
    [code],
  )
  const coupon = rows[0]
  if (!coupon) throw new DomainError(ERROR_CODES.COUPON_INVALID)
  if (coupon.city_id && coupon.city_id !== cityId) {
    throw new DomainError(ERROR_CODES.COUPON_INVALID, 'Coupon not valid in this city')
  }
  if (coupon.vehicle_category_id && coupon.vehicle_category_id !== vehicleCategoryId) {
    throw new DomainError(ERROR_CODES.COUPON_INVALID, 'Coupon not valid for this vehicle category')
  }
  if (coupon.max_redemptions_total != null) {
    const { rows: totalRows } = await query(
      `SELECT count(*)::int AS n FROM coupon_redemptions WHERE coupon_id = $1`,
      [coupon.id],
    )
    if (totalRows[0].n >= coupon.max_redemptions_total) {
      throw new DomainError(ERROR_CODES.COUPON_LIMIT_REACHED, 'Coupon fully redeemed')
    }
  }
  if (userId) {
    const { rows: userRows } = await query(
      `SELECT count(*)::int AS n FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2`,
      [coupon.id, userId],
    )
    if (userRows[0].n >= coupon.max_redemptions_per_user) {
      throw new DomainError(ERROR_CODES.COUPON_LIMIT_REACHED, 'You have already used this coupon')
    }
    if (coupon.first_ride_only) {
      const { rows: rideRows } = await query(
        `SELECT count(*)::int AS n FROM rides
          WHERE passenger_id = $1 AND status = 'COMPLETED'`,
        [userId],
      )
      if (rideRows[0].n > 0) {
        throw new DomainError(ERROR_CODES.COUPON_INVALID, 'Coupon valid on your first ride only')
      }
    }
  }
  return coupon
}

/** Active categories enabled for the city (server-driven, spec 13 §6). */
export async function activeCategoriesForCity(cityId) {
  const cacheKey = `pricing:categories:${cityId}`
  const cached = await cacheGet(cacheKey)
  if (cached) return cached
  const { rows } = await query(
    `SELECT vc.*, cvc.is_active AS city_enabled
       FROM city_vehicle_categories cvc
       JOIN vehicle_categories vc ON vc.id = cvc.vehicle_category_id
      WHERE cvc.city_id = $1 AND cvc.is_active = true AND vc.is_active = true
      ORDER BY vc.sort_order`,
    [cityId],
  )
  await cacheSet(cacheKey, rows, 60)
  return rows
}

/** Night window configured on the rule (null = no night fee). */
export function nightWindowFor(rule) {
  return rule?.night_window ?? null
}
