import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { computeFare, roundPaise, isWithinNightWindow } from '../../src/modules/pricing/pricing.engine.js'

const baseRule = {
  base_fare_paise: 3000,
  min_fare_paise: 5000,
  per_km_paise: 850,
  per_minute_paise: 100,
  free_waiting_min: 3,
  waiting_per_min_paise: 100,
  platform_fee_paise: 500,
  night_fee_paise: 2000,
  night_window: { start: '23:00', end: '05:00' },
  commission_bps: 2000,
}

describe('pricing engine — deterministic scenarios (spec 02 §7)', () => {
  it('computes a simple 8km/15min ride with every component', () => {
    const b = computeFare(baseRule, { routeDistanceM: 8000, routeDurationS: 900 })
    expect(b.baseFarePaise).toBe(3000)
    expect(b.distanceFarePaise).toBe(6800) // 8 * 850
    expect(b.durationFarePaise).toBe(1500) // 15 * 100
    expect(b.waitingPaise).toBe(0)
    expect(b.surgePaise).toBe(0)
    expect(b.platformFeePaise).toBe(500)
    expect(b.nightFeePaise).toBe(0)
    expect(b.totalPaise).toBe(3000 + 6800 + 1500 + 500)
    // commission 20% of fare minus platform fee
    expect(b.commissionPaise).toBe(Math.round(((b.totalPaise - 500) * 2000) / 10000))
  })

  it('surge 1.5x applies only to the ride component, never to fees', () => {
    const b = computeFare(baseRule, { routeDistanceM: 8000, routeDurationS: 900, surgeBps: 15000 })
    const rideComponent = 3000 + 6800 + 1500
    expect(b.surgePaise).toBe(Math.round((rideComponent * 5000) / 10000))
    expect(b.platformFeePaise).toBe(500)
  })

  it('waiting charges bill only minutes beyond the free window', () => {
    const b = computeFare(baseRule, { routeDistanceM: 1000, routeDurationS: 120, waitingMin: 10 })
    expect(b.waitingPaise).toBe(700) // 10 - 3 free = 7 * 100
  })

  it('night fee only when isNight', () => {
    const day = computeFare(baseRule, { routeDistanceM: 1000, routeDurationS: 120, isNight: false })
    const night = computeFare(baseRule, { routeDistanceM: 1000, routeDurationS: 120, isNight: true })
    expect(day.nightFeePaise).toBe(0)
    expect(night.nightFeePaise).toBe(2000)
  })

  it('minimum fare clamps the total (discount cannot undercut min fare)', () => {
    const rule = { ...baseRule, min_fare_paise: 5000 }
    const b = computeFare(rule, {
      routeDistanceM: 100, routeDurationS: 60,
      coupon: { discountType: 'FLAT', flatPaise: 100000 },
    })
    expect(b.totalPaise).toBe(5000)
  })

  it('percent coupons discount within cap and never below zero', () => {
    const b = computeFare(baseRule, {
      routeDistanceM: 8000, routeDurationS: 900,
      coupon: { discountType: 'PERCENT', percentBps: 2500, maxDiscountPaise: 2000 },
    })
    const gross = 3000 + 6800 + 1500 + 500
    expect(b.discountPaise).toBe(2000) // capped
    expect(b.totalPaise).toBe(gross - 2000)
  })

  it('coupon below min-fare threshold applies no discount', () => {
    const b = computeFare(baseRule, {
      routeDistanceM: 1000, routeDurationS: 120,
      coupon: { discountType: 'PERCENT', percentBps: 5000, minFarePaise: 100000 },
    })
    expect(b.discountPaise).toBe(0)
  })

  it('rejects missing/invalid road route inputs (never straight-line)', () => {
    expect(() => computeFare(baseRule, { routeDistanceM: 0, routeDurationS: 100 })).toThrow()
    expect(() => computeFare(baseRule, { routeDistanceM: 1.5, routeDurationS: 100 })).toThrow()
    expect(() => computeFare(baseRule, { routeDistanceM: 1000, routeDurationS: 0 })).toThrow()
    expect(() => computeFare(baseRule, { routeDistanceM: 1000, routeDurationS: 100, surgeBps: 9000 })).toThrow()
  })
})

