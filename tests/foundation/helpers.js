/**
 * Permissions the security spec (05 §4) names explicitly — the registry
 * must contain every one of them.
 */
export const DOMAIN_PERMISSIONS_REQUIRED_BY_SPEC_05 = Object.freeze([
  'driver.read',
  'driver.approve',
  'driver.suspend',
  'ride.read',
  'ride.cancel',
  'ride.manual_assign',
  'pricing.read',
  'pricing.write',
  'payout.approve',
  'maps.rotate_key',
  'safety.incident.read',
  'safety.incident.manage',
  'audit.read',
])
