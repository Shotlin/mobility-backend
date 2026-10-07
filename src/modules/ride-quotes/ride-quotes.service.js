/**
 * Quotes service — creates immutable ride_quotes snapshots (spec 04 §4).
 * Flow: zone serviceability → authoritative road route (Ola) → fare rules
 * per active category → surge → coupon → quote rows with expiry.
 * If routing fails, quotes fail (QUOTE_ROUTE_UNAVAILABLE) — the engine is
 * never fed straight-line distances (spec 02 §7).
 */

import { env } from '../../config/env.js'
import { query } from '../../config/database.js'
import { withTransaction } from '../../utils/tx.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'
import { directions } from '../maps/maps.client.js'
import { computeFare, isWithinNightWindow } from '../pricing/pricing.engine.js'
import {
  resolveCityZone,
  resolveSurgeBps,
  resolveFareRule,
  resolveCoupon,
  activeCategoriesForCity,
  nightWindowFor,
} from '../pricing/pricing.service.js'
import { validateQuoteRequest } from '../pricing/quote.schemas.js'

export class RideQuotesService {
  async createQuote({ userId, body }) {
    const { pickup, drop, vehicleCategoryId, couponCode } = validateQuoteRequest(body)

    const { cityId, zoneId } = await resolveCityZone(pickup.lat, pickup.lng)
    // Drop must also be serviceable (V1: single-zone platform rules).
    await resolveCityZone(drop.lat, drop.lng).catch((err) => {
      if (err.code === ERROR_CODES.SERVICE_ZONE_UNAVAILABLE || err.code === ERROR_CODES.CITY_UNAVAILABLE) {
        throw new DomainError(ERROR_CODES.SERVICE_ZONE_UNAVAILABLE, 'Destination is not serviceable')
      }
      throw err
    })

    // AUTHORITATIVE road route — no fallback (spec 07 §9, spec 02 §7).
    const route = await directions({
      originLat: pickup.lat,
      originLng: pickup.lng,
      destLat: drop.lat,
      destLng: drop.lng,
    })

    const categories = vehicleCategoryId
      ? (await activeCategoriesForCity(cityId)).filter((c) => c.id === vehicleCategoryId)
      : await activeCategoriesForCity(cityId)
    if (categories.length === 0) {
      throw new DomainError(ERROR_CODES.VEHICLE_CATEGORY_UNAVAILABLE)
    }

    const now = new Date()
    const expiresAt = new Date(now.getTime() + env.QUOTE_TTL_S * 1000)

    const quotes = []
    for (const category of categories) {
      const rule = await resolveFareRule({ cityId, zoneId, vehicleCategoryId: category.id })
      const surgeBps = await resolveSurgeBps({ cityId, zoneId, vehicleCategoryId: category.id, at: now })
      const coupon = await resolveCoupon({
        code: couponCode,
        cityId,
        vehicleCategoryId: category.id,
        userId,
      })
      const breakdown = computeFare(rule, {
        routeDistanceM: route.distanceM,
        routeDurationS: route.durationS,
        surgeBps,
        isNight: isWithinNightWindow(nightWindowFor(rule), now),
        coupon: coupon
          ? {
              discountType: coupon.discount_type,
              percentBps: coupon.percent_bps,
              flatPaise: coupon.flat_paise,
              maxDiscountPaise: coupon.max_discount_paise,
              minFarePaise: coupon.min_fare_paise,
            }
          : null,
      })

      const { rows } = await withTransaction(async (client) => {
        return client.query(
          `INSERT INTO ride_quotes (
             user_id, city_id, zone_id, vehicle_category_id,
             pickup, pickup_address, drop, drop_address,
             route_provider, route_distance_m, route_duration_s,
             base_fare_paise, distance_fare_paise, duration_fare_paise, waiting_paise,
             surge_bps, surge_paise, platform_fee_paise, night_fee_paise, toll_paise,
             discount_paise, total_paise, pricing_version, coupon_id, expires_at,
             fare_rule_id, surge_rule_id
           ) VALUES ($1,$2,$3,$4,
             ST_SetSRID(ST_MakePoint($5,$6),4326), $7,
             ST_SetSRID(ST_MakePoint($8,$9),4326), $10,
             'ola_maps', $11, $12,
             $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
           RETURNING id, total_paise, expires_at`,
          [
            userId,
            cityId,
            zoneId,
            category.id,
            pickup.lng, pickup.lat,
            null,
            drop.lng, drop.lat,
            null,
            route.distanceM,
            route.durationS,
            breakdown.baseFarePaise,
            breakdown.distanceFarePaise,
            breakdown.durationFarePaise,
            breakdown.waitingPaise,
            breakdown.surgeBps,
            breakdown.surgePaise,
            breakdown.platformFeePaise,
            breakdown.nightFeePaise,
            breakdown.tollPaise,
            breakdown.discountPaise,
            breakdown.totalPaise,
            env.PRICING_VERSION,
            coupon?.id ?? null,
            expiresAt,
            rule.id,
            null,
          ],
        )
      })

      quotes.push({
        quoteId: rows[0].id,
        vehicleCategoryId: category.id,
        code: category.code,
        displayName: category.display_name,
        capacity: category.capacity,
        totalPaise: Number(rows[0].total_paise),
        breakdown,
      })
    }

    return {
      pricingVersion: env.PRICING_VERSION,
      expiresAt: expiresAt.toISOString(),
      route: { distanceM: route.distanceM, durationS: route.durationS },
      categories: quotes,
    }
  }

  /** Load a quote for booking; enforces ownership + expiry (spec 09 §8). */
  async getUsableQuote({ quoteId, userId }) {
    const { rows } = await query(`SELECT * FROM ride_quotes WHERE id = $1`, [quoteId])
    const quote = rows[0]
    if (!quote) throw new DomainError(ERROR_CODES.QUOTE_NOT_FOUND)
    if (quote.user_id !== userId) throw new DomainError(ERROR_CODES.QUOTE_USER_MISMATCH)
    if (new Date(quote.expires_at) < new Date()) throw new DomainError(ERROR_CODES.QUOTE_EXPIRED)
    return quote
  }
}
