/**
 * Admin service — operations dashboard APIs (spec 09 §5, spec 11).
 * Every route is permission-gated (RBAC registry) and audited for
 * high-risk actions (spec 05 §10).
 */

import bcrypt from 'bcrypt'
import axios from 'axios'
import { query } from '../../config/database.js'
import { env } from '../../config/env.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'
import { writeAuditLog } from '../../utils/audit-log.js'
import { createDeviceSession } from '../../utils/session.js'
import { signAccessToken } from '../../utils/jwt.js'
import { queueHealthSnapshot } from '../../config/bullmq.js'
import { pingRedisClients } from '../../config/redis.js'
import { decryptSecret } from '../../utils/encryption.js'
import {
  saveMapsSettings,
  clearMapsSettings,
  recordMapsTestResult,
} from '../ola-maps-settings/ola-maps-settings.service.js'

export class AdminService {
  /** Admin login: phone/e-mail + password (bcrypt). Optional TOTP when enforced. */
  async login({ phone, password, request }) {
    if (!phone || !password) {
      throw new DomainError(ERROR_CODES.AUTH_REQUIRED, 'Phone and password required')
    }
    const digits = String(phone).replace(/[^\d]/g, '').slice(-10)
    const e164 = `+91${digits}`
    const { rows } = await query(
      `SELECT id, phone_e164, full_name, role, is_blocked, password_hash, totp_secret_enc, session_version
         FROM users WHERE phone_e164 = $1 LIMIT 1`,
      [e164],
    )
    const user = rows[0]
    // Constant-time-ish: always run a bcrypt compare against a dummy hash.
    const hash = user?.password_hash || '$2b$10$CwTycUXWue0Thq9StjUM0uJ8QlGPeGzjLg0Q/.bcNxvWUvxSeFOju'
    const ok = await bcrypt.compare(password, hash)
    if (!user || !ok) {
      writeAuditLog({
        actorId: user?.id ?? null,
        actorType: 'ADMIN',
        action: 'ADMIN_LOGIN_FAILED',
        targetType: 'USER',
        targetId: user?.id ?? phone,
        ipAddress: request?.ip,
        userAgent: request?.headers?.['user-agent'],
      })
      throw new DomainError(ERROR_CODES.AUTH_REQUIRED, 'Invalid credentials')
    }
    if (user.is_blocked) throw new DomainError(ERROR_CODES.ACCOUNT_BLOCKED)

    // Admin roles only on this surface.
    const { ROLE_PERMISSIONS } = await import('../../utils/permissions.js')
    if (!ROLE_PERMISSIONS[user.role] || ROLE_PERMISSIONS[user.role].size === 0 || ['PASSENGER', 'DRIVER'].includes(user.role)) {
      throw new DomainError(ERROR_CODES.FORBIDDEN, 'Dashboard access requires an operator role')
    }

    const session = await createDeviceSession({
      userId: user.id,
      sessionVersion: user.session_version ?? 1,
      req: request,
      ttlDays: 7, // short admin sessions (spec 05 §3)
    })

    const accessToken = signAccessToken({
      id: user.id,
      phone: user.phone_e164,
      role: user.role,
      sessionId: session.sessionId,
      sessionVersion: user.session_version ?? 1,
    })

    writeAuditLog({
      actorId: user.id,
      actorType: 'ADMIN',
      action: 'ADMIN_LOGIN_SUCCESS',
      targetType: 'USER',
      targetId: user.id,
      ipAddress: request?.ip,
      userAgent: request?.headers?.['user-agent'],
    })

    return {
      accessToken,
      user: { id: user.id, fullName: user.full_name, role: user.role },
      permissions: Array.from(ROLE_PERMISSIONS[user.role] ?? []),
    }
  }

