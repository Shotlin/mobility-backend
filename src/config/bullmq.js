/**
 * BullMQ queues — Raahi spec 03 §3 (deployment units) and spec 06 §10
 * (queue backpressure requirements).
 *
 * Queue set mirrors the runtime process split so each worker type can be
 * deployed independently on its own nodes:
 *
 *   outbox           durable event publication (spec 03 §11)
 *   dispatch         ride searching → wave offers → expiry → no-driver-found
 *   notifications    FCM/SMS fanout (never on the request path)
 *   payments         webhook reconciliation, settlement, refunds follow-up
 *   location         sampled breadcrumb persistence (spec 04 §11)
 *   maintenance      retention sweeps, partition rotation, guardian escalation
 *   safety           evidence processing AFTER urgent incident creation (spec 10 §15)
 *
 * Every queue: bounded attempts, exponential backoff, retention on
 * complete AND failed so failed jobs stay inspectable.
 *
 * @module config/bullmq
 */

import { Queue } from 'bullmq'
import { env } from './env.js'
import { redisBull } from './redis.js'
import { logger } from './logger.js'

const connection = redisBull

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
}

function queue(name, opts = {}) {
  return new Queue(name, { connection, defaultJobOptions, ...opts })
}

export const outboxQueue = queue('outbox')
export const dispatchQueue = queue('dispatch', {
  defaultJobOptions: { ...defaultJobOptions, attempts: 5 },
})
export const notificationQueue = queue('notifications')
export const paymentsQueue = queue('payments', {
  defaultJobOptions: {
    ...defaultJobOptions,
    // Financial jobs get longer retention for auditability.
    removeOnFail: { age: 14 * 24 * 3600 },
  },
})
export const locationQueue = queue('location', {
  defaultJobOptions: { ...defaultJobOptions, attempts: 2, removeOnComplete: { age: 3600 } },
})
export const maintenanceQueue = queue('maintenance')
export const safetyQueue = queue('safety')

/** All domain queues — used by the worker runtime and health reporting. */
export const QUEUES = {
  outbox: outboxQueue,
  dispatch: dispatchQueue,
  notifications: notificationQueue,
  payments: paymentsQueue,
  location: locationQueue,
  maintenance: maintenanceQueue,
  safety: safetyQueue,
}

/**
 * Per-queue worker concurrency (spec 06 §10: queue-specific concurrency).
 * Tune with telemetry; small nodes must not run every queue at high fanout.
 */
export const WORKER_CONCURRENCY = Object.freeze({
  outbox: 10,
  dispatch: 5,
  notifications: 10,
  payments: 3,
  location: 5,
  maintenance: 1,
  safety: 5,
})

/**
 * Which queues a given process type consumes (spec 03 §3 deployment units).
 * The same repository starts different process types via WORKER_PROCESS env.
 */
export const PROCESS_QUEUES = Object.freeze({
  general: ['outbox', 'location', 'maintenance'],
  dispatch: ['dispatch'],
  notification: ['notifications'],
  payments: ['payments'],
  safety: ['safety'],
})

/**
 * Queue depth snapshot for health endpoints / dashboard system health
 * (spec 06 §10: every queue must expose waiting/active/oldest job age).
 */
export async function queueHealthSnapshot() {
  const snapshot = {}
  await Promise.all(
    Object.entries(QUEUES).map(async ([name, q]) => {
      try {
        const [waiting, active, failed] = await Promise.all([
          q.getWaitingCount(),
          q.getActiveCount(),
          q.getFailedCount(),
        ])
        snapshot[name] = { waiting, active, failed }
      } catch (err) {
        snapshot[name] = { error: err.message }
      }
    }),
  )
  return snapshot
}

logger.debug({ queues: Object.keys(QUEUES) }, 'BullMQ queues registered')
