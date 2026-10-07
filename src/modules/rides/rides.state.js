/**
 * Ride state transition guard — PURE (spec 04 §5).
 * The server is the only author of ride state (spec 01 G1); every mutation
 * must call assertTransition. Terminal states are absorbing.
 */

import {
  RIDE_STATUS,
  RIDE_TRANSITIONS,
  RIDE_TERMINAL_STATES,
} from '../../constants/states.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'

/**
 * @param {string} from current status
 * @param {string} to intended status
 * @throws DomainError RIDE_INVALID_STATE when the transition is illegal
 */
export function assertTransition(from, to) {
  if (from === to) {
    // Idempotent replays of the same transition are handled by callers
    // checking current state first; a true no-op write is rejected here.
    throw new DomainError(ERROR_CODES.RIDE_INVALID_STATE, `Ride is already ${to}`)
  }
  const allowed = RIDE_TRANSITIONS[from]
  if (!allowed) {
    throw new DomainError(ERROR_CODES.RIDE_INVALID_STATE, `Unknown ride state ${from}`)
  }
  if (!allowed.includes(to)) {
    throw new DomainError(ERROR_CODES.RIDE_INVALID_STATE, `Cannot move ride from ${from} to ${to}`)
  }
  return true
}

export function isTerminal(status) {
  return RIDE_TERMINAL_STATES.includes(status)
}

/**
 * Cancellation policy (spec 02 §7, spec 13 §13).
 * @param {object} args
 * @param {string} args.status
 * @param {'PASSENGER'|'DRIVER'|'ADMIN'} args.actorRole
 * @param {object|null} args.policy {freeCancelBeforeAssignS, freeCancelAfterPickupMin, cancellationFeePaise}
 * @param {Date|null} args.assignedAt
 * @param {Date|null} args.arrivedAt
 * @returns {{allowed: boolean, feePaise: number, reasonCode?: string}}
 */
export function evaluateCancellation({ status, actorRole, policy, assignedAt, arrivedAt }) {
  if (isTerminal(status)) {
    return { allowed: false, feePaise: 0, reasonCode: 'RIDE_ALREADY_TERMINAL' }
  }
  const feePaise = Math.max(0, policy?.cancellationFeePaise ?? 0)
  const freeBeforeAssignS = Math.max(0, policy?.freeCancelBeforeAssignS ?? 0)
  const freeAfterPickupMin = Math.max(0, policy?.freeCancelAfterPickupMin ?? 0)

  switch (status) {
    case RIDE_STATUS.REQUESTED:
    case RIDE_STATUS.SEARCHING:
      // Free while nobody has been disturbed.
      return { allowed: true, feePaise: 0 }

    case RIDE_STATUS.ASSIGNED: {
      if (actorRole === 'DRIVER') return { allowed: true, feePaise } // drivers pay via ledger/cooldown
      const withinFree =
        assignedAt &&
        (Date.now() - new Date(assignedAt).getTime()) / 1000 <= freeBeforeAssignS
      return { allowed: true, feePaise: withinFree ? 0 : feePaise }
    }

    case RIDE_STATUS.DRIVER_EN_ROUTE: {
      if (actorRole === 'DRIVER') return { allowed: true, feePaise }
      return { allowed: true, feePaise }
    }

    case RIDE_STATUS.DRIVER_ARRIVED: {
      // Driver arrived: passenger has a short grace window to cancel free.
      const withinFree =
        arrivedAt &&
        (Date.now() - new Date(arrivedAt).getTime()) / 60000 <= freeAfterPickupMin
      return { allowed: true, feePaise: withinFree ? 0 : feePaise }
    }

    case RIDE_STATUS.IN_PROGRESS:
      // An active trip is not cancellable by passenger self-service —
      // safety/support handles emergencies (spec 13 §13).
      if (actorRole === 'PASSENGER' || actorRole === 'DRIVER') {
        return { allowed: false, feePaise: 0, reasonCode: 'RIDE_NOT_CANCELLABLE' }
      }
      return { allowed: true, feePaise: 0 }

    default:
      return { allowed: false, feePaise: 0, reasonCode: 'RIDE_INVALID_STATE' }
  }
}

/**
 * Status → allowed next UI milestone; used to sanity-check driver commands.
 */
export function canDriverCommand(status) {
  switch (status) {
    case RIDE_STATUS.ASSIGNED:
      return ['DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'CANCELLED']
    case RIDE_STATUS.DRIVER_EN_ROUTE:
      return ['DRIVER_ARRIVED', 'CANCELLED']
    case RIDE_STATUS.DRIVER_ARRIVED:
      return ['IN_PROGRESS', 'CANCELLED']
    case RIDE_STATUS.IN_PROGRESS:
      return ['COMPLETED']
    default:
      return []
  }
}
