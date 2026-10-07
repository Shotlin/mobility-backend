import { describe, it, expect } from 'vitest'
import { assertTransition, evaluateCancellation, canDriverCommand, isTerminal } from '../../src/modules/rides/rides.state.js'
import { RIDE_STATUS } from '../../src/constants/states.js'
import { DomainError } from '../../src/constants/errors.js'

describe('ride transition guard (spec 04 §5)', () => {
  it('allows exactly the spec transitions', () => {
    expect(() => assertTransition('REQUESTED', 'SEARCHING')).not.toThrow()
    expect(() => assertTransition('SEARCHING', 'ASSIGNED')).not.toThrow()
    expect(() => assertTransition('ASSIGNED', 'DRIVER_EN_ROUTE')).not.toThrow()
    expect(() => assertTransition('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED')).not.toThrow()
    expect(() => assertTransition('DRIVER_ARRIVED', 'IN_PROGRESS')).not.toThrow()
    expect(() => assertTransition('IN_PROGRESS', 'COMPLETED')).not.toThrow()
    expect(() => assertTransition('IN_PROGRESS', 'CANCELLED')).not.toThrow()
  })

  it('rejects skips and backwards moves', () => {
    expect(() => assertTransition('REQUESTED', 'ASSIGNED')).toThrow(DomainError)
    expect(() => assertTransition('ASSIGNED', 'SEARCHING')).toThrow(DomainError)
    expect(() => assertTransition('DRIVER_ARRIVED', 'IN_PROGRESS')).not.toThrow()
    expect(() => assertTransition('COMPLETED', 'IN_PROGRESS')).toThrow(DomainError)
    expect(() => assertTransition('IN_PROGRESS', 'DRIVER_EN_ROUTE')).toThrow(DomainError)
  })

  it('terminal states are absorbing', () => {
    for (const t of ['COMPLETED', 'CANCELLED', 'NO_DRIVER_FOUND']) {
      expect(isTerminal(t)).toBe(true)
      expect(() => assertTransition(t, 'SEARCHING')).toThrow(DomainError)
      expect(() => assertTransition(t, t)).toThrow(DomainError)
    }
  })
})

describe('cancellation policy matrix (spec 13 §13)', () => {
  const policy = {
    cancellationFeePaise: 2500,
    freeCancelBeforeAssignS: 60,
    freeCancelAfterPickupMin: 3,
  }

  it('free while searching', () => {
    const p = evaluateCancellation({ status: 'SEARCHING', actorRole: 'PASSENGER', policy })
    expect(p.allowed).toBe(true)
    expect(p.feePaise).toBe(0)
  })

  it('fee waived within free window after assignment, charged after', () => {
    const fresh = evaluateCancellation({
      status: 'ASSIGNED', actorRole: 'PASSENGER', policy,
      assignedAt: new Date(Date.now() - 30 * 1000),
    })
    expect(fresh.allowed).toBe(true)
    expect(fresh.feePaise).toBe(0)

    const late = evaluateCancellation({
      status: 'ASSIGNED', actorRole: 'PASSENGER', policy,
      assignedAt: new Date(Date.now() - 120 * 1000),
    })
    expect(late.feePaise).toBe(2500)
  })

  it('grace window after driver arrival', () => {
    const within = evaluateCancellation({
      status: 'DRIVER_ARRIVED', actorRole: 'PASSENGER', policy,
      arrivedAt: new Date(Date.now() - 60 * 1000),
    })
    expect(within.feePaise).toBe(0)
    const after = evaluateCancellation({
      status: 'DRIVER_ARRIVED', actorRole: 'PASSENGER', policy,
      arrivedAt: new Date(Date.now() - 10 * 60000),
    })
    expect(after.feePaise).toBe(2500)
  })

  it('active trip is NOT passenger-cancellable', () => {
    const p = evaluateCancellation({ status: 'IN_PROGRESS', actorRole: 'PASSENGER', policy })
    expect(p.allowed).toBe(false)
    expect(p.reasonCode).toBe('RIDE_NOT_CANCELLABLE')
    // Admin CAN cancel an active trip (safety/support path).
    const a = evaluateCancellation({ status: 'IN_PROGRESS', actorRole: 'ADMIN', policy })
    expect(a.allowed).toBe(true)
  })

  it('terminal rides are never cancellable', () => {
    expect(evaluateCancellation({ status: 'COMPLETED', actorRole: 'PASSENGER', policy }).allowed).toBe(false)
    expect(evaluateCancellation({ status: 'CANCELLED', actorRole: 'DRIVER', policy }).allowed).toBe(false)
  })
})

describe('driver command gating', () => {
  it('commands match the ride state machine', () => {
    expect(canDriverCommand('ASSIGNED')).toContain('DRIVER_EN_ROUTE')
    expect(canDriverCommand('DRIVER_ARRIVED')).toContain('IN_PROGRESS')
    expect(canDriverCommand('IN_PROGRESS')).toEqual(['COMPLETED'])
    expect(canDriverCommand('SEARCHING')).toEqual([])
    expect(canDriverCommand(RIDE_STATUS.REQUESTED)).toEqual([])
  })
})