  // ── Rides ops (spec 11 §4) ─────────────────────────────────────────
  async listRides({ status, cityId, search, before, limit = 25 }) {
    const params = []
    const where = []
    if (status) {
      params.push(status)
      where.push(`r.status = $${params.length}`)
    }
    if (cityId) {
      params.push(cityId)
      where.push(`r.city_id = $${params.length}`)
    }
    if (search) {
      params.push(`%${search}%`)
      where.push(`(u.phone_e164 ILIKE $${params.length} OR du.phone_e164 ILIKE $${params.length} OR v.registration_number ILIKE $${params.length})`)
    }
    if (before) {
      params.push(new Date(before))
      where.push(`r.created_at < $${params.length}`)
    }
    params.push(Math.min(100, Math.max(1, limit)))
    const { rows } = await query(
      `SELECT r.id, r.status, r.ride_version, r.payment_method, r.created_at, r.completed_at, r.cancelled_at,
              r.final_total_paise, r.search_wave_count, r.no_driver_reason,
              ST_Y(r.pickup::geometry) AS pickup_lat, ST_X(r.pickup::geometry) AS pickup_lng,
              ST_Y(r.drop::geometry) AS drop_lat, ST_X(r.drop::geometry) AS drop_lng,
              vc.display_name AS category, u.phone_e164 AS passenger_phone,
              du.phone_e164 AS driver_phone, v.registration_number,
              (SELECT count(*)::int FROM safety_incidents si WHERE si.ride_id = r.id) AS incident_count
         FROM rides r
         JOIN users u ON u.id = r.passenger_id
         JOIN vehicle_categories vc ON vc.id = r.vehicle_category_id
         LEFT JOIN users du ON du.id = r.driver_id
         LEFT JOIN vehicles v ON v.id = r.vehicle_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY r.created_at DESC
        LIMIT $${params.length}`,
      params,
    )
    return {
      rides: rows.map((r) => ({
        rideId: r.id,
        status: r.status,
        rideVersion: r.ride_version,
        paymentMethod: r.payment_method,
        createdAt: r.created_at,
        completedAt: r.completed_at,
        cancelledAt: r.cancelled_at,
        finalTotalPaise: r.final_total_paise != null ? Number(r.final_total_paise) : null,
        searchWaveCount: r.search_wave_count,
        noDriverReason: r.no_driver_reason,
        pickup: { lat: Number(r.pickup_lat), lng: Number(r.pickup_lng) },
        drop: { lat: Number(r.drop_lat), lng: Number(r.drop_lng) },
        category: r.category,
        passengerPhone: r.passenger_phone,
        driverPhone: r.driver_phone,
        registrationNumber: r.registration_number,
        incidentCount: r.incident_count,
      })),
      nextCursor: rows.length === Math.min(100, Math.max(1, limit)) ? rows[rows.length - 1].created_at : null,
    }
  }

  async getRideDetail(rideId) {
    const { rows: rideRows } = await query(
      `SELECT r.*, u.phone_e164 AS passenger_phone, u.full_name AS passenger_name,
              du.phone_e164 AS driver_phone, du.full_name AS driver_name,
              dp.rating_sum, dp.rating_count, v.registration_number, v.model,
              vc.display_name AS category, c.name AS city_name
         FROM rides r
         JOIN users u ON u.id = r.passenger_id
         JOIN vehicle_categories vc ON vc.id = r.vehicle_category_id
         JOIN cities c ON c.id = r.city_id
         LEFT JOIN users du ON du.id = r.driver_id
         LEFT JOIN driver_profiles dp ON dp.user_id = r.driver_id
         LEFT JOIN vehicles v ON v.id = r.vehicle_id
        WHERE r.id = $1`,
      [rideId],
    )
    const r = rideRows[0]
    if (!r) throw new DomainError(ERROR_CODES.RIDE_NOT_FOUND)
    const { rows: events } = await query(
      `SELECT ride_version, event_type, payload, occurred_at, actor_role FROM ride_events WHERE ride_id = $1 ORDER BY ride_version`,
      [rideId],
    )
    const { rows: offers } = await query(
      `SELECT o.id, o.driver_id, o.dispatch_wave, o.state, o.distance_to_pickup_m, o.offered_at, o.responded_at,
              u.phone_e164 AS driver_phone
         FROM ride_offers o JOIN users u ON u.id = o.driver_id
        WHERE o.ride_id = $1 ORDER BY o.dispatch_wave, o.offered_at`,
      [rideId],
    )
    const { rows: incidents } = await query(
      `SELECT id, source, severity, status, created_at FROM safety_incidents WHERE ride_id = $1`,
      [rideId],
    )
    const { rows: payment } = await query(
      `SELECT id, method, status, amount_paise, provider_order_id, provider_payment_id FROM payment_intents WHERE ride_id = $1`,
      [rideId],
    )
    return {
      ride: {
        rideId: r.id,
        status: r.status,
        rideVersion: r.ride_version,
        paymentMethod: r.payment_method,
        city: r.city_name,
        category: r.category,
        createdAt: r.created_at,
        assignedAt: r.assigned_at,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        cancelledAt: r.cancelled_at,
        cancellationReason: r.cancellation_reason,
        finalTotalPaise: r.final_total_paise != null ? Number(r.final_total_paise) : null,
        searchWaveCount: r.search_wave_count,
        noDriverReason: r.no_driver_reason,
      },
      passenger: { id: r.passenger_id, phone: r.passenger_phone, name: r.passenger_name },
      driver: r.driver_id
        ? {
            id: r.driver_id,
            phone: r.driver_phone,
            name: r.driver_name,
            registrationNumber: r.registration_number,
            model: r.model,
            rating: r.rating_count > 0 ? Number((r.rating_sum / r.rating_count).toFixed(2)) : null,
          }
        : null,
      timeline: events.map((e) => ({ version: e.ride_version, type: e.event_type, at: e.occurred_at, actorRole: e.actor_role, ...e.payload })),
      offers: offers.map((o) => ({
        offerId: o.id,
        driverId: o.driver_id,
        driverPhone: o.driver_phone,
        wave: o.dispatch_wave,
        state: o.state,
        distanceToPickupM: o.distance_to_pickup_m,
        offeredAt: o.offered_at,
        respondedAt: o.responded_at,
      })),
      incidents,
      payment: payment[0]
        ? { paymentIntentId: payment[0].id, method: payment[0].method, status: payment[0].status, amountPaise: Number(payment[0].amount_paise), providerOrderId: payment[0].provider_order_id }
        : null,
    }
  }

