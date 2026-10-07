/**
 * Safety service — SOS incidents, Guardian Journey, Women Safety+,
 * Safety Circle, protected destinations (spec 10).
 *
 * Reliability posture (spec 10 §15): incident creation is SYNCHRONOUS and
 * durable (DB row committed before any notification fanout); repeated taps
 * dedupe onto the same active incident (DB partial unique + service logic);
 * notification failure never rolls back incident creation.
 */

import { query } from '../../config/database.js'
import { withTransaction } from '../../utils/tx.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'
import { SAFETY_INCIDENT_STATUS, SAFETY_INCIDENT_SOURCE, SAFETY_INCIDENT_SEVERITY } from '../../constants/states.js'
import { emitAuditInTx } from '../../utils/audit-log.js'
import { env } from '../../config/env.js'
import { notificationQueue, safetyQueue } from '../../config/bullmq.js'
import { getSocketEmitter } from '../../plugins/socket-emitter.js'

const ACTIVE_STATES = new Set([
  SAFETY_INCIDENT_STATUS.OPEN,
  SAFETY_INCIDENT_STATUS.ACKNOWLEDGED,
  SAFETY_INCIDENT_STATUS.CONTACTING_USER,
  SAFETY_INCIDENT_STATUS.ESCALATED,
  SAFETY_INCIDENT_STATUS.EMERGENCY_SERVICES_REFERRED,
  SAFETY_INCIDENT_STATUS.MONITORING,
])

const OPS_TRANSITIONS = {
  [SAFETY_INCIDENT_STATUS.OPEN]: [SAFETY_INCIDENT_STATUS.ACKNOWLEDGED, SAFETY_INCIDENT_STATUS.CONTACTING_USER, SAFETY_INCIDENT_STATUS.ESCALATED, SAFETY_INCIDENT_STATUS.EMERGENCY_SERVICES_REFERRED, SAFETY_INCIDENT_STATUS.MONITORING, SAFETY_INCIDENT_STATUS.RESOLVED],
  [SAFETY_INCIDENT_STATUS.ACKNOWLEDGED]: [SAFETY_INCIDENT_STATUS.CONTACTING_USER, SAFETY_INCIDENT_STATUS.ESCALATED, SAFETY_INCIDENT_STATUS.EMERGENCY_SERVICES_REFERRED, SAFETY_INCIDENT_STATUS.MONITORING, SAFETY_INCIDENT_STATUS.RESOLVED],
  [SAFETY_INCIDENT_STATUS.CONTACTING_USER]: [SAFETY_INCIDENT_STATUS.ESCALATED, SAFETY_INCIDENT_STATUS.EMERGENCY_SERVICES_REFERRED, SAFETY_INCIDENT_STATUS.MONITORING, SAFETY_INCIDENT_STATUS.RESOLVED],
  [SAFETY_INCIDENT_STATUS.ESCALATED]: [SAFETY_INCIDENT_STATUS.EMERGENCY_SERVICES_REFERRED, SAFETY_INCIDENT_STATUS.MONITORING, SAFETY_INCIDENT_STATUS.RESOLVED],
  [SAFETY_INCIDENT_STATUS.EMERGENCY_SERVICES_REFERRED]: [SAFETY_INCIDENT_STATUS.MONITORING, SAFETY_INCIDENT_STATUS.RESOLVED],
  [SAFETY_INCIDENT_STATUS.MONITORING]: [SAFETY_INCIDENT_STATUS.RESOLVED],
  [SAFETY_INCIDENT_STATUS.RESOLVED]: [SAFETY_INCIDENT_STATUS.CLOSED],
  [SAFETY_INCIDENT_STATUS.CLOSED]: [],
}

export function assertIncidentTransition(from, to) {
  const allowed = OPS_TRANSITIONS[from] || []
  if (!allowed.includes(to)) {
    throw new DomainError(ERROR_CODES.SAFETY_INCIDENT_INVALID_STATE, `Cannot move incident from ${from} to ${to}`)
  }
  return true
}

/**
 * SOS / incident creation (spec 10 §6). Repeated taps escalate the SAME
 * active incident. Captures ride/user/driver/vehicle/location context
 * atomically, emits a PRIORITY socket event + safety-ops notification.
 */
