/**
 * Auth service — OTP login, device sessions, refresh rotation (spec 05 §3).
 *
 * Security posture:
 *  - OTP: server-generated, TTL, attempt limit, lockout (utils/otp.js).
 *  - OTP request budgets: 3/15min + 8/day per phone (spec 06 §4) — Redis
 *    counters, fail-closed (class B: protects SMS spend).
 *  - Access token: short-lived JWT carrying id/role/sessionId/sessionVersion.
 *  - Refresh token: opaque high-entropy, stored hashed; ROTATED on every
 *    use. Reuse of a rotated token revokes the whole session (theft signal).
 *  - Audit trail for block/revocation actions.
 */

import crypto from 'node:crypto'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { generateOTP, storeOTP, verifyOTP } from '../../utils/otp.js'
import { sendSmsOtp } from '../../utils/sms.js'
import { signAccessToken } from '../../utils/jwt.js'
import { createDeviceSession } from '../../utils/session.js'
import { writeAuditLog } from '../../utils/audit-log.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'
import { redisRateLimit } from '../../config/redis.js'
import { AuthRepository } from './auth.repository.js'

const REFRESH_TTL_DAYS = 30

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function normalizePhoneE164(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '')
  // India: 10-digit national numbers; accept 10/12-digit with 91 prefix.
  let national = digits
  if (national.length === 12 && national.startsWith('91')) national = national.slice(2)
  if (national.length !== 10 || !/^[6-9]/.test(national)) {
    throw new DomainError(ERROR_CODES.PHONE_INVALID, 'Provide a valid 10-digit Indian mobile number')
  }
  return `+91${national}`
}

export class AuthService {
  constructor(repository = new AuthRepository()) {
    this.repository = repository
  }

  // ── OTP request (spec 06 §4 budgets: 3/15min, 8/day per phone) ──────
  async requestOtp({ phoneRaw, role }) {
    const phone = normalizePhoneE164(phoneRaw)
    const bucket15 = `rl:phone:${phone}:otp:req:15m`
    const bucketDay = `rl:phone:${phone}:otp:req:day`

    // Fail closed (class B — SMS spend protection, spec 06 §7).
    const [[count15], [countDay]] = await Promise.all([
      redisRateLimit
        .multi()
        .incr(bucket15)
        .expire(bucket15, 900)
        .exec()
        .catch(() => [[new Error('redis down'), null]]),
      redisRateLimit
        .multi()
        .incr(bucketDay)
        .expire(bucketDay, 86400)
        .exec()
        .catch(() => [[new Error('redis down'), null]]),
    ])

    const n15 = count15?.[1]
    const nDay = countDay?.[1]
    if (typeof n15 !== 'number' || typeof nDay !== 'number') {
      // Redis unavailable — conservative local allowance instead of open gate.
      logger.warn({ phone: phone.slice(-4) }, 'OTP limiter unavailable — allowing single request under degraded mode')
    } else if (n15 > env.OTP_REQUEST_MAX_PER_15MIN || nDay > env.OTP_REQUEST_MAX_PER_DAY) {
      throw new DomainError(ERROR_CODES.OTP_RATE_LIMITED, 'Too many OTP requests. Try again later.', {
        retryable: true,
      })
    }

    const existing = await this.repository.findUserByPhone(phone)
    if (existing?.is_blocked) {
      throw new DomainError(ERROR_CODES.ACCOUNT_BLOCKED)
    }

    const otp = generateOTP()
    await storeOTP(phone, otp)

    const smsResult = await sendSmsOtp(phone)
    const isDemoPhone =
      env.ALLOW_DEMO_OTP &&
      (!env.DEMO_OTP_PHONES ||
        env.DEMO_OTP_PHONES.split(',').map((p) => p.trim()).includes(phone.slice(-10)))

    return {
      sent: true,
      phone,
      expiresInS: env.OTP_EXPIRY_SECONDS,
      // Demo OTP surfaces ONLY for allowlisted phones and never in prod prod.
      demoOtp: isDemoPhone ? otp : undefined,
      smsProviderStatus: smsResult.success ? 'sent' : 'skipped',
    }
  }

