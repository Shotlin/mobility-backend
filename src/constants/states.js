/**
 * Ride-hailing state machines — Raahi spec 04 §5-§8, §14 (safety spec 10 §14).
 *
 * These are the canonical vocabularies. Transitions are enforced in service
 * code (rides.state.js etc.) AND by DB constraints where catastrophic states
 * must be impossible (spec 04 §15).
 *
 * @module constants/states
 */

// ── Ride lifecycle (spec 04 §5) ─────────────────────────────────────
export const RIDE_STATUS = Object.freeze({
  REQUESTED: 'REQUESTED',           // row created from accepted quote
  SEARCHING: 'SEARCHING',           // dispatch active
  ASSIGNED: 'ASSIGNED',             // one driver won the claim
  DRIVER_EN_ROUTE: 'DRIVER_EN_ROUTE',
  DRIVER_ARRIVED: 'DRIVER_ARRIVED',
  IN_PROGRESS: 'IN_PROGRESS',       // PIN verified, trip started
  COMPLETED: 'COMPLETED',           // terminal success
  CANCELLED: 'CANCELLED',           // terminal exception
  NO_DRIVER_FOUND: 'NO_DRIVER_FOUND', // terminal exception
})

export const RIDE_TERMINAL_STATES = Object.freeze([
  RIDE_STATUS.COMPLETED,
  RIDE_STATUS.CANCELLED,
  RIDE_STATUS.NO_DRIVER_FOUND,
])

/**
 * Allowed ride transitions. Keys: current state → set of next states.
 * Dispatch internals (SEARCHING→ASSIGNED) live only in the dispatch service.
 */
export const RIDE_TRANSITIONS = Object.freeze({
  [RIDE_STATUS.REQUESTED]: Object.freeze([RIDE_STATUS.SEARCHING, RIDE_STATUS.CANCELLED]),
  [RIDE_STATUS.SEARCHING]: Object.freeze([
    RIDE_STATUS.ASSIGNED,
    RIDE_STATUS.CANCELLED,
    RIDE_STATUS.NO_DRIVER_FOUND,
  ]),
  [RIDE_STATUS.ASSIGNED]: Object.freeze([
    RIDE_STATUS.DRIVER_EN_ROUTE,
    // Driver may already be at the pickup point when accepting (spec 12 §9).
    RIDE_STATUS.DRIVER_ARRIVED,
    RIDE_STATUS.CANCELLED,
  ]),
  [RIDE_STATUS.DRIVER_EN_ROUTE]: Object.freeze([
    RIDE_STATUS.DRIVER_ARRIVED,
    RIDE_STATUS.CANCELLED,
  ]),
  [RIDE_STATUS.DRIVER_ARRIVED]: Object.freeze([
    RIDE_STATUS.IN_PROGRESS,
    RIDE_STATUS.CANCELLED,
  ]),
  [RIDE_STATUS.IN_PROGRESS]: Object.freeze([RIDE_STATUS.COMPLETED, RIDE_STATUS.CANCELLED]),
  [RIDE_STATUS.COMPLETED]: Object.freeze([]),
  [RIDE_STATUS.CANCELLED]: Object.freeze([]),
  [RIDE_STATUS.NO_DRIVER_FOUND]: Object.freeze([]),
})

// ── Offer lifecycle (spec 04 §6) ────────────────────────────────────
export const OFFER_STATUS = Object.freeze({
  OFFERED: 'OFFERED',
  ACCEPTED: 'ACCEPTED',
  DECLINED: 'DECLINED',
  EXPIRED: 'EXPIRED',
  LOST_TO_ANOTHER_DRIVER: 'LOST_TO_ANOTHER_DRIVER',
  CANCELLED: 'CANCELLED',
})

export const OFFER_TRANSITIONS = Object.freeze({
  [OFFER_STATUS.OFFERED]: Object.freeze([
    OFFER_STATUS.ACCEPTED,
    OFFER_STATUS.DECLINED,
    OFFER_STATUS.EXPIRED,
    OFFER_STATUS.LOST_TO_ANOTHER_DRIVER,
    OFFER_STATUS.CANCELLED,
  ]),
  [OFFER_STATUS.ACCEPTED]: Object.freeze([]),
  [OFFER_STATUS.DECLINED]: Object.freeze([]),
  [OFFER_STATUS.EXPIRED]: Object.freeze([]),
  [OFFER_STATUS.LOST_TO_ANOTHER_DRIVER]: Object.freeze([]),
  [OFFER_STATUS.CANCELLED]: Object.freeze([]),
})