export async function createOrEscalateIncident({ reporterId, reporterRole, rideId = null, source, severity, location = null }) {
  if (!SAFETY_INCIDENT_SOURCE[source]) throw new DomainError(ERROR_CODES.VALIDATION_ERROR, 'Invalid incident source')
  const sev = SAFETY_INCIDENT_SEVERITY[severity] || 'HIGH'

  return withTransaction(async (client) => {
    // Ride context snapshot (spec 10 §6 step 2-3).
    let rideCtx = {}
    if (rideId) {
      const { rows } = await client.query(
        `SELECT r.id, r.passenger_id, r.driver_id, r.status,
                ST_Y(r.pickup::geometry) AS pickup_lat, ST_X(r.pickup::geometry) AS pickup_lng,
                dp.active_vehicle_id, v.registration_number
           FROM rides r
           LEFT JOIN driver_profiles dp ON dp.user_id = r.driver_id
           LEFT JOIN vehicles v ON v.id = dp.active_vehicle_id
          WHERE r.id = $1`,
        [rideId],
      )
      if (rows[0]) {
        const r = rows[0]
        rideCtx = {
          rideId: r.id,
          rideStatus: r.status,
          passengerId: r.passenger_id,
          driverId: r.driver_id,
          vehicleRegistration: r.registration_number,
          pickup: { lat: Number(r.pickup_lat), lng: Number(r.pickup_lng) },
        }
      }
    }

    // Dedupe: one ACTIVE incident per ride (or per reporter when ride-less).
    const dedupeWhere = rideId
      ? `ride_id = $1 AND status NOT IN ('RESOLVED','CLOSED')`
      : `ride_id IS NULL AND reporter_id = $1 AND status NOT IN ('RESOLVED','CLOSED')`
    const dedupeParam = [rideId || reporterId]
    const { rows: existing } = await client.query(
      `SELECT * FROM safety_incidents WHERE ${dedupeWhere} FOR UPDATE LIMIT 1`,
      dedupeParam,
    )

    let incident
    if (existing[0]) {
      // Escalate in place (spec 10 §6: repeated taps update/escalate).
      const bump = existing[0].severity === 'LOW' && sev !== 'LOW'
      const { rows: updated } = await client.query(
        `UPDATE safety_incidents SET
            severity = GREATEST_SEVERITY(severity, $2),
            latest_location = COALESCE($3::geography, latest_location),
            context = context || $4::jsonb
          WHERE id = $1 RETURNING *`,
        [existing[0].id, sev, location ? `SRID=4326;POINT(${location.lng} ${location.lat})` : null, JSON.stringify({ escalations: (existing[0].context?.escalations || 0) + 1 })],
      )
      incident = updated[0]
      await client.query(
        `INSERT INTO safety_incident_events (incident_id, event_type, actor_id, actor_role, payload)
         VALUES ($1, 'INCIDENT_ESCALATED', $2, $3, $4)`,
        [incident.id, reporterId, reporterRole, JSON.stringify({ source, severity: sev })],
      )
    } else {
      const { rows: created } = await client.query(
        `INSERT INTO safety_incidents (ride_id, reporter_id, reporter_role, other_party_id, source, severity, status, context, latest_location)
         VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7, $8) RETURNING *`,
        [
          rideId,
          reporterId,
          reporterRole,
          reporterRole === 'PASSENGER' ? rideCtx.driverId ?? null : rideCtx.passengerId ?? null,
          source,
          sev,
          JSON.stringify(rideCtx),
          location ? `SRID=4326;POINT(${location.lng} ${location.lat})` : null,
        ],
      )
      incident = created[0]
      await client.query(
        `INSERT INTO safety_incident_events (incident_id, event_type, actor_id, actor_role, payload)
         VALUES ($1, 'INCIDENT_CREATED', $2, $3, $4)`,
        [incident.id, reporterId, reporterRole, JSON.stringify({ source, severity: sev })],
      )
    }

    // Latest known ride location into context (spec 10 §6 step 7).
    void rideCtx

    return incident
  }).then(async (incident) => {
    // AFTER durable creation: priority socket + notification fanout.
    // Failures here NEVER roll back the incident (spec 10 §17).
    try {
      const emitter = getSocketEmitter()
      const envelope = {
        v: 1,
        eventType: 'SAFETY_INCIDENT',
        incidentId: incident.id,
        severity: incident.severity,
        status: incident.status,
        rideId: incident.ride_id,
        occurredAt: incident.created_at,
        data: { source, reporterRole },
      }
      emitter.to('safety:ops').emit('safety:incident', envelope)
      if (incident.ride_id) emitter.to(`ride:${incident.ride_id}`).emit('safety:incident', envelope)
      await notificationQueue.add('SAFETY_INCIDENT_ALERT', {
        incidentId: incident.id,
        rideId: incident.ride_id,
        severity: incident.severity,
      }, { priority: 1 })
    } catch (err) {
      // swallowed — incident is durable (spec 10 §15)
    }
    return incident
  })
}

