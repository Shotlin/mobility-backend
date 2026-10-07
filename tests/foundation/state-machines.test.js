import { describe, it, expect } from 'vitest'
import {
  RIDE_STATUS,
  RIDE_TRANSITIONS,
  RIDE_TERMINAL_STATES,
  OFFER_STATUS,
  OFFER_TRANSITIONS,
  PAYMENT_STATUS,
  DRIVER_OPERATIONAL_STATE,
  DRIVER_APPROVAL_STATE,
  SAFETY_INCIDENT_STATUS,
} from '../../src/constants/states.js'

describe('ride state machine (spec 04 §5)', () => {
  it('has exactly the spec states', () => {
    expect(Object.values(RIDE_STATUS).sort()).toEqual(
      [
        'ASSIGNED',
        'CANCELLED',
        'COMPLETED',
        'DRIVER_ARRIVED',
        'DRIVER_EN_ROUTE',
        'IN_PROGRESS',
        'NO_DRIVER_FOUND',
        'REQUESTED',
        'SEARCHING',
      ].sort(),
    )
  })

  it('every non-terminal state has at least one transition', () => {
    for (const [state, next] of Object.entries(RIDE_TRANSITIONS)) {
      if (!RIDE_TERMINAL_STATES.includes(state)) {
        expect(next.length, `${state} must have exits`).toBeGreaterThan(0)
      }
    }
  })

  it('terminal states have no exits', () => {
    for (const terminal of RIDE_TERMINAL_STATES) {
      expect(RIDE_TRANSITIONS[terminal]).toEqual([])
    }
  })

  it('all transition targets are defined states (no typos)', () => {
    for (const next of Object.values(RIDE_TRANSITIONS)) {
      for (const target of next) {
        expect(Object.values(RIDE_STATUS)).toContain(target)
      }
    }
  })

  it('assignment only happens from SEARCHING (spec 04 §14)', () => {
    for (const [state, next] of Object.entries(RIDE_TRANSITIONS)) {
      if (state !== RIDE_STATUS.SEARCHING) {
        expect(next).not.toContain(RIDE_STATUS.ASSIGNED)
      }
    }
  })

  it('completed rides can only be reached from IN_PROGRESS', () => {
    for (const [state, next] of Object.entries(RIDE_TRANSITIONS)) {
      if (state !== RIDE_STATUS.IN_PROGRESS) {
        expect(next).not.toContain(RIDE_STATUS.COMPLETED)
      }
    }
  })
})

describe('offer state machine (spec 04 §6)', () => {
  it('offers can only be accepted while OFFERED', () => {
    for (const [state, next] of Object.entries(OFFER_TRANSITIONS)) {
      if (state !== OFFER_STATUS.OFFERED) {
        expect(next).not.toContain(OFFER_STATUS.ACCEPTED)
      }
    }
  })

  it('all offer terminal states are absorbing', () => {
    const absorbing = [
      OFFER_STATUS.ACCEPTED,
      OFFER_STATUS.DECLINED,
      OFFER_STATUS.EXPIRED,
      OFFER_STATUS.LOST_TO_ANOTHER_DRIVER,
      OFFER_STATUS.CANCELLED,
    ]
    for (const state of absorbing) {
      expect(OFFER_TRANSITIONS[state]).toEqual([])
    }
  })
})

describe('payment / driver / safety vocabularies (spec 04 §7-8, spec 10 §14)', () => {
  it('payment states match spec', () => {
    expect(Object.values(PAYMENT_STATUS).sort()).toEqual(
      [
        'AUTHORIZED',
        'CASH_COLLECTED',
        'CASH_DUE',
        'CAPTURED',
        'FAILED',
        'PARTIALLY_REFUNDED',
        'PENDING',
        'REFUNDED',
        'REFUND_PENDING',
      ].sort(),
    )
  })

  it('driver operational state is distinct from approval state', () => {
    const ops = Object.values(DRIVER_OPERATIONAL_STATE)
    const approval = Object.values(DRIVER_APPROVAL_STATE)
    for (const s of ops) expect(approval).not.toContain(s)
    for (const s of approval) expect(ops).not.toContain(s)
  })

  it('safety incident states match spec 10 §14', () => {
    expect(Object.values(SAFETY_INCIDENT_STATUS).length).toBe(8)
  })
})