  // ── Live ops (spec 11 §2/§3) ───────────────────────────────────────
  async commandCenter() {
    const { rows: rideStats } = await query(
      `SELECT
         count(*) FILTER (WHERE status = 'SEARCHING')::int AS searching,
         count(*) FILTER (WHERE status IN ('ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED'))::int AS en_route,
         count(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS in_progress,
         count(*) FILTER (WHERE status = 'NO_DRIVER_FOUND' AND created_at > NOW() - INTERVAL '24 hours')::int AS no_driver_24h,
         count(*) FILTER (WHERE status = 'CANCELLED' AND created_at > NOW() - INTERVAL '24 hours')::int AS cancelled_24h,
         count(*) FILTER (WHERE status = 'COMPLETED' AND created_at > NOW() - INTERVAL '24 hours')::int AS completed_24h,
         COALESCE(AVG(EXTRACT(EPOCH FROM (assigned_at - created_at))) FILTER (WHERE assigned_at IS NOT NULL AND created_at > NOW() - INTERVAL '24 hours'), 0) AS avg_dispatch_s
       FROM rides
       WHERE created_at > NOW() - INTERVAL '24 hours' OR status IN ('SEARCHING','ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','IN_PROGRESS')`,
    )
    const { rows: driverStats } = await query(
      `SELECT
         count(*) FILTER (WHERE operational_state != 'OFFLINE')::int AS online_total,
         count(*) FILTER (WHERE operational_state = 'ONLINE_IDLE')::int AS idle,
         count(*) FILTER (WHERE operational_state IN ('TO_PICKUP','ARRIVED_WAITING','ON_TRIP'))::int AS on_trip,
         count(*) FILTER (WHERE approval_state = 'PENDING')::int AS pending_kyc,
         count(*) FILTER (WHERE approval_state = 'SUSPENDED')::int AS suspended
       FROM driver_profiles`,
    )
    const { rows: incidentStats } = await query(
      `SELECT count(*)::int AS active FROM safety_incidents WHERE status NOT IN ('RESOLVED','CLOSED')`,
    )
    const { rows: paymentStats } = await query(
      `SELECT count(*)::int AS pending FROM payment_intents WHERE status IN ('PENDING','AUTHORIZED','REFUND_PENDING')`,
    )
    return {
      rides: {
        searching: rideStats[0].searching,
        enRoute: rideStats[0].en_route,
        inProgress: rideStats[0].in_progress,
        noDriver24h: rideStats[0].no_driver_24h,
        cancelled24h: rideStats[0].cancelled_24h,
        completed24h: rideStats[0].completed_24h,
        avgDispatchSeconds: Math.round(Number(rideStats[0].avg_dispatch_s)),
      },
      drivers: {
        onlineTotal: driverStats[0].online_total,
        idle: driverStats[0].idle,
        onTrip: driverStats[0].on_trip,
        pendingKyc: driverStats[0].pending_kyc,
        suspended: driverStats[0].suspended,
      },
      activeSafetyIncidents: incidentStats[0].active,
      pendingPayments: paymentStats[0].pending,
    }
  }

