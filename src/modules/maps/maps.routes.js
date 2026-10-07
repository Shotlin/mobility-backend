/**
 * Maps proxy routes — /api/v1/maps (spec 09 §2, spec 13 §4).
 * Auth required. The provider key never appears in any response.
 * Rate limits per spec 06 §4: autocomplete 60/min, reverse geocode 30/min.
 */

import { autocomplete, placeDetails, reverseGeocode, directions } from './maps.client.js'
import { identityKey } from '../../plugins/rateLimit.plugin.js'

const coord = {
  type: 'object',
  required: ['lat', 'lng'],
  properties: {
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lng: { type: 'number', minimum: -180, maximum: 180 },
  },
  additionalProperties: false,
}

async function mapsRoutes(fastify) {
  fastify.post(
    '/autocomplete',
    {
      schema: {
        tags: ['Maps'],
        summary: 'Place autocomplete (provider key stays server-side)',
        body: {
          type: 'object',
          required: ['input'],
          properties: {
            input: { type: 'string', minLength: 2, maxLength: 200 },
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lng: { type: 'number', minimum: -180, maximum: 180 },
          },
          additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: identityKey('maps-autocomplete') } },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const { input, lat, lng } = request.body
      return autocomplete({ input, lat, lng })
    },
  )

  fastify.post(
    '/place-details',
    {
      schema: {
        tags: ['Maps'],
        summary: 'Resolve a place id into coordinates + address',
        body: {
          type: 'object',
          required: ['placeId'],
          properties: { placeId: { type: 'string', minLength: 4, maxLength: 200 } },
          additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: identityKey('maps-place') } },
      preHandler: [fastify.authenticate],
    },
    async (request) => placeDetails({ placeId: request.body.placeId }),
  )

  fastify.post(
    '/reverse-geocode',
    {
      schema: {
        tags: ['Maps'],
        summary: 'Coordinates → address',
        body: { ...coord, additionalProperties: false },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: identityKey('maps-reverse') } },
      preHandler: [fastify.authenticate],
    },
    async (request) => reverseGeocode(request.body),
  )

  fastify.post(
    '/directions',
    {
      schema: {
        tags: ['Maps'],
        summary: 'Road route (authoritative distance/duration for pricing)',
        body: {
          type: 'object',
          required: ['origin', 'destination'],
          properties: { origin: coord, destination: coord },
          additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: identityKey('maps-directions') } },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const { origin, destination } = request.body
      return directions({
        originLat: origin.lat,
        originLng: origin.lng,
        destLat: destination.lat,
        destLng: destination.lng,
      })
    },
  )
}

export default mapsRoutes