// ── Payment lifecycle (spec 04 §7) ──────────────────────────────────
export const PAYMENT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  AUTHORIZED: 'AUTHORIZED',
  CAPTURED: 'CAPTURED',
  FAILED: 'FAILED',
  CASH_DUE: 'CASH_DUE',
  CASH_COLLECTED: 'CASH_COLLECTED',
  REFUND_PENDING: 'REFUND_PENDING',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
})

// ── Driver operational state (spec 04 §8) — distinct from approval ──
export const DRIVER_OPERATIONAL_STATE = Object.freeze({
  OFFLINE: 'OFFLINE',
  ONLINE_IDLE: 'ONLINE_IDLE',
  RIDE_OFFERED: 'RIDE_OFFERED',
  TO_PICKUP: 'TO_PICKUP',
  ARRIVED_WAITING: 'ARRIVED_WAITING',
  ON_TRIP: 'ON_TRIP',
})

/** Map ride status → expected driver operational state. */
export const RIDE_TO_DRIVER_STATE = Object.freeze({
  [RIDE_STATUS.ASSIGNED]: DRIVER_OPERATIONAL_STATE.TO_PICKUP,
  [RIDE_STATUS.DRIVER_EN_ROUTE]: DRIVER_OPERATIONAL_STATE.TO_PICKUP,
  [RIDE_STATUS.DRIVER_ARRIVED]: DRIVER_OPERATIONAL_STATE.ARRIVED_WAITING,
  [RIDE_STATUS.IN_PROGRESS]: DRIVER_OPERATIONAL_STATE.ON_TRIP,
})

// ── Driver approval / KYC state (spec 04 §8) ────────────────────────
export const DRIVER_APPROVAL_STATE = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  SUSPENDED: 'SUSPENDED',
  REJECTED: 'REJECTED',
  EXPIRED_DOCUMENTS: 'EXPIRED_DOCUMENTS',
})

// ── Driver document states ──────────────────────────────────────────
export const DRIVER_DOCUMENT_STATE = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
})

export const DRIVER_DOCUMENT_TYPES = Object.freeze([
  'SELFIE',
  'DRIVING_LICENCE',
  'VEHICLE_RC',
  'INSURANCE',
  'PUC',
  'BANK_OR_UPI',
])

// ── Safety incident lifecycle (spec 10 §14) ─────────────────────────
export const SAFETY_INCIDENT_STATUS = Object.freeze({
  OPEN: 'OPEN',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  CONTACTING_USER: 'CONTACTING_USER',
  ESCALATED: 'ESCALATED',
  EMERGENCY_SERVICES_REFERRED: 'EMERGENCY_SERVICES_REFERRED',
  MONITORING: 'MONITORING',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
})

export const SAFETY_INCIDENT_SEVERITY = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
})

export const SAFETY_INCIDENT_SOURCE = Object.freeze({
  PASSENGER_SOS: 'PASSENGER_SOS',
  DRIVER_SOS: 'DRIVER_SOS',
  DISCREET_SOS: 'DISCREET_SOS',
  ROUTE_ANOMALY: 'ROUTE_ANOMALY',
  UNEXPECTED_STOP: 'UNEXPECTED_STOP',
  GPS_LOSS: 'GPS_LOSS',
  PIN_FAILURES: 'PIN_FAILURES',
  GUARDIAN_OVERDUE: 'GUARDIAN_OVERDUE',
  OPERATOR: 'OPERATOR',
})

// ── Support tickets ─────────────────────────────────────────────────
export const SUPPORT_TICKET_STATUS = Object.freeze({
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  WAITING_ON_USER: 'WAITING_ON_USER',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
})

export const SUPPORT_ACTOR_TYPE = Object.freeze({
  PASSENGER: 'PASSENGER',
  DRIVER: 'DRIVER',
})

// ── Payouts ─────────────────────────────────────────────────────────
export const PAYOUT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  HELD: 'HELD',
})

export const PAYMENT_METHOD = Object.freeze({
  CASH: 'CASH',
  RAZORPAY_UPI: 'RAZORPAY_UPI',
})