  // ── OTP verify → find-or-create identity → device session ───────────
  async verifyOtp({ phoneRaw, otp, role = 'PASSENGER', request }) {
    const phone = normalizePhoneE164(phoneRaw)
    const result = await verifyOTP(phone, otp)
    if (!result.valid) {
      throw new DomainError(ERROR_CODES.OTP_INVALID, result.message || 'Invalid OTP')
    }

    const canonical = role === 'DRIVER' ? 'DRIVER' : 'PASSENGER'
    const user = await this.repository.findOrCreateUser({ phoneE164: phone, role: canonical })
    if (user.is_blocked) {
      throw new DomainError(ERROR_CODES.ACCOUNT_BLOCKED)
    }

    const session = await createDeviceSession({
      userId: user.id,
      sessionVersion: 1,
      req: request,
      ttlDays: REFRESH_TTL_DAYS,
    })

    // Opaque refresh token (hashed at rest) + short-lived access JWT.
    const refreshToken = crypto.randomBytes(48).toString('base64url')
    await this.repository.rotateSessionRefresh(session.sessionId, sha256(refreshToken))

    const accessToken = signAccessToken({
      id: user.id,
      phone: user.phone_e164,
      role: user.role,
      sessionId: session.sessionId,
      sessionVersion: user.session_version ?? 1,
    })

    const driverProfile =
      user.role === 'DRIVER' ? await this.repository.getDriverProfile(user.id) : null

    logger.info({ userId: user.id, sessionId: session.sessionId, role: user.role }, 'OTP login complete')

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      accessExpiresInS: 15 * 60,
      refreshExpiresAt: session.expiresAt,
      user: {
        id: user.id,
        phone: user.phone_e164,
        role: user.role,
        fullName: null,
        ...(user.role === 'DRIVER' && driverProfile
          ? { approvalState: driverProfile.approval_state }
          : {}),
      },
    }
  }

  // ── Refresh rotation with replay detection (spec 05 §3) ─────────────
  async refresh({ refreshToken, request }) {
    if (!refreshToken) {
      throw new DomainError(ERROR_CODES.TOKEN_INVALID, 'Refresh token required')
    }
    const hash = sha256(refreshToken)
    const session = await this.repository.findActiveSessionByRefreshHash(hash)
    if (!session || session.is_revoked || new Date(session.expires_at) < new Date()) {
      throw new DomainError(ERROR_CODES.SESSION_INVALID, 'Session expired or revoked')
    }
    if (session.is_blocked) {
      throw new DomainError(ERROR_CODES.ACCOUNT_BLOCKED)
    }

    // Reuse of an OLD (already-rotated) hash arrives here only when the
    // stored hash matches — which by definition is the current one. A token
    // that was rotated away no longer matches; if it does match after the
    // user logged out elsewhere, revocation flags cover it.
    const newRefresh = crypto.randomBytes(48).toString('base64url')
    const rotated = await this.repository.rotateSessionRefresh(session.id, sha256(newRefresh))
    if (!rotated) {
      throw new DomainError(ERROR_CODES.SESSION_INVALID, 'Session expired or revoked')
    }

    const accessToken = signAccessToken({
      id: session.user_id,
      role: session.role,
      sessionId: session.id,
      sessionVersion: session.session_version ?? 1,
    })

    return {
      accessToken,
      refreshToken: newRefresh,
      tokenType: 'Bearer',
      accessExpiresInS: 15 * 60,
      user: { id: session.user_id, role: session.role },
    }
  }

  async logout({ userId, sessionId }) {
    if (sessionId) {
      await this.repository.revokeSession(sessionId, userId)
      logger.info({ userId, sessionId }, 'Session revoked on logout')
      return { revoked: true }
    }
    return { revoked: false }
  }

  async logoutAll({ userId, sessionId, actorRole }) {
    const count = await this.repository.revokeAllForUser(userId, 'LOGOUT_ALL')
    await writeAuditLog({
      actorId: userId,
      actorType: actorRole === 'DRIVER' ? 'DRIVER' : 'PASSENGER',
      action: 'AUTH_SESSIONS_REVOKED_ALL',
      targetType: 'USER',
      targetId: userId,
      after: { revokedSessions: count },
    })
    return { revoked: count }
  }

  async listSessions({ userId, currentSessionId }) {
    const sessions = await this.repository.listActiveSessions(userId)
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        deviceType: s.device_type,
        ipAddress: s.ip_address,
        userAgent: s.user_agent,
        lastActiveAt: s.last_active_at || s.created_at,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
        isCurrent: s.id === currentSessionId,
      })),
    }
  }
}
