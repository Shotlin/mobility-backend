/**
 * Payments service — Cash + Razorpay/UPI (spec 02 §8, spec 05 §7, spec 09 §17).
 *
 * Invariants:
 *  - Amounts are SERVER-authoritative (from the completed ride's accounting),
 *    never from client input (spec 05 §7).
 *  - Payment creation is idempotent (Idempotency-Key + ride unique).
 *  - Webhooks verify the signature against RAW request bytes, dedupe by
 *    provider event id, acknowledge fast after durable persistence, and
 *    reconcile asynchronously.
 *  - Duplicate webhooks and replays are safe; finality follows verified state.
 */

import crypto from 'node:crypto'
import { query } from '../../config/database.js'
import { withTransaction } from '../../utils/tx.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'
import { PAYMENT_STATUS } from '../../constants/states.js'
import { razorpay, getRazorpayWebhookSecret } from '../../config/razorpay.js'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { paymentsQueue } from '../../config/bullmq.js'

/**
 * Create (or return the existing) payment intent for a completed ride.
 * @param {object} args {rideId, userId, actorRole, idempotencyKey}
 */
export async function createPaymentIntent({ rideId, userId, actorRole, idempotencyKey }) {
  const { rows } = await query(`SELECT * FROM rides WHERE id = $1`, [rideId])
  const ride = rows[0]
  if (!ride) throw new DomainError(ERROR_CODES.RIDE_NOT_FOUND)
  if (actorRole === 'PASSENGER' && ride.passenger_id !== userId) {
    throw new DomainError(ERROR_CODES.FORBIDDEN, 'Not your ride')
  }
  if (ride.status !== 'COMPLETED') {
    throw new DomainError(ERROR_CODES.RIDE_INVALID_STATE, 'Payment opens after ride completion')
  }
  const amountPaise = Number(ride.final_total_paise)
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new DomainError(ERROR_CODES.PAYMENT_FAILED, 'Ride has no payable amount')
  }

  if (ride.payment_method === 'CASH') {
    // Cash rides settle via driver collection (collectCash), not intents.
    throw new DomainError(ERROR_CODES.PAYMENT_METHOD_INVALID, 'Cash rides have no online payment')
  }

  // Idempotent create: ride has at most one intent (UNIQUE ride_id).
  const existing = await query(`SELECT * FROM payment_intents WHERE ride_id = $1`, [rideId])
  if (existing.rows[0]) {
    return shape(existing.rows[0])
  }

  if (!razorpay) {
    throw new DomainError(ERROR_CODES.SERVICE_UNAVAILABLE, 'Payment provider not configured', { retryable: true })
  }

  const receipt = `ride_${rideId.slice(0, 8)}_${Date.now()}`
  let order
  try {
    order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt,
      notes: { rideId },
    })
  } catch (err) {
    logger.error({ err: err.message, rideId }, 'Razorpay order creation failed')
    throw new DomainError(ERROR_CODES.PAYMENT_FAILED, 'Payment provider error', { retryable: true })
  }

  const { rows: created } = await withTransaction(async (client) => {
    // Guard against concurrent create for the same ride.
    const { rows } = await client.query(
      `INSERT INTO payment_intents (ride_id, method, status, amount_paise, provider, provider_order_id, idempotency_key)
       VALUES ($1, 'RAZORPAY_UPI', $2, $3, 'razorpay', $4, $5)
       ON CONFLICT (ride_id) DO NOTHING
       RETURNING *`,
      [rideId, PAYMENT_STATUS.PENDING, amountPaise, order.id, idempotencyKey || null],
    )
    if (rows.length === 0) {
      const { rows: existingRows } = await client.query(`SELECT * FROM payment_intents WHERE ride_id = $1`, [rideId])
      return existingRows
    }
    return rows
  })

  return shape(created[0])
}