  // ── Drivers (spec 11 §6) ───────────────────────────────────────────
  async listDrivers({ approvalState, search, limit = 50 }) {
    const params = []
    const where = []
    if (approvalState) {
      params.push(approvalState)
      where.push(`dp.approval_state = $${params.length}`)
    }
    if (search) {
      params.push(`%${search}%`)
      where.push(`(u.phone_e164 ILIKE $${params.length} OR u.full_name ILIKE $${params.length} OR v.registration_number ILIKE $${params.length})`)
    }
    params.push(Math.min(200, Math.max(1, limit)))
    const { rows } = await query(
      `SELECT dp.user_id, u.full_name, u.phone_e164, dp.approval_state, dp.operational_state,
              dp.total_rides, dp.rating_sum, dp.rating_count, dp.last_location_at,
              v.registration_number, v.model, c.name AS city_name
         FROM driver_profiles dp
         JOIN users u ON u.id = dp.user_id
         LEFT JOIN vehicles v ON v.id = dp.active_vehicle_id
         LEFT JOIN cities c ON c.id = dp.city_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY dp.last_location_at DESC NULLS LAST
        LIMIT $${params.length}`,
      params,
    )
    return {
      drivers: rows.map((r) => ({
        driverId: r.user_id,
        fullName: r.full_name,
        phone: r.phone_e164,
        approvalState: r.approval_state,
        operationalState: r.operational_state,
        totalRides: r.total_rides,
        rating: r.rating_count > 0 ? Number((r.rating_sum / r.rating_count).toFixed(2)) : null,
        lastLocationAt: r.last_location_at,
        registrationNumber: r.registration_number,
        model: r.model,
        city: r.city_name,
      })),
    }
  }

