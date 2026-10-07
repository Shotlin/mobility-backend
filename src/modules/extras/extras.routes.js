/**
 * Ratings (spec 13 §14), driver earnings/payouts (spec 12 §13), support
 * tickets (spec 11 §13) — compact service endpoints completing the
 * backend API surface for V1.
 */

import fp from 'fastify-plugin'
import { query } from '../../config/database.js'
import { withTransaction } from '../../utils/tx.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'
import { canonicalRole } from '../../utils/permissions.js'
import { identityKey } from '../../plugins/rateLimit.plugin.js'

async function requireRole(request, ...roles) {
  const role = canonicalRole(request.roles?.[0])
  if (!roles.includes(role)) throw new DomainError(ERROR_CODES.FORBIDDEN, 'Not allowed for this actor')
  return request.userId
}

async function mobilityExtras(fastify) {
  // ── Ratings (one per direction per ride, DB-enforced) ────────────
  fastify.post(
    '/rides/:rideId/rating',
    {
      schema: {
        tags: ['Ratings'],
        summary: 'Rate the counterparty of a completed ride',
        params: { type: 'object', required: ['rideId'], properties: { rideId: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object', required: ['score'],
          properties: {
            score: { type: 'integer', minimum: 1, maximum: 5 },
            comment: { type: 'string', maxLength: 500 },
            tags: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 40 } },
          },
          additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const userId = await requireRole(request, 'PASSENGER', 'DRIVER')
      const role = canonicalRole(request.roles?.[0])
      const { rows: rideRows } = await query(`SELECT passenger_id, driver_id, status FROM rides WHERE id = $1`, [request.params.rideId])
      const ride = rideRows[0]
      if (!ride) throw new DomainError(ERROR_CODES.RIDE_NOT_FOUND)
      if (ride.status !== 'COMPLETED') throw new DomainError(ERROR_CODES.RATING_NOT_ALLOWED, 'Only completed rides can be rated')
      const isPassenger = role === 'PASSENGER'
      const rater = isPassenger ? ride.passenger_id : ride.driver_id
      const target = isPassenger ? ride.driver_id : ride.passenger_id
      if (rater !== userId) throw new DomainError(ERROR_CODES.FORBIDDEN, 'Not your ride')
      if (!target) throw new DomainError(ERROR_CODES.RATING_NOT_ALLOWED, 'No counterparty to rate')

      await withTransaction(async (client) => {
        const inserted = await client.query(
          `INSERT INTO ratings (ride_id, rater_id, rater_role, target_id, target_role, score, comment, tags)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (ride_id, rater_role) DO NOTHING RETURNING id`,
          [request.params.rideId, userId, role, target, isPassenger ? 'DRIVER' : 'PASSENGER',
           request.body.score, request.body.comment || null, JSON.stringify(request.body.tags || [])],
        )
        if (inserted.rows.length === 0) {
          throw new DomainError(ERROR_CODES.RATING_NOT_ALLOWED, 'Already rated this ride')
        }
        if (!isPassenger) {
          // Rating the passenger does not affect driver aggregates.
          return
        }
        await client.query(
          `UPDATE driver_profiles SET rating_sum = rating_sum + $2, rating_count = rating_count + 1 WHERE user_id = $1`,
          [target, request.body.score],
        )
      })
      return reply.code(201).send({ rated: true })
    },
  )

  // ── Driver earnings summary + payout history (spec 12 §13) ──────
  fastify.get(
    '/drivers/me/earnings',
    {
      schema: {
        tags: ['Drivers'],
        summary: 'Earnings summary (today/week/month + payout history)',
      },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const driverId = await requireRole(request, 'DRIVER')
      const { rows } = await query(
        `SELECT
           COALESCE(SUM(net_earning_paise) FILTER (WHERE created_at >= date_trunc('day', NOW())), 0) AS today,
           COALESCE(SUM(net_earning_paise) FILTER (WHERE created_at >= date_trunc('week', NOW())), 0) AS week,
           COALESCE(SUM(net_earning_paise) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0) AS month
         FROM driver_earnings WHERE driver_id = $1`,
        [driverId],
      )
      const { rows: ledger } = await query(
        `SELECT COALESCE(balance_after_paise, 0) AS balance FROM driver_ledger WHERE driver_id = $1 ORDER BY id DESC LIMIT 1`,
        [driverId],
      )
      const { rows: payouts } = await query(
        `SELECT id, amount_paise, status, method, created_at, completed_at
           FROM driver_payouts WHERE driver_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [driverId],
      )
      return {
        todayPaise: Number(rows[0].today),
        weekPaise: Number(rows[0].week),
        monthPaise: Number(rows[0].month),
        ledgerBalancePaise: Number(ledger[0]?.balance || 0),
        payouts: payouts.map((p) => ({ payoutId: p.id, amountPaise: Number(p.amount_paise), status: p.status, method: p.method, createdAt: p.created_at, completedAt: p.completed_at })),
      }
    },
  )

  // ── Support tickets (spec 11 §13) ────────────────────────────────
  fastify.post(
    '/support/tickets',
    {
      schema: {
        tags: ['Support'],
        summary: 'Create a support ticket (passenger or driver)',
        body: {
          type: 'object', required: ['category', 'subject', 'body'],
          properties: {
            category: { type: 'string', enum: ['RIDE_ISSUE', 'PAYMENT_ISSUE', 'SAFETY_CONCERN', 'ACCOUNT', 'OTHER'] },
            subject: { type: 'string', minLength: 4, maxLength: 160 },
            body: { type: 'string', minLength: 4, maxLength: 2000 },
            rideId: { type: 'string', format: 'uuid' },
          },
          additionalProperties: false,
        },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 hour', keyGenerator: identityKey('support-create') } },
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const userId = await requireRole(request, 'PASSENGER', 'DRIVER')
      const role = canonicalRole(request.roles?.[0])
      const ticketRows = await withTransaction(async (client) => {
        const { rows: inserted } = await client.query(
          `INSERT INTO support_tickets (actor_id, actor_type, ride_id, category, subject)
           VALUES ($1, $2, $3, $4, $5) RETURNING id, ticket_number`,
          [userId, role, request.body.rideId || null, request.body.category, request.body.subject],
        )
        await client.query(
          `INSERT INTO support_ticket_messages (ticket_id, author_id, author_role, body)
           VALUES ($1, $2, $3, $4)`,
          [inserted[0].id, userId, role, request.body.body],
        )
        return inserted
      })
      return reply.code(201).send({ ticketId: ticketRows[0].id, ticketNumber: Number(ticketRows[0].ticket_number) })
    },
  )

  fastify.get(
    '/support/tickets',
    {
      schema: { tags: ['Support'], summary: 'My support tickets', response: { 200: { type: 'object', properties: { tickets: { type: 'array' } } } } },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const userId = await requireRole(request, 'PASSENGER', 'DRIVER')
      const { rows } = await query(
        `SELECT id, ticket_number, category, subject, status, created_at FROM support_tickets
          WHERE actor_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [userId],
      )
      return {
        tickets: rows.map((r) => ({ ticketId: r.id, ticketNumber: Number(r.ticket_number), category: r.category, subject: r.subject, status: r.status, createdAt: r.created_at })),
      }
    },
  )
}

export default mobilityExtras