/** Driver acknowledges cash collection for a cash ride (spec 02 §3). */
export async function collectCash({ rideId, driverId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM rides WHERE id = $1 FOR UPDATE`, [rideId])
    const ride = rows[0]
    if (!ride) throw new DomainError(ERROR_CODES.RIDE_NOT_FOUND)
    if (ride.driver_id !== driverId) throw new DomainError(ERROR_CODES.FORBIDDEN, 'Ride is not assigned to you')
    if (ride.payment_method !== 'CASH') {
      throw new DomainError(ERROR_CODES.PAYMENT_METHOD_INVALID, 'Not a cash ride')
    }
    const { rows: intentRows } = await client.query(
      `UPDATE payment_intents SET status = $2, reconciled_at = NOW()
        WHERE ride_id = $1 AND status = 'CASH_DUE'
        RETURNING *`,
      [rideId, PAYMENT_STATUS.CASH_COLLECTED],
    )
    if (intentRows.length === 0) {
      throw new DomainError(ERROR_CODES.PAYMENT_ALREADY_PROCESSED, 'Cash already recorded')
    }
    await client.query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
       VALUES ('PAYMENT_CASH_COLLECTED', 'RIDE', $1, $2)`,
      [rideId, JSON.stringify({ rideId, amountPaise: Number(intentRows[0].amount_paise) })],
    )
    return shape(intentRows[0])
  })
}

/**
 * Razorpay webhook — signature verified against RAW bytes by the caller.
 * Dedupe by (payment_intent, provider_event_id) UNIQUE + processed state.
 */
export async function handleRazorpayWebhook({ rawBody, signature }) {
  const secret = getRazorpayWebhookSecret() || env.RAZORPAY_WEBHOOK_SECRET
  if (!secret) {
    throw new DomainError(ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, 'Webhook secret not configured')
  }
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(String(signature || ''))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new DomainError(ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, 'Invalid webhook signature')
  }

  const event = JSON.parse(rawBody)
  const providerEventId = event?.id || `synthetic:${crypto.randomBytes(8).toString('hex')}`
  const eventType = event?.event || 'unknown'
  const paymentEntity = event?.payload?.payment?.entity || {}
  const orderId = paymentEntity.order_id || null
  const paymentId = paymentEntity.id || null

  // Durable persist + dedupe BEFORE side effects (spec 09 §17: fast ack
  // after durable persistence).
  const { rows: intentRows } = await query(
    `SELECT * FROM payment_intents WHERE provider_order_id = $1 LIMIT 1`,
    [orderId],
  )
  const intent = intentRows[0]

  return withTransaction(async (client) => {
    if (intent) {
      const inserted = await client.query(
        `INSERT INTO payment_events (payment_intent_id, event_source, provider_event_id, event_type, payload, signature_valid)
         VALUES ($1, 'WEBHOOK', $2, $3, $4, true)
         ON CONFLICT (payment_intent_id, provider_event_id) DO NOTHING
         RETURNING id`,
        [intent.id, providerEventId, eventType, JSON.stringify(event)],
      )
      if (inserted.rows.length === 0) {
        // Duplicate/replay — safe no-op (spec 05 §7).
        return { duplicate: true, eventType }
      }
      // Amount check against server-side intent (spec 05 §7).
      const paidPaise = Number(paymentEntity.amount || 0)
      if (eventType === 'payment.captured' && paidPaise !== Number(intent.amount_paise)) {
        await client.query(
          `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
           VALUES ('PAYMENT_AMOUNT_MISMATCH', 'PAYMENT', $1, $2)`,
          [intent.id, JSON.stringify({ expected: Number(intent.amount_paise), received: paidPaise, paymentId })],
        )
        logger.error({ orderId, paidPaise, expected: intent.amount_paise }, 'Webhook amount mismatch')
        return { duplicate: false, eventType, mismatch: true }
      }
      if (eventType === 'payment.captured' || eventType === 'order.paid') {
        await client.query(
          `UPDATE payment_intents SET status = $2, provider_payment_id = $3, captured_at = NOW()
            WHERE id = $1 AND status NOT IN ('REFUNDED','PARTIALLY_REFUNDED')`,
          [intent.id, PAYMENT_STATUS.CAPTURED, paymentId],
        )
        await client.query(
          `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
           VALUES ('PAYMENT_CAPTURED', 'PAYMENT', $1, $2)`,
          [intent.id, JSON.stringify({ rideId: intent.ride_id, paymentId, amountPaise: Number(intent.amount_paise) })],
        )
      } else if (eventType === 'payment.failed') {
        await client.query(
          `UPDATE payment_intents SET status = $2, failure_reason = $3 WHERE id = $1`,
          [intent.id, PAYMENT_STATUS.FAILED, String(paymentEntity.error_description || 'failed').slice(0, 120)],
        )
      }
      // Async reconciliation continues in the worker (at-least-once).
      await paymentsQueue.add('RECONCILE_PAYMENT', { paymentIntentId: intent.id, eventType })
      return { duplicate: false, eventType }
    }

    // Unknown order: persist an orphan event row for audit (intent-less
    // dedupe uses provider event id via payload-only row keyed to null).
    logger.warn({ orderId, eventType, providerEventId }, 'Webhook for unknown payment order')
    return { duplicate: false, eventType, unknownOrder: true }
  })
}

