/**
 * Admin Ola Maps connection endpoints (spec 11 §10) — dashboard-managed
 * provider key. axios is mocked so no real Ola traffic happens; asserts the
 * test-then-connect contract: the key is saved ONLY when the live probe
 * passes, the raw key is never returned, and disconnect clears it.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

vi.mock('axios', () => ({
  default: { get: vi.fn() },
}))

import axios from 'axios'
import { buildApp } from '../../src/app.js'
import { pool } from '../../src/config/database.js'
import { flushRateLimits } from './helpers/db-clean.js'

const ADMIN_PHONE = '+919999000001'
const GOOD_KEY = 'ola-test-key-abcdef123456'
const BAD_KEY = 'ola-test-key-deadbeef000000'

async function adminToken(app) {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/admin/login',
    payload: { phone: ADMIN_PHONE, password: 'ChangeMe!2026' },
    remoteAddress: '10.11.0.9',
  })
  expect(res.statusCode).toBe(200)
  return res.json().accessToken
}

describe('admin Ola Maps connection', () => {
  let app
  let token

  beforeAll(async () => {
    await pool.query(`DELETE FROM platform_settings WHERE key = 'ola_maps_settings'`)
    await flushRateLimits()
    app = await buildApp()
    await app.ready()
    token = await adminToken(app)
  })

  afterAll(async () => {
    await pool.query(`DELETE FROM platform_settings WHERE key = 'ola_maps_settings'`)
    await app?.close()
  })

  beforeEach(() => {
    axios.get.mockReset()
  })

  it('starts disconnected with no key material leaked', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/platform/ola-maps',
      headers: { authorization: `Bearer ${token}` }, remoteAddress: '10.11.0.9',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.connected).toBe(false)
    expect(body.keyHint).toBeNull()
    expect(JSON.stringify(body)).not.toContain(GOOD_KEY)
  })

  it('test endpoint reports provider failure without saving anything', async () => {
    axios.get.mockRejectedValueOnce({ response: { status: 401 } })
    const res = await app.inject({
      method: 'POST', url: '/api/v1/admin/platform/ola-maps/test',
      headers: { authorization: `Bearer ${token}` },
      payload: { apiKey: BAD_KEY }, remoteAddress: '10.11.0.9',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/unauthorized/i)
    const status = await app.inject({
      method: 'GET', url: '/api/v1/admin/platform/ola-maps',
      headers: { authorization: `Bearer ${token}` }, remoteAddress: '10.11.0.9',
    })
    expect(status.json().connected).toBe(false)
  })

  it('connect saves the key ONLY when the test passes', async () => {
    axios.get.mockRejectedValueOnce({ response: { status: 401 } })
    const fail = await app.inject({
      method: 'PUT', url: '/api/v1/admin/platform/ola-maps',
      headers: { authorization: `Bearer ${token}` },
      payload: { apiKey: BAD_KEY }, remoteAddress: '10.11.0.9',
    })
    expect(fail.statusCode).toBe(400)
    expect(fail.json().error.code).toBe('MAPS_TEST_FAILED')

    axios.get.mockResolvedValueOnce({ status: 200, data: { status: 'OK' } })
    const ok = await app.inject({
      method: 'PUT', url: '/api/v1/admin/platform/ola-maps',
      headers: { authorization: `Bearer ${token}` },
      payload: { apiKey: GOOD_KEY }, remoteAddress: '10.11.0.9',
    })
    expect(ok.statusCode).toBe(200)
    const body = ok.json()
    expect(body.connected).toBe(true)
    expect(body.source).toBe('dashboard')
    expect(body.keyHint).toBe(`••••${GOOD_KEY.slice(-4)}`)
    expect(JSON.stringify(body)).not.toContain(GOOD_KEY)
  })

  it('the stored key decrypts to the exact value that was saved', async () => {
    const { getActiveMapsSettings } = await import('../../src/modules/ola-maps-settings/ola-maps-settings.service.js')
    const settings = await getActiveMapsSettings()
    expect(settings?.apiKey).toBe(GOOD_KEY)
    expect(settings?.enabled).toBe(true)
  })

  it('disconnect clears the stored key', async () => {
    const res = await app.inject({
      method: 'DELETE', url: '/api/v1/admin/platform/ola-maps',
      headers: { authorization: `Bearer ${token}` }, remoteAddress: '10.11.0.9',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().connected).toBe(false)
    const { getActiveMapsSettings } = await import('../../src/modules/ola-maps-settings/ola-maps-settings.service.js')
    expect(await getActiveMapsSettings()).toBeNull()
  })
})
