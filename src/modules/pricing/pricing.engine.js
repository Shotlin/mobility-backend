/**
 * Pricing engine — PURE integer-paise fare math (spec 02 §7, spec 04 §3).
 *
 * RULES:
 *  - All amounts are integer paise. Floats never enter or leave.
 *  - Component order: base + distance + duration + waiting → surge (bps on
 *    the ride component) → platform fee → night fee → toll → − discount →
 *    clamp to min fare.
 *  - The engine NEVER receives straight-line distances (spec 02 §7: never
 *    price from straight-line fallback) — callers pass route distance_m
 *    from a road-route provider or they don't quote at all.
 *  - Rounding: half-up at each component boundary, integer paise out.
 */

/**
 * @param {number} value fractional paise → rounded half-up integer paise
 */
export function roundPaise(value) {
  return Math.floor(Number(value) + 0.5)
}

/**
 * Compute the fare breakdown.
 *
 * @param {object} rule fare rule (DB row shape)
 * @param {object} args
 * @param {number} args.routeDistanceM   metres, ROAD route, required
 * @param {number} args.routeDurationS   seconds, ROAD route, required
 * @param {number} [args.waitingMin=0]
 * @param {number} [args.surgeBps=10000] 10000 = 1.0x
 * @param {boolean} [args.isNight=false]
 * @param {number} [args.tollPaise=0]
 * @param {object|null} [args.coupon] {discountType, percentBps, flatPaise, maxDiscountPaise, minFarePaise}
 * @returns {object} breakdown (all integer paise) + totalPaise
 */
export function computeFare(rule, args) {
  const {
    routeDistanceM,
    routeDurationS,
    waitingMin = 0,
    surgeBps = 10000,
    isNight = false,
    tollPaise = 0,
    coupon = null,
  } = args

  if (!Number.isInteger(routeDistanceM) || routeDistanceM <= 0) {
    throw new Error('pricing: routeDistanceM must be a positive integer (road route required)')
  }
  if (!Number.isInteger(routeDurationS) || routeDurationS <= 0) {
    throw new Error('pricing: routeDurationS must be a positive integer')
  }
  if (!Number.isInteger(surgeBps) || surgeBps < 10000) {
    throw new Error('pricing: surgeBps must be >= 10000 (no surge below 1.0x)')
  }

  const baseFarePaise = Math.max(0, Math.trunc(rule.base_fare_paise))
  const distanceFarePaise = roundPaise((routeDistanceM / 1000) * rule.per_km_paise)
  const durationFarePaise = roundPaise((routeDurationS / 60) * (rule.per_minute_paise || 0))

  const freeWaiting = rule.free_waiting_min || 0
  const billableWaitingMin = Math.max(0, waitingMin - freeWaiting)
  const waitingPaise = roundPaise(billableWaitingMin * (rule.waiting_per_min_paise || 0))

  // Surge applies to the distance-based ride component (base + distance +
  // duration), not to fees/tolls (standard Indian ride-hailing practice).
  const rideComponent = baseFarePaise + distanceFarePaise + durationFarePaise + waitingPaise
  const surgePaise = roundPaise((rideComponent * (surgeBps - 10000)) / 10000)

  const platformFeePaise = Math.max(0, Math.trunc(rule.platform_fee_paise || 0))
  const nightFeePaise = isNight ? Math.max(0, Math.trunc(rule.night_fee_paise || 0)) : 0

  const gross =
    rideComponent + surgePaise + platformFeePaise + nightFeePaise + Math.max(0, Math.trunc(tollPaise))

  // Coupon validation + discount.
  let discountPaise = 0
  if (coupon) {
    if (gross < (coupon.minFarePaise || 0)) {
      discountPaise = 0
    } else if (coupon.discountType === 'PERCENT') {
      discountPaise = roundPaise((gross * coupon.percentBps) / 10000)
    } else if (coupon.discountType === 'FLAT') {
      discountPaise = Math.trunc(coupon.flatPaise || 0)
    }
    if (coupon.maxDiscountPaise != null) {
      discountPaise = Math.min(discountPaise, Math.trunc(coupon.maxDiscountPaise))
    }
    discountPaise = Math.max(0, Math.min(discountPaise, gross))
  }

  const subtotal = gross - discountPaise
  // Minimum fare applies AFTER discounts: the passenger never pays below
  // min_fare, but a discount cannot push the total above gross either.
  const minFarePaise = Math.max(0, Math.trunc(rule.min_fare_paise))
  const totalPaise = Math.max(subtotal, minFarePaise)

  // Driver commission basis: fare excluding platform fee and toll pass-through
  const commissionPaise = roundPaise(((totalPaise - platformFeePaise - Math.max(0, Math.trunc(tollPaise))) * rule.commission_bps) / 10000)

  return {
    baseFarePaise,
    distanceFarePaise,
    durationFarePaise,
    waitingPaise,
    surgeBps,
    surgePaise,
    platformFeePaise,
    nightFeePaise,
    tollPaise: Math.max(0, Math.trunc(tollPaise)),
    discountPaise,
    totalPaise,
    commissionPaise,
  }
}

/** Night window check (rule.night_window = {start:"23:00", end:"05:00"}). */
export function isWithinNightWindow(nightWindow, date = new Date()) {
  if (!nightWindow?.start || !nightWindow?.end) return false
  const minutes = date.getHours() * 60 + date.getMinutes()
  const toMinutes = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number)
    return h * 60 + m
  }
  const start = toMinutes(nightWindow.start)
  const end = toMinutes(nightWindow.end)
  if (start === end) return false
  // Window may cross midnight (e.g. 23:00 → 05:00)
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}
