/**
 * Payment routes (spec 09 §2) + the Razorpay webhook (spec 09 §17 —
 * registered OUTSIDE /api/v1, no auth, raw-body signature verification,
 * generic rate limits not relied on as security).
 */

import { createPaymentIntent, collectCash, handleRazorpayWebhook, createRefund } from './payments.service.js'
import { identityKey } from '../../plugins/rateLimit.plugin.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'
import { canonicalRole } from '../../utils/permissions.js'
import { query } from '../../config/database.js'
import { writeAuditLog } from '../../utils/audit-log.js'

const intentSchema = {
  type: 'object',
  properties: {
    paymentIntentId: { type: 'string' },
    rideId: { type: 'string' },
    method: { type: 'string' },
    status: { type: 'string' },
    amountPaise: { type: 'integer' },
    providerOrderId: { type: ['string', 'null'] },
  },
}

async function paymentRoutes(fastify) {
  // POST /api/v1/payments/create — online payment intent for a completed ride
  fastify.post(
    '/create',
    {
      schema: {
        tags: ['Payments'],
        summary: 'Create payment intent (idempotent, server-authoritative amount)',
        body: {
          type: 'object', required: ['rideId'],
          properties: { rideId: { type: 'string', format: 'uuid' } }, additionalProperties: false,
        },
        response: { 200: intentSchema },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: identityKey('payment-create') } },
      preHandler: [fastify.authenticate],
    },
    async (request) =>
      createPaymentIntent({
        rideId: request.body.rideId,
        userId: request.userId,
        actorRole: canonicalRole(request.roles?.[0]),
        idempotencyKey: request.headers['idempotency-key'],
      }),
  )

  // GET /api/v1/payments/:paymentId
  fastify.get(
    '/:paymentId',
    {
      schema: {
        tags: ['Payments'],
        summary: 'Payment status',
        params: { type: 'object', required: ['paymentId'], properties: { paymentId: { type: 'string', format: 'uuid' } } },
        response: { 200: intentSchema },
      },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const { rows } = await query(`SELECT * FROM payment_intents WHERE id = $1`, [request.params.paymentId])
      const intent = rows[0]
      if (!intent) throw new DomainError(ERROR_CODES.PAYMENT_NOT_FOUND)
      const role = canonicalRole(request.roles?.[0])
      if (role === 'PASSENGER') {
        const { rows: rideRows } = await query(`SELECT passenger_id FROM rides WHERE id = $1`, [intent.ride_id])
        if (rideRows[0]?.passenger_id !== request.userId) {
          throw new DomainError(ERROR_CODES.FORBIDDEN, 'Not your payment')
        }
      }
      return {
        paymentIntentId: intent.id,
        rideId: intent.ride_id,
        method: intent.method,
        status: intent.status,
        amountPaise: Number(intent.amount_paise),
        providerOrderId: intent.provider_order_id,
      }
    },
  )

  // POST /api/v1/payments/rides/:rideId/cash-collected — driver ack
  fastify.post(
    '/rides/:rideId/cash-collected',
    {
      schema: {
        tags: ['Payments'],
        summary: 'Driver acknowledges cash collection',
        params: { type: 'object', required: ['rideId'], properties: { rideId: { type: 'string', format: 'uuid' } } },
        response: { 200: intentSchema },
      },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const role = canonicalRole(request.roles?.[0])
      if (role !== 'DRIVER') throw new DomainError(ERROR_CODES.FORBIDDEN, 'Driver account required')
      return collectCash({ rideId: request.params.rideId, driverId: request.userId })
    },
  )
}

/**
 * Webhook mount — NO auth, rawBody required, no generic rate limit
 * (Razorpay retries; the signature + dedupe are the security).
 */
async function razorpayWebhookRoutes(fastify) {
  fastify.post(
    '/',
    {
      schema: { tags: ['Webhooks'], summary: 'Razorpay webhook (raw-body signature verified)' },
      config: { rawBody: true, rateLimit: false },
    },
    async (request, reply) => {
      try {
        const result = await handleRazorpayWebhook({
          rawBody: request.rawBody,
          signature: request.headers['x-razorpay-signature'],
        })
        return reply.code(200).send({ ok: true, ...result })
      } catch (err) {
        if (err.name === 'DomainError' && err.code === ERROR_CODES.WEBHOOK_SIGNATURE_INVALID) {
          return reply.code(401).send({ ok: false, code: err.code })
        }
        // 500 → provider retries; dedupe keeps it safe.
        throw err
      }
    },
  )

  void writeAuditLog
}

export default paymentRoutes
export { razorpayWebhookRoutes }