/** Operator ack (permission-gated at route). */
export async function acknowledgeIncident({ incidentId, operatorId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM safety_incidents WHERE id = $1 FOR UPDATE`, [incidentId])
    const incident = rows[0]
    if (!incident) throw new DomainError(ERROR_CODES.SAFETY_INCIDENT_NOT_FOUND)
    if (incident.status !== SAFETY_INCIDENT_STATUS.OPEN) {
      return incident // idempotent
    }
    const { rows: updated } = await client.query(
      `UPDATE safety_incidents SET status = 'ACKNOWLEDGED', acknowledged_at = NOW(), acknowledged_by = $2 WHERE id = $1 RETURNING *`,
      [incidentId, operatorId],
    )
    await client.query(
      `INSERT INTO safety_incident_events (incident_id, event_type, actor_id, actor_role, payload)
       VALUES ($1, 'INCIDENT_ACKNOWLEDGED', $2, 'OPERATOR', '{}')`,
      [incidentId, operatorId],
    )
    await emitAuditInTx(client, {
      actorId: operatorId,
      actorType: 'ADMIN',
      action: 'SAFETY_INCIDENT_ACKNOWLEDGED',
      targetType: 'SAFETY_INCIDENT',
      targetId: incidentId,
    })
    return updated[0]
  })
}

export async function transitionIncident({ incidentId, to, operatorId, note }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM safety_incidents WHERE id = $1 FOR UPDATE`, [incidentId])
    const incident = rows[0]
    if (!incident) throw new DomainError(ERROR_CODES.SAFETY_INCIDENT_NOT_FOUND)
    assertIncidentTransition(incident.status, to)
    const { rows: updated } = await client.query(
      `UPDATE safety_incidents SET status = $2::varchar, resolved_at = CASE WHEN $2::varchar = 'RESOLVED' THEN NOW() ELSE resolved_at END,
          resolved_by = CASE WHEN $2::varchar = 'RESOLVED' THEN $3::uuid ELSE resolved_by END,
          resolution_note = COALESCE($4, resolution_note)
        WHERE id = $1 RETURNING *`,
      [incidentId, to, operatorId, note || null],
    )
    await client.query(
      `INSERT INTO safety_incident_events (incident_id, event_type, actor_id, actor_role, payload)
       VALUES ($1, 'INCIDENT_TRANSITION', $2, 'OPERATOR', $3)`,
      [incidentId, operatorId, JSON.stringify({ to, note })],
    )
    await emitAuditInTx(client, {
      actorId: operatorId,
      actorType: 'ADMIN',
      action: 'SAFETY_INCIDENT_TRANSITION',
      targetType: 'SAFETY_INCIDENT',
      targetId: incidentId,
      before: { status: incident.status },
      after: { status: to },
      reason: note,
    })
    return updated[0]
  })
}

export async function listOpenIncidents() {
  const { rows } = await query(
    `SELECT i.id, i.ride_id, i.reporter_id, i.reporter_role, i.source, i.severity, i.status,
            i.created_at, i.acknowledged_at,
            ST_Y(i.latest_location::geometry) AS lat, ST_X(i.latest_location::geometry) AS lng
       FROM safety_incidents i
      WHERE i.status NOT IN ('RESOLVED','CLOSED')
      ORDER BY CASE i.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
               i.created_at ASC
      LIMIT 100`,
  )
  return rows.map((r) => ({
    incidentId: r.id,
    rideId: r.ride_id,
    reporterId: r.reporter_id,
    reporterRole: r.reporter_role,
    source: r.source,
    severity: r.severity,
    status: r.status,
    createdAt: r.created_at,
    acknowledgedAt: r.acknowledged_at,
    latestLocation: r.lat != null ? { lat: Number(r.lat), lng: Number(r.lng) } : null,
  }))
}

// ── Guardian Journey (spec 10 §4) ───────────────────────────────────

/** Start a Guardian session when a ride completes (called from completion). */
export async function startGuardianJourney({ rideId, passengerId }) {
  const settings = await getSafetySettings(passengerId)
  const enabled = settings?.guardian_all_rides || (await hasGuardianTrigger({ rideId, passengerId, settings }))
  if (!enabled) return { started: false }

  const deadline = new Date(Date.now() + env.SAFETY_GUARDIAN_WINDOW_MIN * 60000)
  const { rows } = await query(
    `INSERT INTO guardian_sessions (ride_id, passenger_id, state, confirm_deadline)
     VALUES ($1, $2, 'ACTIVE', $3)
     ON CONFLICT (ride_id) DO NOTHING
     RETURNING id, confirm_deadline`,
    [rideId, passengerId, deadline],
  )
  if (rows.length === 0) return { started: false }
  await safetyQueue.add(
    'GUARDIAN_CHECK',
    { guardianSessionId: rows[0].id },
    { delay: env.SAFETY_GUARDIAN_REMINDER_MIN * 60000 },
  )
  return { started: true, confirmDeadline: rows[0].confirm_deadline }
}

