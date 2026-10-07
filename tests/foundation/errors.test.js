import { describe, it, expect } from 'vitest'
import { DomainError, ERROR_CODES, HTTP_STATUS } from '../../src/constants/errors.js'

describe('error codes (spec 09 §8)', () => {
  it('contains the spec-named stable codes', () => {
    const specCodes = [
      'AUTH_REQUIRED',
      'TOKEN_EXPIRED',
      'SESSION_REVOKED',
      'OTP_RATE_LIMITED',
      'OTP_INVALID',
      'DRIVER_NOT_APPROVED',
      'DRIVER_DOCUMENT_EXPIRED',
      'DRIVER_ALREADY_BUSY',
      'RIDE_ALREADY_ASSIGNED',
      'RIDE_NOT_FOUND',
      'RIDE_INVALID_STATE',
      'RIDE_ALREADY_CANCELLED',
      'QUOTE_EXPIRED',
      'QUOTE_ROUTE_UNAVAILABLE',
      'PAYMENT_PENDING',
      'PAYMENT_FAILED',
      'PAYMENT_ALREADY_PROCESSED',
      'SERVICE_ZONE_UNAVAILABLE',
      'RATE_LIMITED',
      'SAFETY_INCIDENT_ACTIVE',
    ]
    for (const code of specCodes) {
      expect(ERROR_CODES[code], code).toBeDefined()
    }
  })

  it('UNAUTHORIZED aliases AUTH_REQUIRED (spec code wins in payloads)', () => {
    expect(ERROR_CODES.UNAUTHORIZED).toBe('AUTH_REQUIRED')
  })
})

describe('DomainError', () => {
  it('maps known codes to HTTP statuses deterministically', () => {
    expect(new DomainError(ERROR_CODES.RIDE_ALREADY_ASSIGNED).statusCode).toBe(HTTP_STATUS.CONFLICT)
    expect(new DomainError(ERROR_CODES.AUTH_REQUIRED).statusCode).toBe(HTTP_STATUS.UNAUTHORIZED)
    expect(new DomainError(ERROR_CODES.RATE_LIMITED).statusCode).toBe(HTTP_STATUS.TOO_MANY_REQUESTS)
    expect(new DomainError(ERROR_CODES.RIDE_NOT_FOUND).statusCode).toBe(HTTP_STATUS.NOT_FOUND)
  })

  it('unknown codes default to 400', () => {
    expect(new DomainError('TOTALLY_UNKNOWN').statusCode).toBe(400)
  })

  it('carries retryable and details for the spec 09 §7 envelope', () => {
    const err = new DomainError(ERROR_CODES.QUOTE_ROUTE_UNAVAILABLE, 'Routing unavailable', {
      retryable: true,
      details: { provider: 'ola-maps' },
    })
    expect(err.retryable).toBe(true)
    expect(err.details).toEqual({ provider: 'ola-maps' })
    expect(err.statusCode).toBe(503)
    expect(err.name).toBe('DomainError')
  })
})
