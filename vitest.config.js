import { defineConfig } from 'vitest/config'

// Required env so config modules import cleanly in every test environment.
// Integration tests use the docker-compose defaults (raahi_db/raahi_user).
process.env.JWT_ACCESS_SECRET ||= 'test-access-secret-0123456789abcdef0123456789abcdef'
process.env.JWT_REFRESH_SECRET ||= 'test-refresh-secret-0123456789abcdef0123456789abcdef'
process.env.DB_NAME ||= 'raahi_db'
process.env.DB_USER ||= 'raahi_user'
process.env.DB_PASSWORD ||= 'raahi_password_dev'
process.env.LOG_LEVEL ||= 'warn'
process.env.DISABLE_SOCKETIO ||= 'true'
process.env.DB_POOL_MIN ||= '1'
process.env.DB_POOL_MAX ||= '3'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{js,mjs}'],
    testTimeout: 30000,
    // Integration suites share one Postgres/Redis (docker compose) — test
    // files must not run against it concurrently.
    fileParallelism: false,
  },
})
