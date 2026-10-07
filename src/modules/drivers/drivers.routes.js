/**
 * Driver routes (spec 09 §4): /drivers/me profile + online/offline, and
 * the driver ride command surface /rides/:rideId/{accept,decline,arrived,
 * verify-pin,start,complete}. All require DRIVER role.
 */

import { DriverRideService } from './driver-ride.service.js'
import { query } from '../../config/database.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'
import { canonicalRole } from '../../utils/permissions.js'

const driverRideService = new DriverRideService()

async function requireDriver(request) {
  const role = canonicalRole(request.roles?.[0])
  if (role !== 'DRIVER') {
    throw new DomainError(ERROR_CODES.FORBIDDEN, 'Driver account required')
  }
  return request.userId
}

async function driverProfileRoutes(fastify) {
  fastify.get(
    '/me',
    {
      schema: {
        tags: ['Drivers'],
        summary: 'Driver profile + eligibility state',
        // No response schema here: `{ type: 'object' }` with no properties
        // makes fast-json-stringify strip EVERY field (ships `{}`).
      },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const driverId = await requireDriver(request)
      const { rows } = await query(
        `SELECT dp.user_id, dp.approval_state, dp.operational_state, dp.total_rides,
                dp.rating_sum, dp.rating_count, dp.active_vehicle_id,
                u.full_name, u.phone_e164,
                v.registration_number, v.model, vc.display_name AS category_name
           FROM driver_profiles dp
           JOIN users u ON u.id = dp.user_id
           LEFT JOIN vehicles v ON v.id = dp.active_vehicle_id
           LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
          WHERE dp.user_id = $1`,
        [driverId],
      )
      if (rows.length === 0) throw new DomainError(ERROR_CODES.DRIVER_NOT_FOUND)
      const r = rows[0]
      return {
        driverId: r.user_id,
        fullName: r.full_name,
        phone: r.phone_e164,
        approvalState: r.approval_state,
        operationalState: r.operational_state,
        totalRides: r.total_rides,
        rating: r.rating_count > 0 ? Number((r.rating_sum / r.rating_count).toFixed(2)) : null,
        vehicle: r.active_vehicle_id
          ? { registrationNumber: r.registration_number, model: r.model, category: r.category_name }
          : null,
      }
    },
  )

  fastify.post(
    '/me/online',
    {
      schema: {
        tags: ['Drivers'],
        summary: 'Go online (requires approval + active vehicle)',
        body: {
          type: 'object',
          properties: {
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lng: { type: 'number', minimum: -180, maximum: 180 },
          },
          additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const driverId = await requireDriver(request)
      return driverRideService.online({ driverId, lat: request.body?.lat, lng: request.body?.lng })
    },
  )

  fastify.patch(
    '/me',
    {
      schema: {
        tags: ['Drivers'],
        summary: 'Update driver-editable profile fields',
        body: {
          type: 'object',
          properties: {
            fullName: { type: 'string', minLength: 1, maxLength: 120 },
            payoutUpiVpa: { type: 'string', maxLength: 120 },
          },
          additionalProperties: false,
          minProperties: 1,
        },
      },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const role = canonicalRole(request.roles?.[0])
      if (role !== 'DRIVER') throw new DomainError(ERROR_CODES.FORBIDDEN, 'Driver account required')
      const { query } = await import('../../config/database.js')
      const b = request.body
      if (b.fullName) {
        await query(`UPDATE users SET full_name = $2 WHERE id = $1`, [request.userId, b.fullName])
      }
      if (b.payoutUpiVpa) {
        await query(`UPDATE driver_profiles SET payout_upi_vpa = $2 WHERE user_id = $1`, [request.userId, b.payoutUpiVpa])
      }
      const { rows } = await query(
        `SELECT u.full_name, u.phone_e164, dp.payout_upi_vpa FROM users u
           JOIN driver_profiles dp ON dp.user_id = u.id WHERE u.id = $1`,
        [request.userId],
      )
      return { fullName: rows[0].full_name, phone: rows[0].phone_e164, payoutUpiVpa: rows[0].payout_upi_vpa }
    },
  )

  fastify.post(
    '/me/offline',
    {
      schema: { tags: ['Drivers'], summary: 'Go offline' },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const driverId = await requireDriver(request)
      return driverRideService.offline({ driverId })
    },
  )
}

const uuidParam = (name) => ({
  type: 'object',
  required: [name],
  properties: { [name]: { type: 'string', format: 'uuid' } },
})

async function driverRideRoutes(fastify) {
  const driverOnly = async (request) => {
    await requireDriver(request)
  }

  fastify.post(
    '/:rideId/accept',
    {
      schema: {
        tags: ['DriverRides'],
        summary: 'Accept an expiring offer (atomic claim, spec 04 §14)',
        params: uuidParam('rideId'),
        body: {
          type: 'object', required: ['offerId'],
          properties: { offerId: { type: 'string', format: 'uuid' } }, additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: (req) => `rl:driver:${req.userId}:ride-accept` } },
      preHandler: [fastify.authenticate, driverOnly],
    },
    async (request) =>
      driverRideService.accept({
        rideId: request.params.rideId,
        offerId: request.body.offerId,
        driverId: request.userId,
      }),
  )

  fastify.post(
    '/:rideId/decline',
    {
      schema: {
        tags: ['DriverRides'],
        summary: 'Decline an offer',
        params: uuidParam('rideId'),
        body: {
          type: 'object', required: ['offerId'],
          properties: { offerId: { type: 'string', format: 'uuid' } }, additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      preHandler: [fastify.authenticate, driverOnly],
    },
    async (request) =>
      driverRideService.decline({
        rideId: request.params.rideId,
        offerId: request.body.offerId,
        driverId: request.userId,
      }),
  )

  fastify.post(
    '/:rideId/arrived',
    {
      schema: { tags: ['DriverRides'], summary: 'Mark arrival at pickup', params: uuidParam('rideId') },
      preHandler: [fastify.authenticate, driverOnly],
    },
    async (request) => driverRideService.arrived({ rideId: request.params.rideId, driverId: request.userId }),
  )

  fastify.post(
    '/:rideId/verify-pin',
    {
      schema: {
        tags: ['DriverRides'],
        summary: 'Verify trip PIN (attempt-limited; never echoes expected PIN)',
        params: uuidParam('rideId'),
        body: {
          type: 'object', required: ['pin'],
          properties: { pin: { type: 'string', pattern: '^[0-9]{4}$' } }, additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
      preHandler: [fastify.authenticate, driverOnly],
    },
    async (request) =>
      driverRideService.verifyPin({
        rideId: request.params.rideId,
        driverId: request.userId,
        pin: request.body.pin,
      }),
  )

  fastify.post(
    '/:rideId/start',
    {
      schema: { tags: ['DriverRides'], summary: 'Start trip (requires server-verified PIN)', params: uuidParam('rideId') },
      preHandler: [fastify.authenticate, driverOnly],
    },
    async (request) => driverRideService.start({ rideId: request.params.rideId, driverId: request.userId }),
  )

  fastify.post(
    '/:rideId/complete',
    {
      schema: {
        tags: ['DriverRides'],
        summary: 'Complete trip — returns server-authoritative earning',
        params: uuidParam('rideId'),
      },
      preHandler: [fastify.authenticate, driverOnly],
    },
    async (request) => driverRideService.complete({ rideId: request.params.rideId, driverId: request.userId }),
  )
}

export default driverProfileRoutes
export { driverRideRoutes }

// ── Driver documents (spec 12 §3 onboarding) ─────────────────────────
async function driverDocumentRoutes(fastify) {
  fastify.get(
    '/me/documents',
    {
      schema: {
        tags: ['Drivers'],
        summary: 'List my KYC documents with status',
        response: { 200: { type: 'object', properties: { documents: { type: 'array' } } } },
      },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const role = canonicalRole(request.roles?.[0])
      if (role !== 'DRIVER') throw new DomainError(ERROR_CODES.FORBIDDEN, 'Driver account required')
      const { query } = await import('../../config/database.js')
      const { rows } = await query(
        `SELECT id, doc_type, status, expiry_date, rejection_reason, created_at
           FROM driver_documents WHERE driver_id = $1 ORDER BY created_at DESC`,
        [request.userId],
      )
      return {
        documents: rows.map((r) => ({
          id: r.id,
          docType: r.doc_type,
          status: r.status,
          expiryDate: r.expiry_date,
          rejectionReason: r.rejection_reason,
          createdAt: r.created_at,
        })),
      }
    },
  )

  fastify.post(
    '/me/documents',
    {
      schema: {
        tags: ['Drivers'],
        summary: 'Upload a KYC document (multipart; private storage per spec 05 §6)',
        consumes: ['multipart/form-data'],
        body: {
          type: 'object',
          properties: {
            docType: { type: 'string', enum: ['SELFIE', 'DRIVING_LICENCE', 'VEHICLE_RC', 'INSURANCE', 'PUC', 'BANK_OR_UPI'] },
            documentNumber: { type: 'string', maxLength: 40 },
            expiryDate: { type: 'string', format: 'date' },
          },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const role = canonicalRole(request.roles?.[0])
      if (role !== 'DRIVER') throw new DomainError(ERROR_CODES.FORBIDDEN, 'Driver account required')
      const data = await request.file({ limits: { fileSize: 5 * 1024 * 1024 } })
      if (!data) throw new DomainError(ERROR_CODES.VALIDATION_ERROR, 'File required')
      if (!data.mimetype.startsWith('image/')) {
        throw new DomainError(ERROR_CODES.VALIDATION_ERROR, 'Only image uploads are accepted')
      }
      const fields = data.fields || {}
      const docType = fields.docType?.value
      const documentNumber = fields.documentNumber?.value || null
      const expiryDate = fields.expiryDate?.value || null
      const { DRIVER_DOCUMENT_TYPES } = await import('../../constants/states.js')
      if (!DRIVER_DOCUMENT_TYPES.includes(docType)) {
        throw new DomainError(ERROR_CODES.VALIDATION_ERROR, 'Invalid docType')
      }

      // Private object storage (spec 05 §6): Cloudinary via the kept util.
      const { uploadImageWithCloudinaryFallback } = await import('../../utils/cloudinary-upload.js')
      const buffer = await data.toBuffer()
      const { Readable } = await import('node:stream')
      const upload = await uploadImageWithCloudinaryFallback(Readable.from(buffer), {
        folder: `raahi/kyc/${request.userId}`,
        resourceType: 'image',
      }).catch((err) => {
        request.log.error({ err }, 'KYC upload to private storage failed')
        throw new DomainError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Document storage unavailable', { retryable: true })
      })

      const { query } = await import('../../config/database.js')
      const { rows } = await query(
        `INSERT INTO driver_documents (driver_id, doc_type, storage_provider, storage_public_id, document_number_enc, expiry_date, status)
         VALUES ($1, $2, 'cloudinary', $3, $4, $5, 'PENDING')
         ON CONFLICT (driver_id, doc_type, coalesce(vehicle_id, '00000000-0000-0000-0000-000000000000'::uuid))
           DO UPDATE SET storage_public_id = $3, document_number_enc = $4, expiry_date = $5,
             status = 'PENDING', reviewer_user_id = NULL, reviewed_at = NULL, rejection_reason = NULL
         RETURNING id, doc_type, status`,
        [request.userId, docType, upload.publicId ?? null, documentNumber, expiryDate],
      )
      return reply.code(201).send({ document: { id: rows[0].id, docType: rows[0].doc_type, status: rows[0].status } })
    },
  )
}

export { driverDocumentRoutes }
