import fp from 'fastify-plugin'
import rateLimit from '@fastify/rate-limit'
import { env } from '../config/env.js'
import { redisRateLimit } from '../config/redis.js'

/**
 * Default rate-limit key: the real client IP (behind CDN/LB).
 * Spec 06 §3: IP is only for unauthenticated traffic — carrier NAT means
 * many legitimate mobile users share one IP, so authenticated limiters use
 * compound keys (buildRateLimitKey below).
 */
export function clientIpKey(request) {
  const cfConnectingIp = request.headers['cf-connecting-ip']
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim()) {
    return cfConnectingIp.trim()
  }

  const xRealIp = request.headers['x-real-ip']
  if (typeof xRealIp === 'string' && xRealIp.trim()) {
    return xRealIp.trim()
  }

  const forwardedFor = request.headers['x-forwarded-for']
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim()
  }

  return request.ip
}

/**
 * Compound rate-limit key builder (spec 06 §3). Examples:
 *   rl:ip:{ip}:global
 *   rl:user:{userId}:ride-create
 *   rl:driver:{driverId}:ride-accept
 *   rl:phone:{e164}:otp-request
 */
export function buildRateLimitKey(kind, id, bucket) {
  return `rl:${kind}:${id}:${bucket}`
}

/**
 * Identity-aware key generator factory for route-level limits: prefers the
 * authenticated principal (user/driver) and falls back to IP+device.
 */
export function identityKey(bucket) {
  return (request) => {
    const userId = request.user?.id || request.userId
    if (userId) {
      const role = request.roles?.[0] || 'user'
      return buildRateLimitKey(role.toLowerCase(), userId, bucket)
    }
    const deviceId = request.headers['x-device-id']
    return buildRateLimitKey('ip', clientIpKey(request), deviceId ? `${bucket}:${deviceId}` : bucket)
  }
}

/**
 * Redis-backed rate limiting for routes that opt in via `config.rateLimit`.
 * Global limits stay IP-based; per-domain budgets (OTP, quotes, ride
 * create, driver accept…) are applied per-route with identity keys as each
 * module lands (spec 06 §4 starting budgets).
 */
async function rateLimitPlugin(fastify) {
  if (!env.RATE_LIMIT_ENABLED) {
    fastify.log.warn('Rate limiting is disabled by configuration')
    return
  }

  await fastify.register(rateLimit, {
    global: false,
    redis: redisRateLimit,
    hook: 'onRequest',
    nameSpace: 'raahi:ratelimit:',
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // Spec 06 §7: fail behavior is per endpoint class — ordinary reads may
    // degrade locally (skipOnError), costly/sensitive endpoints opt into
    // fail-closed via their own config; @fastify/rate-limit error callback
    // renders through the global error handler envelope.
    skipOnError: true,
    keyGenerator: clientIpKey,
  })
}

export default fp(rateLimitPlugin, { name: 'rate-limit' })