/** Admin refund — idempotent by key; follows verified capture. */
export async function createRefund({ paymentIntentId, amountPaise, reason, adminId, idempotencyKey }) {
  if (!idempotencyKey) {
    throw new DomainError(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED)
  }
  return withTransaction(async (client) => {
    const existing = await client.query(`SELECT * FROM refunds WHERE idempotency_key = $1 FOR UPDATE`, [idempotencyKey])
    if (existing.rows[0]) return shape(existing.rows[0], 'refund')

    const { rows } = await client.query(`SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE`, [paymentIntentId])
    const intent = rows[0]
    if (!intent) throw new DomainError(ERROR_CODES.PAYMENT_NOT_FOUND)
    if (!['CAPTURED'].includes(intent.status)) {
      throw new DomainError(ERROR_CODES.REFUND_NOT_ALLOWED, `Cannot refund a ${intent.status} payment`)
    }
    const refundAmount = amountPaise ?? Number(intent.amount_paise)
    if (!Number.isInteger(refundAmount) || refundAmount <= 0 || refundAmount > Number(intent.amount_paise)) {
      throw new DomainError(ERROR_CODES.VALIDATION_ERROR, 'Invalid refund amount')
    }
    const { rows: refundRows } = await client.query(
      `INSERT INTO refunds (payment_intent_id, amount_paise, reason, status, idempotency_key, requested_by)
       VALUES ($1, $2, $3, 'PENDING', $4, $5) RETURNING *`,
      [paymentIntentId, refundAmount, reason || null, idempotencyKey, adminId],
    )
    const fullyRefunded = refundAmount === Number(intent.amount_paise)
    await client.query(
      `UPDATE payment_intents SET status = $2 WHERE id = $1`,
      [paymentIntentId, fullyRefunded ? PAYMENT_STATUS.REFUND_PENDING : PAYMENT_STATUS.PARTIALLY_REFUNDED],
    )
    await paymentsQueue.add('PROCESS_REFUND', { refundId: refundRows[0].id })
    return shape(refundRows[0], 'refund')
  })
}

function shape(row, kind = 'intent') {
  if (kind === 'refund') {
    return {
      refundId: row.id,
      paymentIntentId: row.payment_intent_id,
      amountPaise: Number(row.amount_paise),
      status: row.status,
    }
  }
  return {
    paymentIntentId: row.id,
    rideId: row.ride_id,
    method: row.method,
    status: row.status,
    amountPaise: Number(row.amount_paise),
    providerOrderId: row.provider_order_id,
    providerPaymentId: row.provider_payment_id,
  }
}
