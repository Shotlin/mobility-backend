import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config({ override: true })

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false
  }
  return value
}, z.boolean())

// Optional string that tolerates `VAR=` empty lines in .env files — an
// empty string is treated as unset, not as a validation failure.
const emptyToUndefined = (value) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

const optionalStr = z.preprocess(emptyToUndefined, z.string().optional())

/** Optional secret with a minimum length when actually provided. */
const optionalSecret = (min = 32) =>
  z.preprocess(emptyToUndefined, z.string().min(min).optional())

const envSchema = z.object({
  // ── Server ─────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4500),
  HOST: z.string().default('0.0.0.0'),
  API_VERSION: z.string().default('v1'),
  APP_NAME: z.string().default('Raahi Mobility'),
  FRONTEND_URL: z.string().url().optional(),
  ADMIN_URL: z.string().url().optional(),
  CORS_ORIGINS: z.string().default(
    'http://localhost:3000,http://localhost:4501,http://localhost:5173',
  ),

  // ── Auth / JWT (spec 05 §3) ────────────────────────────────────
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('30d'),
  COOKIE_SECRET: optionalSecret(16),
  // AES-256-GCM key for encrypting provider secrets at rest (Razorpay
  // webhook secret, Ola Maps key) — see utils/encryption.js.
  SETTINGS_ENCRYPTION_KEY: optionalSecret(32),

  // ── PostgreSQL (spec 03 §8: small pools behind PgBouncer) ──────
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string(),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_POOL_MIN: z.coerce.number().default(2),
  // Spec 07 §6: 5-10 active connections per API process; PgBouncer absorbs scale.
  DB_POOL_MAX: z.coerce.number().default(10),
  DB_IDLE_TIMEOUT: z.coerce.number().default(30000),
  DB_CONNECTION_TIMEOUT: z.coerce.number().default(2000),
  DB_CONNECT_RETRIES: z.coerce.number().default(20),
  DB_CONNECT_RETRY_DELAY: z.coerce.number().default(1000),
  DB_STATEMENT_TIMEOUT: z.coerce.number().default(10000),
  DB_SSL: booleanFromEnv.default(false),

  // ── Redis (spec 03 §9 purpose-split clients) ───────────────────
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: optionalStr,
  REDIS_DB: z.coerce.number().default(0),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().default(2000),
  REDIS_TTL_DEFAULT: z.coerce.number().default(600),

  // ── OTP / SMS (spec 06 §4: 3/15min, 8/day) ─────────────────────
  OTP_EXPIRY_SECONDS: z.coerce.number().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
  OTP_LOCKOUT_SECONDS: z.coerce.number().default(1800),
  OTP_LENGTH: z.coerce.number().default(6),
  ALLOW_DEMO_OTP: booleanFromEnv.default(false),
  DEMO_OTP_PHONES: optionalStr,
  DEMO_OTP_CODE: z.string().regex(/^\d{4,8}$/).default('123456'),
  TWO_FACTOR_API_KEY: optionalStr,
  TWO_FACTOR_TEMPLATE: z.string().default('RaahiRideOTP'),
  SMS_PROVIDER: z.enum(['2factor', 'none']).default('none'),

  // ── Rate limiting (spec 06 §4 starting budgets) ────────────────
  RATE_LIMIT_ENABLED: booleanFromEnv.default(true),
  RATE_LIMIT_MAX: z.coerce.number().default(120),
  RATE_LIMIT_WINDOW: z.coerce.number().default(60000),
  OTP_REQUEST_MAX_PER_15MIN: z.coerce.number().default(3),
  OTP_REQUEST_MAX_PER_DAY: z.coerce.number().default(8),
  RIDE_CREATE_MAX_PER_MIN: z.coerce.number().default(6),
  QUOTE_MAX_PER_MIN: z.coerce.number().default(30),
  DRIVER_ACCEPT_MAX_PER_MIN: z.coerce.number().default(20),

  // ── Dispatch (spec 04 §12-14, dashboard-configurable overrides) ─
  DISPATCH_WAVE_RADIUS_M: z.string().default('1500,3000,6000'),
  DISPATCH_WAVE_SIZE: z.string().default('8,16,32'),
  DISPATCH_OFFER_TTL_S: z.coerce.number().default(12),
  DISPATCH_MAX_SEARCH_S: z.coerce.number().default(45),
  DISPATCH_CANDIDATE_STALE_GPS_S: z.coerce.number().default(120),
  DISPATCH_CLAIM_TTL_S: z.coerce.number().default(5),

  // ── Location publishing (spec 04 §10-11) ───────────────────────
  LOCATION_MIN_INTERVAL_IDLE_MS: z.coerce.number().default(15000),
  LOCATION_MIN_INTERVAL_TO_PICKUP_MS: z.coerce.number().default(5000),
  LOCATION_MIN_INTERVAL_ON_TRIP_MS: z.coerce.number().default(3000),
  LOCATION_MOVEMENT_THRESHOLD_M: z.coerce.number().default(25),
  LOCATION_BREADCRUMB_SAMPLE_S: z.coerce.number().default(15),
  PRESENCE_TTL_S: z.coerce.number().default(90),

  // ── Pricing defaults (DB fare_rules override per city/zone/category) ─
  PRICING_VERSION: z.string().default('v1'),
  QUOTE_TTL_S: z.coerce.number().default(120),

  // ── Razorpay (spec 05 §7) ──────────────────────────────────────
  RAZORPAY_KEY_ID: optionalStr,
  RAZORPAY_KEY_SECRET: optionalStr,
  RAZORPAY_WEBHOOK_SECRET: optionalStr,
  RAZORPAY_CURRENCY: z.string().default('INR'),

  // ── Cloudinary (private KYC/safety evidence storage, spec 05 §6) ─
  CLOUDINARY_CLOUD_NAME: optionalStr,
  CLOUDINARY_API_KEY: optionalStr,
  CLOUDINARY_API_SECRET: optionalStr,
  CLOUDINARY_UPLOAD_PRESET: optionalStr,
  CLOUDINARY_FOLDER: z.string().default('raahi'),

  // ── Ola Maps (server-side only; never shipped to apps) ─────────
  OLA_MAPS_API_KEY: optionalStr,
  OLA_MAPS_BASE_URL: z.string().default('https://api.olamaps.io'),
  OLA_MAPS_TIMEOUT_MS: z.coerce.number().default(5000),
  OLA_MAPS_MAX_RETRIES: z.coerce.number().default(2),
  OLA_MAPS_CONCURRENCY: z.coerce.number().default(20),

  // ── Safety (spec 10) ───────────────────────────────────────────
  SAFETY_PIN_ATTEMPT_LIMIT: z.coerce.number().default(3),
  SAFETY_PIN_LOCKOUT_S: z.coerce.number().default(300),
  SAFETY_GUARDIAN_WINDOW_MIN: z.coerce.number().default(15),
  SAFETY_GUARDIAN_REMINDER_MIN: z.coerce.number().default(5),
  SAFETY_ROUTE_DEVIATION_MIN_M: z.coerce.number().default(1500),
  SAFETY_UNEXPECTED_STOP_MIN_S: z.coerce.number().default(300),

  // ── File upload ────────────────────────────────────────────────
  MAX_FILE_SIZE: z.coerce.number().default(5242880),
  ALLOWED_IMAGE_TYPES: z.string().default('image/jpeg,image/png,image/webp'),

  // ── Logging / observability (spec 08) ──────────────────────────
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  LOG_PRETTY: booleanFromEnv.default(false),
  ENABLE_SWAGGER: booleanFromEnv.optional(),
  // Sample rate for high-frequency location logs (0-1). Location coordinates
  // are never logged at INFO in production (spec 08 §10).
  LOCATION_LOG_SAMPLE_RATE: z.coerce.number().default(0),

  // ── Feature flags / boot guards ────────────────────────────────
  STRICT_SESSION_VERSION_CHECK: booleanFromEnv.default(false),
  DISABLE_SOCKETIO: booleanFromEnv.default(false),
  MAINTENANCE_MODE: booleanFromEnv.default(false),

  // ── FCM ────────────────────────────────────────────────────────
  FIREBASE_PROJECT_ID: optionalStr,
  FIREBASE_PRIVATE_KEY: optionalStr,
  FIREBASE_CLIENT_EMAIL: optionalStr,
  FCM_ENABLED: booleanFromEnv.default(false),

  // ── BullMQ (separate connection config for later queue split) ──
  BULL_REDIS_HOST: optionalStr,
  BULL_REDIS_PORT: z.coerce.number().optional(),
  BULL_REDIS_PASSWORD: optionalStr,
  BULL_CONCURRENCY: z.coerce.number().default(5),
  // Worker deployment unit (spec 03 §3): general | dispatch | notification | payments | safety | all
  WORKER_PROCESS: z.enum(['general', 'dispatch', 'notification', 'payments', 'safety', 'all']).default('general'),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = {
  ...parsed.data,
  ENABLE_SWAGGER:
    parsed.data.ENABLE_SWAGGER ?? parsed.data.NODE_ENV !== 'production',
}

/**
 * Dispatch wave plan parsed from env: [{radiusM, size}] — the dashboard
 * dispatch-config module overrides these per city at runtime (spec 04 §13).
 */
export function dispatchWaves() {
  const radii = env.DISPATCH_WAVE_RADIUS_M.split(',').map((n) => Number(n.trim()))
  const sizes = env.DISPATCH_WAVE_SIZE.split(',').map((n) => Number(n.trim()))
  const count = Math.max(radii.length, sizes.length)
  return Array.from({ length: count }, (_, i) => ({
    radiusM: radii[i] ?? radii[radii.length - 1],
    size: sizes[i] ?? sizes[sizes.length - 1],
  })).filter((w) => w.radiusM > 0 && w.size > 0)
}
