/**
 * BullMQ processor registry — keys must match queue names in config/bullmq.js.
 * All processors are idempotent (outbox delivery is at-least-once, spec 03 §11).
 */

import { logger } from '../config/logger.js'
import { runWave, processOfferExpiry } from '../modules/dispatch/dispatch.service.js'
import { publishRideEventFromOutbox } from '../modules/realtime/ride-event-publisher.js'
import { processGuardianCheck } from '../modules/safety/safety.service.js'
import { PROCESS_QUEUES } from '../config/bullmq.js'

/** Outbox envelope jobs: publish to socket rooms + side effects by type. */
async function processOutboxEnvelope(job) {
  const { eventType, aggregateType, aggregateId, payload } = job.data
  // Ride lifecycle events fan out to authorized rooms as versioned envelopes.
  if (aggregateType === 'RIDE') {
    await publishRideEventFromOutbox({ eventType, rideId: aggregateId, payload })
  }
  // Dispatch trigger: a created ride starts searching.
  if (eventType === 'RIDE_CREATED') {
    await runWave(payload.rideId, 0).catch((err) => {
      logger.error({ err, rideId: payload.rideId }, 'Initial dispatch wave failed')
    })
  }
}

export const PROCESSORS = Object.freeze({
  // Outbox poller routes RIDE_*/SAFETY_*/PAYMENT_* jobs here (general/safety
  // process types) — publish versioned envelopes to authorized rooms.
  outbox: processOutboxEnvelope,

  dispatch: async (job) => {
    switch (job.name) {
      case 'EXPIRE_OFFERS':
        return processOfferExpiry({ rideId: job.data.rideId, waveNumber: job.data.waveNumber })
      case 'RUN_WAVE':
        return runWave(job.data.rideId, job.data.waveNumber)
      case 'RIDE_CREATED':
        return runWave(job.data.rideId, 0)
      default:
        logger.warn({ jobName: job.name }, 'Unknown dispatch job')
    }
  },

  safety: async (job) => {
    switch (job.name) {
      case 'GUARDIAN_CHECK':
        return processGuardianCheck({ guardianSessionId: job.data.guardianSessionId })
      default:
        logger.warn({ jobName: job.name }, 'Unknown safety job')
    }
  },
})

void PROCESS_QUEUES
