/**
 * Razorpay SDK client + active credentials.
 *
 * Credentials are dashboard-managed (Raahi spec 11 §10/§11: paste, test,
 * activate, audit, masked display) via the admin/razorpay-settings module
 * (restored in Phase 8). Until that module lands, this degrades cleanly to
 * env vars so the platform boots before payments configuration exists.
 *
 * `razorpay` is an ES module `let` export — every importer gets a *live
 * binding*, so refreshRazorpayClient() after an admin activates new
 * credentials updates all existing importers with no process restart.
 */

import Razorpay from 'razorpay'
import { env } from './env.js'
import { logger } from './logger.js'

export let razorpay = null
let activeMode = null
let activeKeyId = null
let activeKeySecret = null
let activeWebhookSecret = null

function applyCredentials(mode, keyId, keySecret, webhookSecret) {
  razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret })
  activeMode = mode
  activeKeyId = keyId
  activeKeySecret = keySecret
  activeWebhookSecret = webhookSecret || null
}

function clearCredentials() {
  razorpay = null
  activeMode = null
  activeKeyId = null
  activeKeySecret = null
  activeWebhookSecret = null
}

/**
 * (Re)loads active credentials. Dashboard settings loader is installed by
 * the admin/razorpay-settings module via setRazorpaySettingsLoader(); until
 * then env fallback applies.
 */
let settingsLoader = null

export function setRazorpaySettingsLoader(loader) {
  settingsLoader = loader
}

export async function refreshRazorpayClient() {
  if (settingsLoader) {
    try {
      const credentials = await settingsLoader()
      if (credentials?.keyId && credentials?.keySecret) {
        applyCredentials(credentials.mode, credentials.keyId, credentials.keySecret, credentials.webhookSecret)
        logger.info(`✅ Razorpay configured (${credentials.mode} — dashboard-managed)`)
        return
      }
    } catch (err) {
      logger.error({ err }, 'Failed to load Razorpay settings from the database — falling back to env vars')
    }
  }

  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    applyCredentials('ENV', env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET, env.RAZORPAY_WEBHOOK_SECRET)
    logger.info('✅ Razorpay configured (env var fallback — no dashboard credentials active yet)')
  } else {
    clearCredentials()
    logger.warn('⚠️  Razorpay not configured — payment features will fail')
  }
}

export function getRazorpayKeyId() {
  return activeKeyId
}

export function getRazorpayKeySecret() {
  return activeKeySecret
}

export function getRazorpayWebhookSecret() {
  return activeWebhookSecret
}

export function getRazorpayMode() {
  return activeMode
}

// Synchronous best-effort initial value so a very early caller sees the
// env-var fallback rather than null; refreshRazorpayClient() at boot
// supersedes this.
if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
  applyCredentials('ENV', env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET, env.RAZORPAY_WEBHOOK_SECRET)
}
