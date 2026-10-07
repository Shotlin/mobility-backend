/**
 * Audit log emit helper — single entry point for the append-only
 * `audit_logs` table (Raahi spec 05 §15).
 *
 * Two emit modes:
 *   - `writeAuditLog({...})` — fire-and-forget via setImmediate; never
 *     affects request latency. Security events with no surrounding
 *     mutation (login_success, session_revoked...).
 *   - `emitAuditInTx(client, {...})` — transactional; reuses the caller's
 *     pg client so the audit row commits atomically with the mutation it
 *     describes. Money/admin/assignment/safety actions MUST use this.
 *
 * Sensitive-field stripping: tokens, OTP/PIN, secrets, bank/UPI details
 * and KYC payloads never reach audit rows (spec 05 §14 redaction rules).
 *
 * Append-only contract: this module ONLY emits INSERTs against audit_logs.
 */

import { pool } from '../config/database.js'
import { logger } from '../config/logger.js'

const SENSITIVE_FIELDS = new Set([
  'password_hash',
  'otp',
  'pin',
  'tripPin',
  'access_token',
  'refreshToken',
  'accessToken',
  'authorization',
  'keySecret',
  'webhookSecret',
  'apiKey',
  'bank_account_number',
  'bankAccountNumber',
  'upiVpa',
  'upi_vpa',
  'documentContent',
])

const INSERT_SQL = `
  INSERT INTO audit_logs (
    actor_id, actor_type, action,
    target_type, target_id,
    before_summary, after_summary, reason,
    request_id, trace_id, ip_address, user_agent
  ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12)
`

/** Deep-clone `value` stripping sensitive keys at every nesting level. */
export function redact(value) {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value

  if (Array.isArray(value)) {
    return value.map((item) => redact(item))
  }

  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value

  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_FIELDS.has(key)) continue
    out[key] = redact(child)
  }
  return out
}

function buildParams(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('audit-log: entry object is required')
  }
  if (!entry.action || typeof entry.action !== 'string') {
    throw new Error('audit-log: `action` is required')
  }
  return [
    entry.actorId ?? null,
    entry.actorType ?? 'SYSTEM',
    entry.action,
    entry.targetType ?? null,
    entry.targetId != null ? String(entry.targetId) : null,
    entry.before ? JSON.stringify(redact(entry.before)) : null,
    entry.after ? JSON.stringify(redact(entry.after)) : null,
    entry.reason ?? null,
    entry.requestId ?? null,
    entry.traceId ?? null,
    entry.ipAddress ?? null,
    entry.userAgent ?? null,
  ]
}

/**
 * Fire-and-forget audit emit. Never throws to the caller; failures are
 * structured-logged. @param {object} entry see INSERT_SQL columns:
 * { actorId, actorType, action, targetType, targetId, before, after,
 *   reason, requestId, traceId, ipAddress, userAgent }
 */
export function writeAuditLog(entry) {
  let params
  try {
    params = buildParams(entry)
  } catch (err) {
    logger.error({ err }, 'audit-log: invalid entry at call site')
    return
  }
  setImmediate(async () => {
    try {
      await pool.query(INSERT_SQL, params)
    } catch (err) {
      logger.error({ err, action: entry.action }, 'audit_logs insert failed (fire-and-forget)')
    }
  })
}

/** Transactional audit emit — commits with the caller's mutation. */
export async function emitAuditInTx(client, entry) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('audit-log: client (pg PoolClient) is required for emitAuditInTx')
  }
  const params = buildParams(entry)
  await client.query(INSERT_SQL, params)
}
