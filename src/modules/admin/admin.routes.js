/**
 * Admin routes — /api/v1/admin (spec 09 §5). Permission-gated per the RBAC
 * registry; admin login under /auth/admin (no token).
 */

import { AdminService } from './admin.service.js'
import { permissionsForRole } from '../../utils/permissions.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'

const adminService = new AdminService()

const requirePermission = (permission) => async (request) => {
  const role = request.user?.role
  const perms = role ? permissionsForRole(role) : request.permissions || []
  if (!perms.includes(permission)) {
    throw new DomainError(ERROR_CODES.FORBIDDEN, `Requires '${permission}' permission`)
  }
}

async function adminAuthRoutes(fastify) {
  fastify.post(
    '/login',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Dashboard login (phone + password; operator roles only)',
        body: {
          type: 'object', required: ['phone', 'password'],
          properties: {
            phone: { type: 'string', minLength: 8, maxLength: 16 },
            password: { type: 'string', minLength: 8, maxLength: 128 },
          },
          additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    },
    async (request) => adminService.login({ ...request.body, request }),
  )
}

async function adminRoutes(fastify) {
  // ── Rides ops (spec 11 §4-§5) ──────────────────────────────────────
  fastify.get(
    '/rides',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Ride operations search/filter',
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            cityId: { type: 'string', format: 'uuid' },
            search: { type: 'string', maxLength: 60 },
            before: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          },
        },
      },
      preHandler: [fastify.authenticate, requirePermission('ride.read')],
    },
    async (request) => adminService.listRides(request.query),
  )

  fastify.get(
    '/rides/:rideId',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Ride detail: parties, timeline, offers, incidents, payment',
        params: { type: 'object', required: ['rideId'], properties: { rideId: { type: 'string', format: 'uuid' } } },
      },
      preHandler: [fastify.authenticate, requirePermission('ride.read')],
    },
    async (request) => adminService.getRideDetail(request.params.rideId),
  )

  fastify.post(
    '/rides/:rideId/cancel',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Admin cancellation (audited)',
        params: { type: 'object', required: ['rideId'], properties: { rideId: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object', required: ['reason'],
          properties: { reason: { type: 'string', maxLength: 500 } }, additionalProperties: false,
        },
      },
      preHandler: [fastify.authenticate, requirePermission('ride.cancel')],
    },
    async (request) => {
      const { RidesService } = await import('../rides/rides.service.js')
      const ride = await new RidesService().adminCancelRide({
        rideId: request.params.rideId,
        adminId: request.userId,
        reason: request.body.reason,
      })
      return { rideId: ride.id, status: ride.status }
    },
  )

  // ── Command center + live ops (spec 11 §2) ─────────────────────────
  fastify.get(
    '/command-center',
    {
      schema: { tags: ['Admin'], summary: 'Live KPIs for the command center' },
      preHandler: [fastify.authenticate, requirePermission('ride.read')],
    },
    async () => adminService.commandCenter(),
  )

  // ── Live ops snapshots (spec 09 §5 /admin/live/*) ──────────────────
  fastify.get(
    '/live/drivers',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Live driver snapshot for the fleet map (city/category scoped)',
        querystring: {
          type: 'object', required: ['cityId', 'vehicleCategoryId'],
          properties: {
            cityId: { type: 'string', format: 'uuid' },
            vehicleCategoryId: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: [fastify.authenticate, requirePermission('dispatch.read')],
    },
    async (request) => adminService.liveDrivers(request.query),
  )

  fastify.get(
    '/live/rides',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Active rides snapshot (searching → in-progress)',
        querystring: {
          type: 'object',
          properties: { cityId: { type: 'string', format: 'uuid' } },
        },
      },
      preHandler: [fastify.authenticate, requirePermission('dispatch.read')],
    },
    async (request) => adminService.liveRides(request.query),
  )

  // ── Reference data (city/category pickers for the fleet map) ───────
  fastify.get(
    '/reference/cities',
    {
      schema: { tags: ['Admin'], summary: 'Active cities (map filter)' },
      preHandler: [fastify.authenticate, requirePermission('city.read')],
    },
    async () => {
      const { query } = await import('../../config/database.js')
      const { rows } = await query(`SELECT id, name FROM cities WHERE is_active = true ORDER BY name`)
      return rows
    },
  )

  fastify.get(
    '/reference/categories',
    {
      schema: { tags: ['Admin'], summary: 'Active vehicle categories (map filter)' },
      preHandler: [fastify.authenticate, requirePermission('city.read')],
    },
    async () => {
      const { query } = await import('../../config/database.js')
      const { rows } = await query(`SELECT id, code, display_name FROM vehicle_categories WHERE is_active = true ORDER BY sort_order`)
      return rows
    },
  )

  // ── Drivers (spec 11 §6) ───────────────────────────────────────────
  fastify.get(
    '/drivers',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Driver list w/ approval + operational state',
        querystring: {
          type: 'object',
          properties: {
            approvalState: { type: 'string', enum: ['PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED', 'EXPIRED_DOCUMENTS'] },
            search: { type: 'string', maxLength: 60 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
      preHandler: [fastify.authenticate, requirePermission('driver.read')],
    },
    async (request) => adminService.listDrivers(request.query),
  )

  fastify.post(
    '/drivers/:driverId/approve',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Approve driver (audited, spec 05 §10)',
        params: { type: 'object', required: ['driverId'], properties: { driverId: { type: 'string', format: 'uuid' } } },
      },
      preHandler: [fastify.authenticate, requirePermission('driver.approve')],
    },
    async (request) => adminService.approveDriver({ driverId: request.params.driverId, operatorId: request.userId, approve: true }),
  )

  fastify.post(
    '/drivers/:driverId/suspend',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Suspend driver (audited, spec 05 §10)',
        params: { type: 'object', required: ['driverId'], properties: { driverId: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object', required: ['reason'],
          properties: { reason: { type: 'string', maxLength: 500 } }, additionalProperties: false,
        },
      },
      preHandler: [fastify.authenticate, requirePermission('driver.suspend')],
    },
    async (request) => {
      const result = await adminService.approveDriver({ driverId: request.params.driverId, operatorId: request.userId, approve: false })
      void request.body
      return result
    },
  )

  // ── Platform controls + system health (spec 11 §14/§15) ───────────
  fastify.get(
    '/platform',
    {
      schema: { tags: ['Admin'], summary: 'Platform settings (maintenance, min app versions)' },
      preHandler: [fastify.authenticate, requirePermission('platform.controls.write')],
    },
    async () => adminService.getPlatformSettings(),
  )

  fastify.patch(
    '/platform/:key',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Update a platform setting (audited)',
        params: { type: 'object', required: ['key'], properties: { key: { type: 'string', maxLength: 64 } } },
        body: { type: 'object' },
      },
      preHandler: [fastify.authenticate, requirePermission('platform.controls.write')],
    },
    async (request) => adminService.setPlatformSetting({ key: request.params.key, value: request.body, operatorId: request.userId }),
  )

  // ── Ola Maps connection (dashboard-managed provider key, spec 11 §10) ──

  fastify.get(
    '/platform/ola-maps',
    {
      schema: { tags: ['Admin'], summary: 'Ola Maps connection status (no secrets — masked key only)' },
      preHandler: [fastify.authenticate, requirePermission('platform.controls.write')],
    },
    async () => adminService.getOlaMapsStatus(),
  )

  fastify.post(
    '/platform/ola-maps/test',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Probe a candidate Ola Maps API key (nothing is saved)',
        body: {
          type: 'object', required: ['apiKey'],
          properties: { apiKey: { type: 'string', minLength: 8, maxLength: 256 } },
          additionalProperties: false,
        },
      },
      preHandler: [fastify.authenticate, requirePermission('platform.controls.write')],
    },
    async (request) => adminService.testOlaMapsKey({ apiKey: request.body.apiKey }),
  )

  fastify.put(
    '/platform/ola-maps',
    {
      schema: {
        tags: ['Admin'],
        summary: 'Test then save the Ola Maps key (saved ONLY when the live test passes; audited)',
        body: {
          type: 'object', required: ['apiKey'],
          properties: { apiKey: { type: 'string', minLength: 8, maxLength: 256 } },
          additionalProperties: false,
        },
      },
      preHandler: [fastify.authenticate, requirePermission('platform.controls.write')],
    },
    async (request) => adminService.connectOlaMaps({ apiKey: request.body.apiKey, operatorId: request.userId }),
  )

  fastify.delete(
    '/platform/ola-maps',
    {
      schema: { tags: ['Admin'], summary: 'Disconnect the stored Ola Maps key (audited)' },
      preHandler: [fastify.authenticate, requirePermission('platform.controls.write')],
    },
    async (request) => adminService.disconnectOlaMaps({ operatorId: request.userId }),
  )

  fastify.get(
    '/system-health',
    {
      schema: { tags: ['Admin'], summary: 'Read-only system health (no secrets)' },
      preHandler: [fastify.authenticate, requirePermission('dispatch.read')],
    },
    async () => adminService.systemHealth(),
  )
}

export default adminRoutes
export { adminAuthRoutes, adminRoutes, adminService }
