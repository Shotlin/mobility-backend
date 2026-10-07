import { describe, it, expect } from 'vitest'
import {
  CANONICAL_PERMISSION_LIST,
  ROLE_PERMISSIONS,
  isCanonicalPermission,
  permissionsForRole,
  roleHasPermission,
  canonicalRole,
  LEGACY_ROLE_ALIASES,
} from '../../src/utils/permissions.js'
import { DOMAIN_PERMISSIONS_REQUIRED_BY_SPEC_05 } from './helpers.js'

describe('RBAC registry (spec 05 §4, spec 11 §16)', () => {
  it('permissions are unique', () => {
    expect(new Set(CANONICAL_PERMISSION_LIST).size).toBe(CANONICAL_PERMISSION_LIST.length)
  })

  it('contains every permission the security spec names explicitly', () => {
    for (const permission of DOMAIN_PERMISSIONS_REQUIRED_BY_SPEC_05) {
      expect(isCanonicalPermission(permission), permission).toBe(true)
    }
  })

  it('dashboard roles exist per spec 11 §16', () => {
    for (const role of [
      'SUPER_ADMIN',
      'OPERATIONS',
      'CITY_OPERATIONS',
      'DRIVER_KYC_REVIEWER',
      'FINANCE',
      'SAFETY_OPERATOR',
      'SUPPORT',
      'READ_ONLY_ANALYST',
    ]) {
      expect(ROLE_PERMISSIONS[role], role).toBeDefined()
    }
  })

  it('mobile actors carry no dashboard permissions', () => {
    expect(permissionsForRole('PASSENGER')).toEqual([])
    expect(permissionsForRole('DRIVER')).toEqual([])
  })

  it('SUPER_ADMIN holds every canonical permission', () => {
    for (const permission of CANONICAL_PERMISSION_LIST) {
      expect(roleHasPermission('SUPER_ADMIN', permission), permission).toBe(true)
    }
  })

  it('finance can refund and approve payouts but cannot manage safety incidents', () => {
    expect(roleHasPermission('FINANCE', 'payment.refund')).toBe(true)
    expect(roleHasPermission('FINANCE', 'payout.approve')).toBe(true)
    expect(roleHasPermission('FINANCE', 'safety.incident.manage')).toBe(false)
  })

  it('safety operator manages incidents but cannot rotate map keys', () => {
    expect(roleHasPermission('SAFETY_OPERATOR', 'safety.incident.manage')).toBe(true)
    expect(roleHasPermission('SAFETY_OPERATOR', 'maps.rotate_key')).toBe(false)
  })

  it('KYC reviewer approves drivers but cannot touch money', () => {
    expect(roleHasPermission('DRIVER_KYC_REVIEWER', 'driver.approve')).toBe(true)
    expect(roleHasPermission('DRIVER_KYC_REVIEWER', 'payment.refund')).toBe(false)
  })

  it('unknown roles get nothing', () => {
    expect(roleHasPermission('INVENTED_ROLE', 'ride.read')).toBe(false)
    expect(permissionsForRole('INVENTED_ROLE')).toEqual([])
  })

  it('legacy aliases resolve (socket/auth and tokens predate the rename)', () => {
    expect(canonicalRole('RIDER')).toBe('DRIVER')
    expect(canonicalRole('CUSTOMER')).toBe('PASSENGER')
    expect(canonicalRole('ADMIN')).toBe('SUPER_ADMIN')
    for (const alias of Object.keys(LEGACY_ROLE_ALIASES)) {
      expect(canonicalRole(alias)).not.toBe(alias)
    }
  })

  it('roleHasPermission supports AND-semantics arrays', () => {
    expect(roleHasPermission('OPERATIONS', ['ride.cancel', 'ride.manual_assign'])).toBe(true)
    expect(roleHasPermission('SUPPORT', ['ride.cancel', 'safety.incident.manage'])).toBe(false)
  })
})