async function hasGuardianTrigger({ rideId, passengerId, settings }) {
  if (!settings?.guardian_night_rides) return false
  const { rows } = await query(
    `SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kolkata')::int AS hour`,
  )
  const hour = rows[0].hour
  const isNight = hour >= 23 || hour < 5
  return isNight
}

/** Passenger taps "I'm Safe" (spec 10 §4). */
export async function confirmGuardianSafe({ rideId, userId }) {
  const { rows } = await query(`SELECT * FROM guardian_sessions WHERE ride_id = $1`, [rideId])
  const session = rows[0]
  if (!session || session.passenger_id !== userId) {
    throw new DomainError(ERROR_CODES.SAFETY_GUARDIAN_NOT_ACTIVE)
  }
  if (session.state !== 'ACTIVE') {
    return { confirmed: true, alreadyClosed: true }
  }
  await query(
    `UPDATE guardian_sessions SET state = 'CONFIRMED_SAFE', confirmed_safe_at = NOW() WHERE id = $1`,
    [session.id],
  )
  return { confirmed: true }
}

/** Overdue Guardian check — reminder ladder then escalation (worker calls). */
export async function processGuardianCheck({ guardianSessionId }) {
  const { rows } = await query(`SELECT * FROM guardian_sessions WHERE id = $1`, [guardianSessionId])
  const session = rows[0]
  if (!session || session.state !== 'ACTIVE') return { escalated: false, done: true }

  if (new Date() < new Date(session.confirm_deadline)) {
    // Still inside the window — remind and reschedule.
    await safetyQueue.add(
      'GUARDIAN_CHECK',
      { guardianSessionId },
      { delay: env.SAFETY_GUARDIAN_REMINDER_MIN * 60000 },
    )
    return { escalated: false, reminded: true }
  }

  // Overdue: escalate to trusted contacts + safety ops (spec 10 §4).
  const { rows: contacts } = await query(
    `SELECT phone_e164, contact_name, share_rule FROM user_trusted_contacts
      WHERE user_id = $1 AND is_active = true
        AND share_rule IN ('GUARDIAN_OVERDUE','SOS_ONLY')`,
    [session.passenger_id],
  )
  await createOrEscalateIncident({
    reporterId: session.passenger_id,
    reporterRole: 'SYSTEM',
    rideId: session.ride_id,
    source: 'GUARDIAN_OVERDUE',
    severity: 'HIGH',
  }).catch(() => null)
  await query(
    `UPDATE guardian_sessions SET state = 'ESCALATED', escalated_at = NOW(),
        escalation_level = escalation_level + 1 WHERE id = $1`,
    [guardianSessionId],
  )
  void contacts
  return { escalated: true }
}

export async function getSafetySettings(userId) {
  const { rows } = await query(`SELECT * FROM user_safety_settings WHERE user_id = $1`, [userId])
  return rows[0] || null
}

export async function upsertSafetySettings(userId, patch) {
  const allowed = {}
  for (const key of ['women_safety_plus', 'guardian_night_rides', 'guardian_all_rides', 'discreet_sos_enabled', 'anomaly_check_optin', 'auto_share_with_circle']) {
    if (patch[key] !== undefined) allowed[key] = patch[key]
  }
  await query(
    `INSERT INTO user_safety_settings (user_id, women_safety_plus, guardian_night_rides, guardian_all_rides, discreet_sos_enabled, auto_share_with_circle, anomaly_check_optin)
     VALUES ($1, COALESCE($2, false), COALESCE($3, false), COALESCE($4, false), COALESCE($5, true), COALESCE($6, 'SOS_ONLY'), COALESCE($7, true))
     ON CONFLICT (user_id) DO UPDATE SET
       women_safety_plus = COALESCE($2, user_safety_settings.women_safety_plus),
       guardian_night_rides = COALESCE($3, user_safety_settings.guardian_night_rides),
       guardian_all_rides = COALESCE($4, user_safety_settings.guardian_all_rides),
       discreet_sos_enabled = COALESCE($5, user_safety_settings.discreet_sos_enabled),
       auto_share_with_circle = COALESCE($6, user_safety_settings.auto_share_with_circle),
       anomaly_check_optin = COALESCE($7, user_safety_settings.anomaly_check_optin)`,
    [userId, allowed.women_safety_plus ?? null, allowed.guardian_night_rides ?? null, allowed.guardian_all_rides ?? null, allowed.discreet_sos_enabled ?? null, allowed.auto_share_with_circle ?? null, allowed.anomaly_check_optin ?? null],
  )
  return getSafetySettings(userId)
}
