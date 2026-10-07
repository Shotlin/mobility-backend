/**
 * Auth repository — users + auth_sessions data access (spec 05 §3).
 * All SQL parameterized; ownership enforced at service/controller layer.
 */

import { query } from '../../config/database.js'
import { withTransaction } from '../../utils/tx.js'

export class AuthRepository {
  async findUserByPhone(phoneE164) {
    const { rows } = await query(
      `SELECT id, phone_e164, full_name, email, gender, role, profile_photo_url,
              is_blocked, blocked_reason, session_version, created_at
         FROM users WHERE phone_e164 = $1 LIMIT 1`,
      [phoneE164],
    )
    return rows[0] || null
  }

  async findUserById(id) {
    const { rows } = await query(
      `SELECT id, phone_e164, full_name, email, gender, role, profile_photo_url,
              is_blocked, blocked_reason, session_version, created_at
         FROM users WHERE id = $1 LIMIT 1`,
      [id],
    )
    return rows[0] || null
  }

  /**
   * Find-or-create identity + driver profile in one transaction.
   * Logging in via the driver app upgrades a phone identity to DRIVER and
   * seeds a PENDING driver profile awaiting KYC (spec 12 §3).
   */
  async findOrCreateUser({ phoneE164, role }) {
    return withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT id, phone_e164, role, is_blocked FROM users WHERE phone_e164 = $1 FOR UPDATE`,
        [phoneE164],
      )
      if (existing.rows.length > 0) {
        const user = existing.rows[0]
        if (role === 'DRIVER' && user.role === 'PASSENGER') {
          await client.query(`UPDATE users SET role = 'DRIVER' WHERE id = $1`, [user.id])
          await client.query(
            `INSERT INTO driver_profiles (user_id, approval_state) VALUES ($1, 'PENDING')
             ON CONFLICT (user_id) DO NOTHING`,
            [user.id],
          )
          user.role = 'DRIVER'
        }
        return user
      }
      const created = await client.query(
        `INSERT INTO users (phone_e164, role) VALUES ($1, $2)
         RETURNING id, phone_e164, role, is_blocked`,
        [phoneE164, role === 'DRIVER' ? 'DRIVER' : 'PASSENGER'],
      )
      const user = created.rows[0]
      if (user.role === 'DRIVER') {
        await client.query(
          `INSERT INTO driver_profiles (user_id, approval_state) VALUES ($1, 'PENDING')`,
          [user.id],
        )
      }
      return user
    })
  }

  async createSession({ userId, sessionVersion, fingerprint, ip, userAgent, deviceType, refreshTokenHash, expiresAt }) {
    const { rows } = await query(
      `INSERT INTO auth_sessions
         (user_id, session_version, device_fingerprint, ip_address, user_agent, device_type, refresh_token_hash, expires_at, last_active_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING id, expires_at`,
      [userId, sessionVersion, fingerprint, ip, userAgent, deviceType, refreshTokenHash, expiresAt],
    )
    return rows[0]
  }

  async findActiveSessionByRefreshHash(refreshTokenHash) {
    const { rows } = await query(
      `SELECT s.id, s.user_id, s.session_version, s.is_revoked, s.expires_at,
              u.role, u.is_blocked
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.refresh_token_hash = $1
        LIMIT 1`,
      [refreshTokenHash],
    )
    return rows[0] || null
  }

  /** Rotate refresh token hash + touch activity. */
  async rotateSessionRefresh(sessionId, newHash) {
    const { rows } = await query(
      `UPDATE auth_sessions
          SET refresh_token_hash = $1, last_active_at = NOW()
        WHERE id = $2
        RETURNING id`,
      [newHash, sessionId],
    )
    return rows[0] || null
  }

  async touchSession(sessionId) {
    await query(`UPDATE auth_sessions SET last_active_at = NOW() WHERE id = $1`, [sessionId])
  }

  async revokeSession(sessionId, userId) {
    const { rowCount } = await query(
      `UPDATE auth_sessions
          SET is_revoked = true, revoked_at = NOW(), revoked_reason = 'LOGOUT'
        WHERE id = $1 AND user_id = $2 AND is_revoked = false`,
      [sessionId, userId],
    )
    return rowCount > 0
  }

  async revokeAllForUser(userId, reason) {
    const { rowCount } = await query(
      `UPDATE auth_sessions
          SET is_revoked = true, revoked_at = NOW(), revoked_reason = $2
        WHERE user_id = $1 AND is_revoked = false`,
      [userId, reason],
    )
    // session_version bump invalidates outstanding access tokens (spec 05 §3)
    await query(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [userId])
    return rowCount
  }

  async listActiveSessions(userId) {
    const { rows } = await query(
      `SELECT id, ip_address, user_agent, device_type, last_active_at, created_at, expires_at
         FROM auth_sessions
        WHERE user_id = $1 AND is_revoked = false AND expires_at > NOW()
        ORDER BY last_active_at DESC NULLS LAST`,
      [userId],
    )
    return rows
  }

  async getDriverProfile(userId) {
    const { rows } = await query(
      `SELECT user_id, approval_state, operational_state FROM driver_profiles WHERE user_id = $1`,
      [userId],
    )
    return rows[0] || null
  }
}