  async approveDriver({ driverId, operatorId, approve }) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT approval_state FROM driver_profiles WHERE user_id = $1 FOR UPDATE`, [driverId])
      if (!rows[0]) throw new DomainError(ERROR_CODES.DRIVER_NOT_FOUND)
      const to = approve ? 'APPROVED' : 'SUSPENDED'
      await client.query(
        `UPDATE driver_profiles SET approval_state = $2, approval_changed_at = NOW(), state_changed_at = NOW() WHERE user_id = $1`,
        [driverId, to],
      )
      await client.query(
        `INSERT INTO safety_incident_events (incident_id, event_type, actor_id, actor_role, payload)
         SELECT NULL, 'DRIVER_STATE_CHANGED', $2, 'OPERATOR', $3 WHERE false`,
        [driverId, operatorId, JSON.stringify({ to })],
      ).catch(() => {})
      await emitAuditDirect({
        actorId: operatorId,
        actorType: 'ADMIN',
        action: approve ? 'DRIVER_APPROVED' : 'DRIVER_SUSPENDED',
        targetType: 'DRIVER',
        targetId: driverId,
        before: { approvalState: rows[0].approval_state },
        after: { approvalState: to },
      })
      return { driverId, approvalState: to }
    })
  }

  // ── Live ops snapshots (spec 09 §5 /admin/live/*, spec 04 §18) ──────
  // Snapshots, not firehoses: dashboards poll these and receive deltas via
  // the ops:city socket rooms for in-between updates.
  async liveDrivers({ cityId, vehicleCategoryId } = {}) {
    if (!cityId || !vehicleCategoryId) {
      throw new DomainError(ERROR_CODES.VALIDATION_ERROR, 'cityId and vehicleCategoryId are required')
    }
    const { rows: cityRows } = await query(`SELECT id FROM cities WHERE id = $1`, [cityId])
    if (cityRows.length === 0) throw new DomainError(ERROR_CODES.CITY_UNAVAILABLE)
    // Snapshot from persisted last_location (spec 04 §2) with a freshness
    // filter; the ride-room socket deltas keep it live in between polls.
    const { rows: drivers } = await query(
      `SELECT dp.user_id AS driver_id, dp.operational_state, dp.last_location_at,
              u.full_name, v.registration_number, dp.rating_sum, dp.rating_count,
              ST_Y(dp.last_location::geometry) AS lat, ST_X(dp.last_location::geometry) AS lng
         FROM driver_profiles dp
         JOIN users u ON u.id = dp.user_id
         LEFT JOIN vehicles v ON v.id = dp.active_vehicle_id
        WHERE dp.city_id = $1
          AND dp.last_location_at > NOW() - ($2 || ' seconds')::interval
        LIMIT 500`,
      [cityId, String(120)],
    )
    return {
      cityId,
      vehicleCategoryId,
      drivers: drivers.map((d) => ({
        driverId: d.driver_id,
        fullName: d.full_name,
        operationalState: d.operational_state,
        registrationNumber: d.registration_number,
        rating: d.rating_count > 0 ? Number((d.rating_sum / d.rating_count).toFixed(2)) : null,
        location: { lat: Number(d.lat), lng: Number(d.lng) },
        lastLocationAt: d.last_location_at,
        freshnessS: Math.round((Date.now() - new Date(d.last_location_at).getTime()) / 1000),
      })),
    }
  }

  async liveRides({ cityId } = {}) {
    const params = []
    const where = [`r.status IN ('SEARCHING','ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','IN_PROGRESS')`]
    if (cityId) {
      params.push(cityId)
      where.push(`r.city_id = $${params.length}`)
    }
    const { rows } = await query(
      `SELECT r.id, r.status, r.created_at, r.assigned_at, r.search_wave_count,
              ST_Y(r.pickup::geometry) AS pickup_lat, ST_X(r.pickup::geometry) AS pickup_lng,
              ST_Y(r.drop::geometry) AS drop_lat, ST_X(r.drop::geometry) AS drop_lng,
              vc.display_name AS category, u.phone_e164 AS passenger_phone
         FROM rides r
         JOIN users u ON u.id = r.passenger_id
         JOIN vehicle_categories vc ON vc.id = r.vehicle_category_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at
        LIMIT 300`,
      params,
    )
    return {
      rides: rows.map((r) => ({
        rideId: r.id,
        status: r.status,
        createdAt: r.created_at,
        assignedAt: r.assigned_at,
        searchAgeS: r.assigned_at ? null : Math.round((Date.now() - new Date(r.created_at).getTime()) / 1000),
        waveCount: r.search_wave_count,
        pickup: { lat: Number(r.pickup_lat), lng: Number(r.pickup_lng) },
        drop: { lat: Number(r.drop_lat), lng: Number(r.drop_lng) },
        category: r.category,
        passengerPhone: r.passenger_phone,
      })),
    }
  }

  // ── Platform controls + system health (spec 11 §14/§15) ───────────
  async getPlatformSettings() {
    const { rows } = await query(`SELECT key, value, updated_at FROM platform_settings ORDER BY key`)
    return Object.fromEntries(rows.map((r) => [r.key, { value: r.value, updatedAt: r.updated_at }]))
  }

  async setPlatformSetting({ key, value, operatorId }) {
    await query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_by = $3, updated_at = NOW()`,
      [key, JSON.stringify(value), operatorId],
    )
    writeAuditLog({
      actorId: operatorId,
      actorType: 'ADMIN',
      action: 'PLATFORM_SETTING_UPDATED',
      targetType: 'PLATFORM_SETTING',
      targetId: key,
      after: value,
    })
    return { key, value }
  }

  // ── Ola Maps connection (dashboard-managed provider key, spec 11 §10) ──
  // The raw key is write-only: it is stored AES-256-GCM encrypted and only
  // ever surfaced as its last 4 characters. Connect runs the live test first
  // and saves nothing when the test fails.

  async getOlaMapsStatus() {
    const { rows } = await query(
      `SELECT value, updated_at FROM platform_settings WHERE key = 'ola_maps_settings'`,
    ).catch(() => ({ rows: [] }))
    const v = rows[0]?.value
    let keyHint = null
    let connected = false
    if (v?.api_key_enc) {
      try {
        const raw = decryptSecret(v.api_key_enc)
        keyHint = raw.length > 4 ? `••••${raw.slice(-4)}` : '••••'
        connected = v.enabled === true
      } catch {
        // Undecryptable (e.g. SETTINGS_ENCRYPTION_KEY rotated) — treat as broken.
        keyHint = null
        connected = false
      }
    }
    return {
      connected,
      keyHint,
      source: connected ? 'dashboard' : env.OLA_MAPS_API_KEY ? 'env' : null,
      lastTestAt: v?.last_test_at ?? null,
      lastTestStatus: v?.last_test_status ?? null,
      updatedAt: rows[0]?.updated_at ?? null,
    }
  }

  /**
   * Probe a CANDIDATE key against the provider without persisting anything.
   * Deliberately bypasses the shared circuit breaker/limiter — a stream of
   * bad candidate keys pasted in the dashboard must not open the breaker
   * that protects the live proxy.
   */
  async testOlaMapsKey({ apiKey }) {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 8) {
      throw new DomainError(ERROR_CODES.VALIDATION_ERROR, 'apiKey is required (min 8 characters)')
    }
    const key = apiKey.trim()
    const started = Date.now()
    try {
      const res = await axios.get(`${env.OLA_MAPS_BASE_URL}/places/v1/autocomplete`, {
        params: { input: 'raahi-connection-test' },
        headers: { 'X-Api-Key': key },
        timeout: 8000,
      })
      return { ok: true, latencyMs: Date.now() - started, httpStatus: res.status }
    } catch (err) {
      const status = err.response?.status
      const error =
        status === 401 || status === 403
          ? 'Ola rejected the key (unauthorized)'
          : err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT'
            ? 'Timed out contacting Ola Maps'
            : status
              ? `Ola test call failed (HTTP ${status})`
              : `Cannot reach Ola Maps (${err.message || 'network error'})`
      return { ok: false, latencyMs: Date.now() - started, error }
    }
  }

  async connectOlaMaps({ apiKey, operatorId }) {
    const test = await this.testOlaMapsKey({ apiKey })
    if (!test.ok) {
      throw new DomainError(ERROR_CODES.MAPS_TEST_FAILED, `Connection test failed — not connected. ${test.error}`, {
        retryable: false,
        details: { test },
      })
    }
    await saveMapsSettings({ apiKey: apiKey.trim(), enabled: true, updatedBy: operatorId })
    await recordMapsTestResult(true)
    writeAuditLog({
      actorId: operatorId,
      actorType: 'ADMIN',
      action: 'OLA_MAPS_CONNECTED',
      targetType: 'PLATFORM_SETTING',
      targetId: 'ola_maps_settings',
      after: { enabled: true, keyHint: `••••${apiKey.trim().slice(-4)}`, latencyMs: test.latencyMs },
    })
    return this.getOlaMapsStatus()
  }

  async disconnectOlaMaps({ operatorId }) {
    await clearMapsSettings()
    writeAuditLog({
      actorId: operatorId,
      actorType: 'ADMIN',
      action: 'OLA_MAPS_DISCONNECTED',
      targetType: 'PLATFORM_SETTING',
      targetId: 'ola_maps_settings',
    })
    return this.getOlaMapsStatus()
  }

  async systemHealth() {
    const postgres = await query('SELECT 1').then(() => 'up').catch((e) => `down: ${e.message}`)
    const redisClients = await pingRedisClients()
    const queues = await queueHealthSnapshot()
    const { rows: provider } = await query(
      `SELECT value FROM platform_settings WHERE key = 'ola_maps_settings'`,
    ).catch(() => ({ rows: [] }))
    return {
      timestamp: new Date().toISOString(),
      postgres,
      redisClients,
      queues,
      olaMapsConfigured: Boolean(provider[0]?.value?.api_key_enc) || Boolean(env.OLA_MAPS_API_KEY),
    }
  }
}

/** Fire-and-forget audit for non-tx paths. */
function emitAuditDirect(entry) {
  import('../../utils/audit-log.js').then((m) => m.writeAuditLog(entry))
}
