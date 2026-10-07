/**
 * Worker runtime — Raahi spec 03 §3 deployment units.
 *
 * One repository starts different process types via WORKER_PROCESS:
 *   general | dispatch | notification | payments | safety | all
 *
 * Each process consumes only its queues (config/bullmq.js PROCESS_QUEUES).
 * Handlers are registered in workers/processors.js; queues without a
 * registered processor are skipped with a warning so process types can
 * boot before their phase lands.
 *
 * Spec 03 §16: workers must stop fetching new jobs, finish in-flight jobs,
 * and close connections on SIGTERM.
 */

import { Worker } from 'bullmq'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { PROCESS_QUEUES, QUEUES, WORKER_CONCURRENCY } from '../config/bullmq.js'
import { redisBull } from '../config/redis.js'
import { PROCESSORS } from '../workers/processors.js'

/** @type {Map<string, import('bullmq').Worker>} */
const activeWorkers = new Map()
/** @type {ReturnType<typeof setInterval> | null} */
let outboxPollerTimer = null

/**
 * Route an outbox event type to its BullMQ queue. Pure so it is unit
 * testable; safety/notifications/payments get their own capacity budgets
 * (spec 10 §15 — a notification backlog must never delay an SOS).
 */
export function routeOutboxEvent(eventType) {
  const type = String(eventType || '').toUpperCase()
  if (type.startsWith('NOTIFICATION') || type.startsWith('PUSH')) return 'notifications'
  if (type.startsWith('PAYMENT') || type.startsWith('REFUND') || type.startsWith('SETTLEMENT')) return 'payments'
  if (type.startsWith('SAFETY') || type.startsWith('SOS') || type.startsWith('GUARDIAN')) return 'safety'
  if (type.startsWith('RIDE') || type.startsWith('DISPATCH') || type.startsWith('OFFER')) return 'dispatch'
  return 'general'
}

/**
 * Outbox poller — moves durable outbox_events rows into BullMQ queues.
 * Spec 03 §11: DB commit + outbox insert happen in the same transaction;
 * a worker publishes at-least-once. Consumers must be idempotent.
 * The poller runs in every worker process type (cheap; SELECT ... FOR UPDATE
 * SKIP LOCKED keeps concurrent pollers safe).
 */
async function pollOutbox(client) {
  const { rows: events } = await client.query(
    `SELECT id, event_type, aggregate_type, aggregate_id, payload, correlation_id
       FROM outbox_events
      WHERE published_at IS NULL
      ORDER BY created_at
      LIMIT 50
      FOR UPDATE SKIP LOCKED`,
  )
  if (events.length === 0) return

  for (const event of events) {
    const target = routeOutboxEvent(event.event_type)

    try {
      const queue = target === 'general' ? QUEUES.outbox : QUEUES[target]
      await queue.add(
        event.event_type,
        {
          outboxId: event.id,
          eventType: event.event_type,
          aggregateType: event.aggregate_type,
          aggregateId: event.aggregate_id,
          payload: event.payload,
          correlationId: event.correlation_id,
        },
        { jobId: `outbox:${event.id}` }, // dedupe replays of the same row
      )
      await client.query('UPDATE outbox_events SET published_at = NOW() WHERE id = $1', [event.id])
    } catch (err) {
      logger.error({ err, outboxId: event.id }, 'Failed to publish outbox event')
    }
  }
}

function startOutboxPoller(pool) {
  if (outboxPollerTimer) return
  outboxPollerTimer = setInterval(async () => {
    let client
    try {
      client = await pool.connect()
      await pollOutbox(client)
    } catch (err) {
      // Outbox table may not exist yet in early phases — stay quiet at debug.
      logger.debug({ err: err.message }, 'Outbox poll cycle failed')
    } finally {
      if (client) client.release()
    }
  }, 1000)
  outboxPollerTimer.unref()
  logger.info('Outbox poller started (1s interval)')
}

/**
 * Start every queue worker for this process type.
 * @param {import('pg').Pool} pool
 * @param {string} [processType] override for WORKER_PROCESS env
 */
export function startWorkerRuntime(pool, processType) {
  const type = processType || env.WORKER_PROCESS || 'general'
  const queueNames = PROCESS_QUEUES[type]
  if (!queueNames) {
    throw new Error(`Unknown WORKER_PROCESS '${type}' (expected one of ${Object.keys(PROCESS_QUEUES).join(', ')}, all)`)
  }

  const names = type === 'all' ? Object.keys(QUEUES) : queueNames

  for (const name of names) {
    const processor = PROCESSORS[name]
    if (!processor) {
      logger.warn({ queue: name }, 'No processor registered yet — skipping worker for this queue')
      continue
    }
    const worker = new Worker(name, processor, {
      connection: redisBull,
      concurrency: WORKER_CONCURRENCY[name] ?? 5,
    })
    worker.on('failed', (job, err) => {
      logger.error({ err, queue: name, jobId: job?.id, attempts: job?.attemptsMade }, 'Job failed')
    })
    worker.on('completed', (job) => {
      logger.debug({ queue: name, jobId: job.id }, 'Job completed')
    })
    activeWorkers.set(name, worker)
  }

  startOutboxPoller(pool)
  logger.info({ processType: type, queues: Object.keys(activeWorkers) }, 'Worker runtime started')

  return activeWorkers
}

/** Graceful shutdown for workers (spec 03 §16 steps 5-7). */
export async function closeWorkerRuntime() {
  if (outboxPollerTimer) {
    clearInterval(outboxPollerTimer)
    outboxPollerTimer = null
  }
  await Promise.allSettled(
    Array.from(activeWorkers.values()).map((worker) => worker.close()),
  )
  activeWorkers.clear()
  logger.info('Worker runtime closed')
}
