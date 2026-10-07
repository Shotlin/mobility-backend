import fp from 'fastify-plugin'
import { env } from '../config/env.js'
import { ERROR_CODES, HTTP_STATUS } from '../constants/errors.js'

/**
 * Global error handler — renders the Raahi spec 09 §7 error envelope:
 *
 *   { error: { code, message, requestId, retryable, details } }
 *
 * Stack traces never leave the process. Validation, rate-limit and domain
 * errors carry stable machine-readable codes (spec 09 §8).
 */
async function errorHandlerPlugin(fastify) {
  fastify.setErrorHandler((error, request, reply) => {
    const { statusCode = 500, message, validation, code } = error

    const render = (status, code_, message_, retryable = false, details = null) =>
      reply.code(status).send({
        error: {
          code: code_,
          message: message_,
          requestId: request.id,
          retryable,
          details,
        },
      })

    // Fastify JSON-schema validation errors
    if (validation) {
      return render(HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR, 'Validation error', false, {
        fields: validation.map((v) => ({
          field: v.instancePath?.replace('/', '') || v.params?.missingProperty,
          message: v.message,
        })),
      })
    }

    // Domain errors (constants/errors.js DomainError) carry everything.
    // Must be checked BEFORE the generic 429 branch so codes like
    // OTP_RATE_LIMITED keep their identity.
    if (error.name === 'DomainError' && error.code) {
      return render(error.statusCode, error.code, error.message, error.retryable, error.details)
    }

    // Rate limiter
    if (statusCode === 429 || code === 'FST_RATE_LIMIT_EXCEEDED') {
      const retryAfter = Number(reply.getHeader('retry-after')) || undefined
      if (retryAfter) reply.header('Retry-After', retryAfter)
      return render(HTTP_STATUS.TOO_MANY_REQUESTS, ERROR_CODES.RATE_LIMITED, 'Rate limit exceeded', true)
    }

    // Fastify-generated auth errors (FST_JWT_* expiry/invalid) are trusted 401s.
    const isFastifyAuthError =
      typeof code === 'string' && code.startsWith('FST_') && (statusCode === 401 || statusCode === 403)
    if (isFastifyAuthError) {
      const isExpiry = typeof code === 'string' && code.startsWith('FST_JWT') && /expired/i.test(message || '')
      return render(
        HTTP_STATUS.UNAUTHORIZED,
        isExpiry ? ERROR_CODES.TOKEN_EXPIRED : ERROR_CODES.TOKEN_INVALID,
        isExpiry ? 'Token has expired' : 'Invalid token',
        false,
      )
    }

    // Known non-5xx HTTP errors from trusted sources
    if (statusCode < 500 && !(statusCode === 401 || statusCode === 403)) {
      return render(statusCode, code || 'ERROR', message, false)
    }

    // Untrusted 401/403 (e.g. a third-party SDK error carrying ITS status code):
    // remap to 502 so provider outages don't masquerade as auth rejections.
    if (statusCode === 401 || statusCode === 403) {
      request.log.error(
        { err: error, statusCode },
        'Non-Fastify error carried a 401/403 statusCode — remapped to 502',
      )
      return render(HTTP_STATUS.SERVICE_UNAVAILABLE, 'UPSTREAM_ERROR',
        'A required service is temporarily unavailable. Please try again shortly.', true)
    }

    // 500 — internal
    request.log.error({ err: error }, 'Internal server error')
    return render(
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      ERROR_CODES.INTERNAL_ERROR,
      env.NODE_ENV === 'production' ? 'Internal server error' : message,
      false,
    )
  })

  fastify.setNotFoundHandler((request, reply) => {
    reply.code(HTTP_STATUS.NOT_FOUND).send({
      error: {
        code: ERROR_CODES.NOT_FOUND,
        message: `Route ${request.method} ${request.url} not found`,
        requestId: request.id,
        retryable: false,
        details: null,
      },
    })
  })
}

export default fp(errorHandlerPlugin, { name: 'error-handler' })
