/**
 * Ola Maps settings — dashboard-managed provider credential (spec 11 §10).
 * Admin routes (paste/test/save/activate/rotate) land with the dashboard
 * phase; this service is the single credential source for maps.client.js.
 *
 * Storage: platform_settings row `ola_maps_settings`, apiKey encrypted at
 * rest with SETTINGS_ENCRYPTION_KEY (utils/encryption.js, AES-256-GCM) —
 * the raw key is never returned by any API (masked display only).
 */

import { query } from '../../config/database.js'
import { encryptSecret as encrypt, decryptSecret as decrypt } from '../../utils/encryption.js'
import { logger } from '../../config/logger.js'

const SETTINGS_KEY = 'ola_maps_settings'

/**
 * @returns {Promise<{apiKey: string|null, enabled: boolean, lastTestAt: string|null, lastTestStatus: string|null}|null>}
 */
export async function getActiveMapsSettings() {
  try {
    const { rows } = await query(`SELECT value FROM platform_settings WHERE key = $1`, [SETTINGS_KEY])
    if (rows.length === 0) return null
    const v = rows[0].value || {}
    if (!v.api_key_enc) return null
    const apiKey = decrypt(v.api_key_enc)
    if (!v.enabled) return null
    return {
      apiKey,
      enabled: v.enabled === true,
      lastTestAt: v.last_test_at ?? null,
      lastTestStatus: v.last_test_status ?? null,
    }
  } catch (err) {
    // Missing table/encryption key before migrations/bootstrap — degrade to env.
    logger.debug({ err: err.message }, 'ola-maps-settings read failed')
    return null
  }
}

/**
 * Save/rotate the provider key (admin action — audited by the caller).
 * Merge happens in JS because the jsonb in-place UPDATE variant hits an
 * ambiguous `value` reference inside ON CONFLICT DO UPDATE.
 * @param {object} args {apiKey, enabled, updatedBy} — apiKey undefined keeps
 *   the stored key, null removes it.
 */
export async function saveMapsSettings({ apiKey, enabled, updatedBy }) {
  const { rows: existingRows } = await query(
    `SELECT value FROM platform_settings WHERE key = $1`,
    [SETTINGS_KEY],
  ).catch(() => ({ rows: [] }))
  const next = { ...(existingRows[0]?.value ?? {}) }
  if (apiKey !== undefined) {
    if (apiKey === null) delete next.api_key_enc
    else next.api_key_enc = encrypt(apiKey)
  }
  if (enabled !== undefined) next.enabled = enabled === true
  next.updated_at = new Date().toISOString()
  next.updated_by = updatedBy ?? null
  await query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = $2::jsonb, updated_by = $3, updated_at = NOW()`,
    [SETTINGS_KEY, JSON.stringify(next), updatedBy ?? null],
  )
  return next
}

export async function recordMapsTestResult(ok, error = null) {
  await query(
    `UPDATE platform_settings
        SET value = value || jsonb_build_object(
              'last_test_at', NOW(),
              'last_test_status', $2::text
            )
      WHERE key = $1`,
    [SETTINGS_KEY, ok ? 'SUCCESS' : `FAILED: ${String(error).slice(0, 120)}`],
  )
}

/**
 * Remove the stored provider key and deactivate the connection
 * (dashboard "Disconnect" — audited by the caller). No-op when nothing
 * is stored yet.
 */
export async function clearMapsSettings() {
  await query(
    `UPDATE platform_settings
        SET value = (value - 'api_key_enc')
                  || jsonb_build_object('enabled', false, 'updated_at', NOW()),
            updated_at = NOW()
      WHERE key = $1`,
    [SETTINGS_KEY],
  )
}

