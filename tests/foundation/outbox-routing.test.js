import { describe, it, expect } from 'vitest'
import { routeOutboxEvent } from '../../src/runtime/workers.js'

describe('outbox event routing (spec 03 §11, spec 10 §15)', () => {
  it('safety events get their own queue — never delayed behind notifications', () => {
    expect(routeOutboxEvent('SAFETY_INCIDENT_CREATED')).toBe('safety')
    expect(routeOutboxEvent('SOS_TRIGGERED')).toBe('safety')
    expect(routeOutboxEvent('GUARDIAN_JOURNEY_OVERDUE')).toBe('safety')
  })

  it('payment/refund/settlement events go to the payments queue', () => {
    expect(routeOutboxEvent('PAYMENT_CAPTURED')).toBe('payments')
    expect(routeOutboxEvent('REFUND_PROCESSED')).toBe('payments')
    expect(routeOutboxEvent('SETTLEMENT_RUN')).toBe('payments')
  })

  it('notification events go to the notifications queue', () => {
    expect(routeOutboxEvent('NOTIFICATION_RIDE_ASSIGNED')).toBe('notifications')
    expect(routeOutboxEvent('PUSH_DRIVER_NEW_OFFER')).toBe('notifications')
  })

  it('ride/dispatch/offer events go to the dispatch queue', () => {
    expect(routeOutboxEvent('RIDE_CREATED')).toBe('dispatch')
    expect(routeOutboxEvent('DISPATCH_WAVE_EXHAUSTED')).toBe('dispatch')
    expect(routeOutboxEvent('OFFER_ACCEPTED')).toBe('dispatch')
  })

  it('unknown types fall back to the general outbox queue', () => {
    expect(routeOutboxEvent('SOMETHING_ELSE')).toBe('general')
    expect(routeOutboxEvent('')).toBe('general')
    expect(routeOutboxEvent(null)).toBe('general')
  })

  it('routing is case-insensitive', () => {
    expect(routeOutboxEvent('ride_completed')).toBe('dispatch')
    expect(routeOutboxEvent('sos_triggered')).toBe('safety')
  })
})
