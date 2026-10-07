/**
 * Realtime resync — ride events since a version (spec 04 §16, spec 09 §15).
 * Clients compare rideVersion after reconnect and pull missed events here;
 * the server never assumes exactly-once websocket delivery.
 */

import { query } from '../../config/database.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'
import { canonicalRole } from '../../utils/permissions.js'

async function realtimeRoutes(fastify) {
  fastify.get(
    '/rides/:rideId/events',
    {
      schema: {
        tags: ['Rides'],
        summary: 'Ride events since a version (reconnect resync)',
        params: { type: 'object', required: ['rideId'], properties: { rideId: { type: 'string', format: 'uuid' } } },
        querystring: {
          type: 'object',
          properties: { sinceVersion: { type: 'integer', minimum: 0, default: 0 } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              rideId: { type: 'string' },
              currentVersion: { type: 'integer' },
              events: { type: 'array' },
            },
          },
        },
      },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const role = canonicalRole(request.roles?.[0])
      const { rideId } = request.params
      const sinceVersion = request.query.sinceVersion ?? 0

      const { rows: rideRows } = await query(
        `SELECT passenger_id, driver_id, ride_version FROM rides WHERE id = $1`,
        [rideId],
      )
      const ride = rideRows[0]
      if (!ride) throw new DomainError(ERROR_CODES.RIDE_NOT_FOUND)

      // Room-join policy applies to HTTP resync too (spec 09 §9).
      const isPassenger = ride.passenger_id === request.userId
      const isDriver = ride.driver_id === request.userId
      const isOps = role !== 'PASSENGER' && role !== 'DRIVER'
      if (!isPassenger && !isDriver && !isOps) {
        throw new DomainError(ERROR_CODES.FORBIDDEN, 'Not your ride')
      }

      const { rows: events } = await query(
        `SELECT ride_version, event_type, payload, actor_id, actor_role, occurred_at
           FROM ride_events
          WHERE ride_id = $1 AND ride_version > $2
          ORDER BY ride_version ASC
          LIMIT 100`,
        [rideId, sinceVersion],
      )

      return {
        rideId,
        currentVersion: ride.ride_version,
        events: events.map((e) => ({
          v: 1,
          eventType: e.event_type,
          rideId,
          rideVersion: e.ride_version,
          occurredAt: e.occurred_at,
          data: { ...e.payload, actorRole: e.actor_role },
        })),
      }
    },
  )
}

export default realtimeRoutes
