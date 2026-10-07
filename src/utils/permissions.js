/**
 * Canonical RBAC vocabulary and role → permission maps for the mobility
 * platform — Raahi spec 05 §4 and dashboard spec 11 §16.
 *
 * Authorization uses explicit permission strings checked by
 * middlewares/permission-check.js — never scattered role-string checks.
 *
 * @module utils/permissions
 */

/**
 * Canonical permission registry (spec 05 §4 examples + domains they imply).
 * @type {ReadonlyArray<string>}
 */
export const CANONICAL_PERMISSION_LIST = Object.freeze([
  // Audit
  'audit.read',

  // Drivers
  'driver.read',
  'driver.approve',
  'driver.suspend',
  'driver.documents.read',
  'driver.documents.approve',

  // Vehicles & categories
  'vehicle.read',
  'vehicle.write',
  'vehicle_category.read',
  'vehicle_category.write',

  // Cities & zones
  'city.read',
  'city.write',
  'service_zone.read',
  'service_zone.write',

  // Rides
  'ride.read',
  'ride.cancel',
  'ride.manual_assign',

  // Dispatch
  'dispatch.read',
  'dispatch.intervene',

  // Pricing
  'pricing.read',
  'pricing.write',

  // Payments & finance
  'payment.read',
  'payment.refund',
  'earnings.read',
  'payout.read',
  'payout.approve',

  // Coupons
  'coupon.read',
  'coupon.write',

  // Maps provider config
  'maps.read',
  'maps.rotate_key',
  'maps.test',

  // Safety
  'safety.incident.read',
  'safety.incident.manage',
  'safety.evidence.read',

  // Support
  'support.read',
  'support.respond',

  // Platform controls
  'platform.controls.write',
  'notification_template.write',
  'feature_flag.write',

  // Ratings
  'rating.read',
])

const PERMISSION_SET = new Set(CANONICAL_PERMISSION_LIST)

/** @param {string} permission */
export function isCanonicalPermission(permission) {
  return PERMISSION_SET.has(permission)
}

/**
 * Permission groups reused by several roles.
 */
const READ_ONLY = Object.freeze([
  'audit.read',
  'driver.read',
  'driver.documents.read',
  'vehicle.read',
  'vehicle_category.read',
  'city.read',
  'service_zone.read',
  'ride.read',
  'dispatch.read',
  'pricing.read',
  'payment.read',
  'earnings.read',
  'payout.read',
  'coupon.read',
  'maps.read',
  'safety.incident.read',
  'support.read',
  'rating.read',
])

const CITY_OPS = Object.freeze([
  ...READ_ONLY,
  'ride.cancel',
  'dispatch.intervene',
  'safety.incident.manage',
  'support.respond',
])

/**
 * Dashboard roles (spec 11 §16) + mobile-facing roles.
 * Passenger/driver roles carry no dashboard permissions — resource access
 * for them is ownership-based (object policy), not permission-based.
 *
 * @type {Record<string, ReadonlySet<string>>}
 */
export const ROLE_PERMISSIONS = Object.freeze({
  PASSENGER: new Set([]),
  DRIVER: new Set([]),

  READ_ONLY_ANALYST: new Set(READ_ONLY),

  SUPPORT: new Set([
    ...READ_ONLY,
    'support.respond',
    'safety.incident.read',
  ]),

  DRIVER_KYC_REVIEWER: new Set([
    ...READ_ONLY,
    'driver.approve',
    'driver.suspend',
    'driver.documents.approve',
  ]),

  CITY_OPERATIONS: new Set(CITY_OPS),

  OPERATIONS: new Set([
    ...CITY_OPS,
    'city.write',
    'service_zone.write',
    'vehicle_category.write',
    'vehicle.write',
    'driver.approve',
    'driver.documents.approve',
    'ride.manual_assign',
    'coupon.write',
  ]),

  FINANCE: new Set([
    ...READ_ONLY,
    'payment.refund',
    'payout.approve',
    'coupon.write',
  ]),

  SAFETY_OPERATOR: new Set([
    ...READ_ONLY,
    'safety.incident.manage',
    'safety.evidence.read',
  ]),

  SUPER_ADMIN: new Set(CANONICAL_PERMISSION_LIST),
})

/** @param {string} role */
export function permissionsForRole(role) {
  const set = ROLE_PERMISSIONS[role]
  return set ? Array.from(set) : []
}

/** @param {string} role @param {string|string[]} required */
export function roleHasPermission(role, required) {
  const needed = Array.isArray(required) ? required : [required]
  const set = ROLE_PERMISSIONS[role]
  if (!set) return false
  return needed.every((permission) => set.has(permission))
}

/**
 * Legacy aliases kept so pre-migration tokens keep resolving during rollout.
 * @type {Record<string, string>}
 */
export const LEGACY_ROLE_ALIASES = Object.freeze({
  ADMIN: 'SUPER_ADMIN',
  HQ_MANAGER: 'OPERATIONS',
  HQ_SUPPORT: 'SUPPORT',
  HQ_FINANCE: 'FINANCE',
  SUPPORT_AGENT: 'SUPPORT',
  FINANCE_USER: 'FINANCE',
  RIDER: 'DRIVER',
  CUSTOMER: 'PASSENGER',
})

/** Normalize any legacy role token to its canonical name. */
export function canonicalRole(role) {
  if (!role) return 'PASSENGER'
  return LEGACY_ROLE_ALIASES[role] || role
}