describe('pricing engine — property tests (fast-check, spec 02 §10)', () => {
  const ruleArb = fc.record({
    base_fare_paise: fc.integer({ min: 0, max: 50000 }),
    min_fare_paise: fc.integer({ min: 0, max: 50000 }),
    per_km_paise: fc.integer({ min: 0, max: 10000 }),
    per_minute_paise: fc.integer({ min: 0, max: 500 }),
    free_waiting_min: fc.integer({ min: 0, max: 30 }),
    waiting_per_min_paise: fc.integer({ min: 0, max: 500 }),
    platform_fee_paise: fc.integer({ min: 0, max: 2000 }),
    night_fee_paise: fc.integer({ min: 0, max: 5000 }),
    night_window: fc.constant({ start: '23:00', end: '05:00' }),
    commission_bps: fc.integer({ min: 0, max: 5000 }),
  })

  it('every breakdown component is a non-negative integer for any valid inputs', () => {
    const prop = fc.property(
      ruleArb,
      fc.integer({ min: 100, max: 200000 }), // distanceM
      fc.integer({ min: 60, max: 14400 }), // durationS
      fc.integer({ min: 0, max: 120 }), // waitingMin
      fc.integer({ min: 10000, max: 30000 }), // surgeBps
      fc.boolean(),
      fc.integer({ min: 0, max: 10000 }), // toll
      (rule, dist, dur, wait, surge, isNight, toll) => {
        const b = computeFare(rule, { routeDistanceM: dist, routeDurationS: dur, waitingMin: wait, surgeBps: surge, isNight, tollPaise: toll })
        for (const key of Object.keys(b)) {
          const v = b[key]
          if (key === 'surgeBps') continue
          expect(Number.isInteger(v), `${key}=${v} must be integer`).toBe(true)
          expect(v, `${key}=${v} must be >= 0`).toBeGreaterThanOrEqual(0)
        }
      },
    )
    fc.assert(prop, { numRuns: 500 })
  })

  it('total >= min fare, total == components - discount (or min fare clamp)', () => {
    const prop = fc.property(
      ruleArb,
      fc.integer({ min: 100, max: 200000 }),
      fc.integer({ min: 60, max: 14400 }),
      fc.integer({ min: 10000, max: 30000 }),
      (rule, dist, dur, surge) => {
        const b = computeFare(rule, { routeDistanceM: dist, routeDurationS: dur, surgeBps: surge })
        expect(b.totalPaise).toBeGreaterThanOrEqual(rule.min_fare_paise)
        const sum =
          b.baseFarePaise + b.distanceFarePaise + b.durationFarePaise + b.waitingPaise +
          b.surgePaise + b.platformFeePaise + b.nightFeePaise + b.tollPaise - b.discountPaise
        expect(b.totalPaise).toBe(Math.max(sum, rule.min_fare_paise))
      },
    )
    fc.assert(prop, { numRuns: 500 })
  })

  it('higher surge never yields a lower total (monotonicity)', () => {
    const prop = fc.property(
      ruleArb,
      fc.integer({ min: 100, max: 200000 }),
      fc.integer({ min: 60, max: 14400 }),
      fc.integer({ min: 10000, max: 20000 }),
      (rule, dist, dur, surge) => {
        const low = computeFare(rule, { routeDistanceM: dist, routeDurationS: dur, surgeBps: surge })
        const high = computeFare(rule, { routeDistanceM: dist, routeDurationS: dur, surgeBps: surge + 1000 })
        expect(high.totalPaise).toBeGreaterThanOrEqual(low.totalPaise)
      },
    )
    fc.assert(prop, { numRuns: 300 })
  })
})

describe('roundPaise + night window', () => {
  it('rounds half-up', () => {
    expect(roundPaise(10.5)).toBe(11)
    expect(roundPaise(10.4)).toBe(10)
    expect(roundPaise(0.5)).toBe(1)
  })

  it('night window crosses midnight correctly', () => {
    const w = { start: '23:00', end: '05:00' }
    const mk = (h, m = 0) => new Date(2026, 0, 1, h, m)
    expect(isWithinNightWindow(w, mk(23, 30))).toBe(true)
    expect(isWithinNightWindow(w, mk(0, 30))).toBe(true)
    expect(isWithinNightWindow(w, mk(4, 59))).toBe(true)
    expect(isWithinNightWindow(w, mk(5, 0))).toBe(false)
    expect(isWithinNightWindow(w, mk(12, 0))).toBe(false)
    expect(isWithinNightWindow({ start: '01:00', end: '04:00' }, mk(2, 0))).toBe(true)
    expect(isWithinNightWindow(null, mk(2, 0))).toBe(false)
  })
})
