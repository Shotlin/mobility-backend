/**
 * Rides routes — passenger-facing ride APIs (spec 09 §3).
 * Driver commands (accept/arrived/verify-pin/start/complete) live in the
 * drivers module (Phase 6) and call the same transition service.
 */

import { query } from '../../config/database.js'
import { RidesService } from './rides.service.js'
import { identityKey } from '../../plugins/rateLimit.plugin.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'

const ridesService = new RidesService()

const rideProjectionSchema = {
  type: 'object',
  properties: {
    rideId: { type: 'string' },
    status: { type: 'string' },
    rideVersion: { type: 'integer' },
    paymentMethod: { type: 'string' },
    pickup: { type: 'object' },
    drop: { type: 'object' },
    vehicleCategory: { type: 'object' },
    driver: { type: ['object', 'null'] },
    timestamps: { type: 'object' },
    fare: { type: 'object' },
    tripPin: { type: 'string' },
  },
}

async function ridesRoutes(fastify) {
  fastify.post(
    '/',
    {
      schema: {
        tags: ['Rides'],
        summary: 'Book a ride from an accepted quote (Idempotency-Key required)',
        body: {
          type: 'object',
          required: ['quoteId', 'pickup', 'drop', 'paymentMethod'],
          properties: {
            quoteId: { type: 'string', format: 'uuid' },
            pickup: {
              type: 'object', required: ['lat', 'lng'],
              properties: { lat: { type: 'number' }, lng: { type: 'number' } }, additionalProperties: false,
            },
            drop: {
              type: 'object', required: ['lat', 'lng'],
              properties: { lat: { type: 'number' }, lng: { type: 'number' } }, additionalProperties: false,
            },
            paymentMethod: { type: 'string', enum: ['CASH', 'RAZORPAY_UPI'] },
          },
          additionalProperties: false,
        },
        response: { 201: rideProjectionSchema },
      },
      config: { rateLimit: { max: 6, timeWindow: '1 minute', keyGenerator: identityKey('ride-create') } },
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const ride = await ridesService.createRide({
        userId: request.userId,
        body: request.body,
        idempotencyKey: request.headers['idempotency-key'],
      })
      return reply.code(201).send(ride)
    },
  )

  fastify.get(
    '/current',
    {
      schema: { tags: ['Rides'], summary: 'Authoritative active ride (reconnect resync)', response: { 200: { ...rideProjectionSchema, 'xNullable': true } } },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const role = request.roles?.[0] === 'DRIVER' ? 'DRIVER' : 'PASSENGER'
      return ridesService.getCurrentRide({ userId: request.userId, actorRole: role })
    },
  )

  fastify.get(
    '/history',
    {
      schema: {
        tags: ['Rides'],
        summary: 'Keyset-paginated ride history (spec 03 §14)',
        querystring: {
          type: 'object',
          properties: {
            before: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
        },
      },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const role = request.roles?.[0] === 'DRIVER' ? 'DRIVER' : 'PASSENGER'
      return ridesService.listHistory({
        userId: request.userId,
        actorRole: role,
        before: request.query.before,
        limit: request.query.limit,
      })
    },
  )

  fastify.get(
    '/:rideId',
    {
      schema: {
        tags: ['Rides'],
        summary: 'Ride projection (ownership enforced)',
        params: { type: 'object', required: ['rideId'], properties: { rideId: { type: 'string', format: 'uuid' } } },
        response: { 200: rideProjectionSchema },
      },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const { rows } = await query(
        `SELECT passenger_id, driver_id FROM rides WHERE id = $1`,
        [request.params.rideId],
      )
      const ride = rows[0]
      if (!ride) throw new DomainError(ERROR_CODES.RIDE_NOT_FOUND)
      const role = request.roles?.[0] === 'DRIVER' ? 'DRIVER' : 'PASSENGER'
      const owns = role === 'DRIVER' ? ride.driver_id === request.userId : ride.passenger_id === request.userId
      if (!owns) throw new DomainError(ERROR_CODES.FORBIDDEN, 'Not your ride')
      return ridesService.getRideForActor({ rideId: request.params.rideId, userId: request.userId, actorRole: role })
    },
  )

  fastify.post(
    '/:rideId/cancel',
    {
      schema: {
        tags: ['Rides'],
        summary: 'Cancel (policy-based fee, state-guarded)',
        params: { type: 'object', required: ['rideId'], properties: { rideId: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          properties: {
            reason: { type: 'string', maxLength: 64 },
            comment: { type: 'string', maxLength: 500 },
          },
          additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 hour', keyGenerator: identityKey('ride-cancel') } },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const role = request.roles?.[0] === 'DRIVER' ? 'DRIVER' : 'PASSENGER'
      const ride = await ridesService.cancelRide({
        rideId: request.params.rideId,
        userId: request.userId,
        actorRole: role,
        reason: request.body?.reason,
        comment: request.body?.comment,
      })
      return { rideId: ride.id, status: ride.status, rideVersion: ride.ride_version }
    },
  )

  fastify.post(
    '/:rideId/pin',
    {
      schema: {
        tags: ['Rides'],
        summary: 'Issue trip PIN (passenger-only plaintext, spec 05 §9)',
        params: { type: 'object', required: ['rideId'], properties: { rideId: { type: 'string', format: 'uuid' } } },
        response: {
          200: {
            type: 'object',
            properties: { pin: { type: 'string', pattern: '^[0-9]{4}$' } },
          },
        },
      },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      return ridesService.issueTripPin({ rideId: request.params.rideId, userId: request.userId })
    },
  )
}

export default ridesRoutes
