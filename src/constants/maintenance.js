/**
 * Maintenance-mode helpers (spec 11 §14 platform controls).
 * Health, webhooks and safety endpoints bypass the gate (spec 10 §15:
 * safety traffic keeps highest priority even during platform degradation).
 */

import { ERROR_CODES, HTTP_STATUS } from './errors.js'

/**
 * @param {string} requestId
 */
export function MAINTENANCE_ENVELOPE(requestId) {
  return {
    error: {
      code: ERROR_CODES.MAINTENANCE_MODE,
      message: 'The platform is under scheduled maintenance. Please try again shortly.',
      requestId,
      retryable: true,
      details: null,
    },
    status: HTTP_STATUS.SERVICE_UNAVAILABLE,
  }
}
