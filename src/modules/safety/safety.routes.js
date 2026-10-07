/**
 * Safety routes — passenger/driver SOS + Guardian + settings (spec 10),
 * and the operator incident queue (permission-gated, spec 05 §4).
 * SOS is NOT blocked by generic rate limits (spec 06 §7 class D): the
 * incident layer dedupes by design instead.
 */

import { query } from '../../config/database.js'
import {
  createOrEscalateIncident,
  acknowledgeIncident,
  transitionIncident,
  listOpenIncidents,
  confirmGuardianSafe,
  processGuardianCheck,
  getSafetySettings,
  upsertSafetySettings,
} from './safety.service.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'
import { canonicalRole } from '../../utils/permissions.js'

const coord = {
  type: 'object',
  required: ['lat', 'lng'],
  properties: {
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lng: { type: 'number', minimum: -180, maximum: 180 },
  },
  additionalProperties: false,
}

const sosSchema = {
  tags: ['Safety'],
  summary: 'SOS / discreet SOS — creates or escalates THE active incident',
  body: {
    type: 'object',
    required: ['source'],
    properties: {
      source: { type: 'string', enum: ['PASSENGER_SOS', 'DRIVER_SOS', 'DISCREET_SOS'] },
      rideId: { type: 'string', format: 'uuid' },
      severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
      location: coord,
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      properties: {
        incidentId: { type: 'string' },
        status: { type: 'string' },
        severity: { type: 'string' },
        emergencyNumber: { type: 'string' },
      },
    },
  },
}

async function requireActor(request, ...roles) {
  const role = canonicalRole(request.roles?.[0])
  if (!roles.includes(role)) {
    throw new DomainError(ERROR_CODES.FORBIDDEN, 'Not allowed for this actor')
  }
  return request.userId
}

async function safetyRoutes(fastify) {
  // ── SOS (spec 10 §6) ──────────────────────────────────────────────
  fastify.post(
    '/incidents',
    {
      schema: sosSchema,
      config: { rateLimit: false, maintenanceExempt: true }, // class D — spec 06 §7
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const actorRole = canonicalRole(request.roles?.[0])
      const reporterId = await requireActor(request, 'PASSENGER', 'DRIVER')
      const incident = await createOrEscalateIncident({
        reporterId,
        reporterRole: actorRole,
        rideId: request.body.rideId || null,
        source: request.body.source,
        severity: request.body.severity || (request.body.source === 'DISCREET_SOS' ? 'HIGH' : 'CRITICAL'),
        location: request.body.location,
      })
      return reply.code(201).send({
        incidentId: incident.id,
        status: incident.status,
        severity: incident.severity,
        emergencyNumber: '112',
      })
    },
  )

  // ── Guardian Journey "I'm Safe" (spec 10 §4) ─────────────────────
  fastify.post(
    '/guardian/:rideId/safe',
    {
      schema: {
        tags: ['Safety'],
        summary: 'Confirm safe — closes the Guardian session',
        params: { type: 'object', required: ['rideId'], properties: { rideId: { type: 'string', format: 'uuid' } } },
      },
      config: { rateLimit: false, maintenanceExempt: true },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const reporterId = await requireActor(request, 'PASSENGER')
      return confirmGuardianSafe({ rideId: request.params.rideId, userId: reporterId })
    },
  )

  // ── Safety settings (Women Safety+, Guardian prefs) ──────────────
  fastify.get(
    '/settings',
    {
      schema: { tags: ['Safety'], summary: 'Safety settings' },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const userId = await requireActor(request, 'PASSENGER', 'DRIVER')
      return getSafetySettings(userId) || { womenSafetyPlus: false }
    },
  )

  fastify.patch(
    '/settings',
    {
      schema: {
        tags: ['Safety'],
        summary: 'Update safety settings (Women Safety+, Guardian, discreet SOS)',
        body: {
          type: 'object',
          properties: {
            women_safety_plus: { type: 'boolean' },
            guardian_night_rides: { type: 'boolean' },
            guardian_all_rides: { type: 'boolean' },
            discreet_sos_enabled: { type: 'boolean' },
            anomaly_check_optin: { type: 'boolean' },
            auto_share_with_circle: { type: 'string', enum: ['NEVER', 'SOS_ONLY', 'NIGHT_RIDES', 'ALL_RIDES'] },
          },
          additionalProperties: false,
          minProperties: 1,
        },
      },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const userId = await requireActor(request, 'PASSENGER', 'DRIVER')
      return upsertSafetySettings(userId, request.body)
    },
  )

  // ── Operator incident queue (spec 10 §13) ────────────────────────
  fastify.get(
    '/incidents/open',
    {
      schema: {
        tags: ['Safety'],
        summary: 'Open safety incidents, severity-ordered (operator queue)',
        response: { 200: { type: 'object', properties: { incidents: { type: 'array' } } } },
      },
      config: { maintenanceExempt: true },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const role = canonicalRole(request.roles?.[0])
      const perms = request.permissions || []
      if (!perms.includes('safety.incident.read') && !perms.includes('safety.incident.manage')) {
        throw new DomainError(ERROR_CODES.FORBIDDEN, 'Requires safety.incident.read')
      }
      void role
      return { incidents: await listOpenIncidents() }
    },
  )

  fastify.post(
    '/incidents/:incidentId/acknowledge',
    {
      schema: {
        tags: ['Safety'],
        summary: 'Operator acknowledges an incident',
        params: { type: 'object', required: ['incidentId'], properties: { incidentId: { type: 'string', format: 'uuid' } } },
      },
      config: { maintenanceExempt: true },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      if (!request.permissions?.includes('safety.incident.manage')) {
        throw new DomainError(ERROR_CODES.FORBIDDEN, 'Requires safety.incident.manage')
      }
      const incident = await acknowledgeIncident({ incidentId: request.params.incidentId, operatorId: request.userId })
      return { incidentId: incident.id, status: incident.status }
    },
  )

  fastify.post(
    '/incidents/:incidentId/transition',
    {
      schema: {
        tags: ['Safety'],
        summary: 'Operator moves incident along the state machine',
        params: { type: 'object', required: ['incidentId'], properties: { incidentId: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object', required: ['status'],
          properties: {
            status: { type: 'string', enum: ['ACKNOWLEDGED', 'CONTACTING_USER', 'ESCALATED', 'EMERGENCY_SERVICES_REFERRED', 'MONITORING', 'RESOLVED', 'CLOSED'] },
            note: { type: 'string', maxLength: 500 },
          },
          additionalProperties: false,
        },
      },
      config: { maintenanceExempt: true },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      if (!request.permissions?.includes('safety.incident.manage')) {
        throw new DomainError(ERROR_CODES.FORBIDDEN, 'Requires safety.incident.manage')
      }
      const incident = await transitionIncident({
        incidentId: request.params.incidentId,
        to: request.body.status,
        operatorId: request.userId,
        note: request.body.note,
      })
      return { incidentId: incident.id, status: incident.status }
    },
  )

  // Internal worker probe (GUARDIAN_CHECK handler logic sanity endpoint).
  fastify.get(
    '/guardian/:sessionId/check',
    { schema: { tags: ['Safety'], summary: 'Guardian overdue check (internal/test)' } },
    async (request) => {
      const role = canonicalRole(request.roles?.[0])
      if (role === 'PASSENGER' || role === 'DRIVER') throw new DomainError(ERROR_CODES.FORBIDDEN)
      return processGuardianCheck({ guardianSessionId: request.params.sessionId })
    },
  )
}

export default safetyRoutes
