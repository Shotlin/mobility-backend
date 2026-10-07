/**
 * Ola Maps server-side client (spec 13 §4, spec 03 §12).
 *
 * The API key NEVER leaves the backend — mobile apps call our proxy
 * endpoints. Every call: circuit breaker, concurrency cap, timeout,
 * bounded jittered retries, short-TTL response caching (provider terms
 * permitting), and no fabricated fallbacks (spec 03 §12): routing
 * failures surface as QUOTE_ROUTE_UNAVAILABLE — never straight-line
 * distances.
 */

import axios from 'axios'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { CircuitBreaker, ConcurrencyLimiter, withProviderProtection } from '../../utils/resilience.js'
import { cacheGet, cacheSet } from '../../utils/cache.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'
import { getActiveMapsSettings } from '../ola-maps-settings/ola-maps-settings.service.js'

const breaker = new CircuitBreaker('ola-maps', { failureThreshold: 5, resetTimeoutMs: 30000 })
const limiter = new ConcurrencyLimiter(env.OLA_MAPS_CONCURRENCY)

/** Credential resolution: dashboard-managed settings first, then env. */
async function resolveApiKey() {
  try {
    const settings = await getActiveMapsSettings()
    if (settings?.apiKey) return settings.apiKey
  } catch (err) {
    logger.debug({ err: err.message }, 'maps settings loader unavailable — using env key')
  }
  return env.OLA_MAPS_API_KEY || null
}

function requireKey(key) {
  if (!key) {
    throw new DomainError(ERROR_CODES.MAPS_NOT_CONFIGURED, 'Maps provider is not configured', {
      retryable: false,
    })
  }
}

async function providerGet(path, params, { cacheTtlS = 0, cacheKey = null, retries = 1, method = 'GET' } = {}) {
  if (cacheTtlS > 0 && cacheKey) {
    const cached = await cacheGet(cacheKey)
    if (cached) return { data: cached, fromCache: true }
  }

  const apiKey = await resolveApiKey()
  requireKey(apiKey)

  const isRetryable = (err) => {
    const status = err.response?.status
    return status === 429 || status >= 500 || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT'
  }

  try {
    const { data } = await withProviderProtection(
      {
        breaker,
        limiter,
        timeoutMs: env.OLA_MAPS_TIMEOUT_MS,
        retries,
        isRetryable,
        name: 'ola-maps',
      },
      () =>
        axios({
          method,
          url: `${env.OLA_MAPS_BASE_URL}${path}`,
          params,
          headers: { 'X-Api-Key': apiKey },
          // No axios retry of its own — withProviderProtection owns retries.
          timeout: env.OLA_MAPS_TIMEOUT_MS,
        }),
    )

    if (cacheTtlS > 0 && cacheKey) {
      await cacheSet(cacheKey, data, cacheTtlS)
    }
    return { data, fromCache: false }
  } catch (err) {
    if (err.code === 'CIRCUIT_OPEN' || err.code === 'PROVIDER_TIMEOUT' || err.code === 'CONCURRENCY_TIMEOUT') {
      throw new DomainError(ERROR_CODES.MAPS_UNAVAILABLE, 'Maps provider temporarily unavailable', {
        retryable: true,
        details: { reason: err.code },
      })
    }
    const status = err.response?.status
    if (status === 429) {
      throw new DomainError(ERROR_CODES.MAPS_RATE_LIMITED, 'Maps provider rate limited', { retryable: true })
    }
    logger.warn({ err: err.message, status, path }, 'Ola Maps call failed')
    throw new DomainError(ERROR_CODES.MAPS_UNAVAILABLE, 'Maps provider temporarily unavailable', {
      retryable: true,
    })
  }
}

/** Autocomplete suggestions. `location` biases results near the user. */
export async function autocomplete({ input, location, lat, lng }) {
  return providerGet('/places/v1/autocomplete', {
    input,
    ...(lat != null && lng != null ? { location: `${lat},${lng}` } : {}),
    ...(location ? { location } : {}),
  }, {
    cacheTtlS: 300,
    cacheKey: `maps:autocomplete:${input}:${lat ?? ''},${lng ?? ''}`,
  })
}

/** Place details by provider place id. */
export async function placeDetails({ placeId }) {
  return providerGet('/places/v1/details', { place_id: placeId }, {
    cacheTtlS: 3600,
    cacheKey: `maps:place:${placeId}`,
  })
}

/** Reverse geocode coordinates → address. */
export async function reverseGeocode({ lat, lng }) {
  return providerGet('/places/v1/reverse-geocode', { latlng: `${lat},${lng}` }, {
    cacheTtlS: 600,
    cacheKey: `maps:reverse:${lat},${lng}`,
  })
}

/**
 * Directions — the AUTHORITATIVE road route for pricing (spec 02 §7).
 * Returns { distanceM, durationS, polyline } — throws QUOTE_ROUTE_UNAVAILABLE
 * when the provider cannot route; callers must never substitute straight-line.
 */
export async function directions({ originLat, originLng, destLat, destLng }) {
  // Ola's Directions API (2026): POST with ALL parameters as query-string
  // params and no body; `mode` is lowercase; distance/duration live in
  // routes[0].legs[0]; the encoded polyline is routes[0].overview_polyline.
  // The old GET form 404s ("404 Route Not Found").
  const { data } = await providerGet(
    '/routing/v1/directions',
    {
      origin: `${originLat},${originLng}`,
      destination: `${destLat},${destLng}`,
      mode: 'driving',
      alternatives: false,
      steps: false,
      overview: 'full',
    },
    { retries: 1, method: 'POST' },
  )

  if (data?.status !== 'SUCCESS' && !Array.isArray(data?.routes)) {
    throw new DomainError(ERROR_CODES.QUOTE_ROUTE_UNAVAILABLE, 'No usable road route for this trip', {
      retryable: true,
    })
  }
  const leg = data?.routes?.[0]?.legs?.[0]
  const distanceM = leg?.distance
  const durationS = leg?.duration
  if (!Number.isFinite(Number(distanceM)) || Number(distanceM) <= 0 ||
      !Number.isFinite(Number(durationS)) || Number(durationS) <= 0) {
    logger.warn({ origin: originLat, dest: destLat }, 'Ola directions returned unusable route')
    throw new DomainError(ERROR_CODES.QUOTE_ROUTE_UNAVAILABLE, 'No usable road route for this trip', {
      retryable: true,
    })
  }

  return {
    distanceM: Math.round(Number(distanceM)),
    durationS: Math.round(Number(durationS)),
    polyline: data?.routes?.[0]?.overview_polyline || null,
  }
}

/** Deep-health probe used by the dashboard "test connection" flow. */
export async function testConnection() {
  const apiKey = await resolveApiKey()
  requireKey(apiKey)
  try {
    await withProviderProtection(
      { breaker, limiter, timeoutMs: env.OLA_MAPS_TIMEOUT_MS, retries: 0, name: 'ola-maps-test' },
      () => axios.get(`${env.OLA_MAPS_BASE_URL}/places/v1/autocomplete`, {
        params: { input: 'test' },
        headers: { 'X-Api-Key': apiKey },
        timeout: env.OLA_MAPS_TIMEOUT_MS,
      }),
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export function mapsProviderSnapshot() {
  return { breaker: breaker.snapshot(), limiter: limiter.snapshot() }
}
