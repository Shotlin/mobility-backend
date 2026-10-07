/**
 * Quotes routes — POST /api/v1/quotes (spec 09 §3).
 * Rate limit: 30/min per user (spec 06 §4).
 */

import { RideQuotesService } from './ride-quotes.service.js'
import { identityKey } from '../../plugins/rateLimit.plugin.js'

const quoteService = new RideQuotesService()

const quoteSchema = {
  tags: ['Quotes'],
  summary: 'Create upfront fare quotes per vehicle category (server-authoritative)',
  body: {
    type: 'object',
    required: ['pickup', 'drop'],
    properties: {
      pickup: {
        type: 'object',
        required: ['lat', 'lng'],
        properties: {
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lng: { type: 'number', minimum: -180, maximum: 180 },
        },
        additionalProperties: false,
      },
      drop: {
        type: 'object',
        required: ['lat', 'lng'],
        properties: {
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lng: { type: 'number', minimum: -180, maximum: 180 },
        },
        additionalProperties: false,
      },
      vehicleCategoryId: { type: 'string', format: 'uuid' },
      couponCode: { type: 'string', minLength: 1, maxLength: 32 },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        pricingVersion: { type: 'string' },
        expiresAt: { type: 'string' },
        route: {
          type: 'object',
          properties: {
            distanceM: { type: 'integer' },
            durationS: { type: 'integer' },
          },
          required: ['distanceM', 'durationS'],
        },
        categories: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              quoteId: { type: 'string' },
              vehicleCategoryId: { type: 'string' },
              code: { type: 'string' },
              displayName: { type: 'string' },
              capacity: { type: 'integer' },
              totalPaise: { type: 'integer' },
              breakdown: { type: 'object' },
            },
          },
        },
      },
    },
  },
}

async function quoteRoutes(fastify) {
  fastify.post(
    '/',
    {
      schema: quoteSchema,
      config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: identityKey('quote') } },
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const result = await quoteService.createQuote({ userId: request.userId, body: request.body })
      return reply.code(200).send(result)
    },
  )

  fastify.get(
    '/:quoteId',
    {
      schema: {
        tags: ['Quotes'],
        summary: 'Fetch a quote snapshot (ownership enforced)',
        params: {
          type: 'object',
          required: ['quoteId'],
          properties: { quoteId: { type: 'string', format: 'uuid' } },
        },
      },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const quote = await quoteService.getUsableQuote({
        quoteId: request.params.quoteId,
        userId: request.userId,
      })
      return { quoteId: quote.id, totalPaise: Number(quote.total_paise), expiresAt: quote.expires_at }
    },
  )
}

export default quoteRoutes
