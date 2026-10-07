/**
 * Auth routes — /api/v1/auth (spec 09 §3).
 * JSON schemas are compiled once at registration (spec 03 §14);
 * unknown fields are stripped by ajv removeAdditional.
 */

import { AuthController } from './auth.controller.js'

const phoneSchema = {
  type: 'string',
  minLength: 10,
  maxLength: 16,
  pattern: '^[+]?[0-9]{10,14}$',
}

const otpRequestSchema = {
  tags: ['Auth'],
  summary: 'Request a login OTP (rate limited: 3/15min, 8/day per phone)',
  body: {
    type: 'object',
    required: ['phone'],
    properties: {
      phone: phoneSchema,
      role: { type: 'string', enum: ['PASSENGER', 'DRIVER'], default: 'PASSENGER' },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        sent: { type: 'boolean' },
        phone: { type: 'string' },
        expiresInS: { type: 'number' },
        demoOtp: { type: 'string' },
        smsProviderStatus: { type: 'string' },
      },
    },
  },
}

const otpVerifySchema = {
  tags: ['Auth'],
  summary: 'Verify OTP, find-or-create identity, mint session tokens',
  body: {
    type: 'object',
    required: ['phone', 'otp'],
    properties: {
      phone: phoneSchema,
      otp: { type: 'string', minLength: 4, maxLength: 8, pattern: '^[0-9]+$' },
      role: { type: 'string', enum: ['PASSENGER', 'DRIVER'], default: 'PASSENGER' },
    },
    additionalProperties: false,
  },
}

const refreshSchema = {
  tags: ['Auth'],
  summary: 'Rotate refresh token, mint new access token (replay → revoke)',
  body: {
    type: 'object',
    required: ['refreshToken'],
    properties: { refreshToken: { type: 'string', minLength: 16, maxLength: 256 } },
    additionalProperties: false,
  },
}

async function authRoutes(fastify) {
  const controller = new AuthController()

  fastify.post(
    '/otp/request',
    {
      schema: otpRequestSchema,
      config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
    },
    controller.requestOtp,
  )

  fastify.post(
    '/otp/verify',
    {
      schema: otpVerifySchema,
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    },
    controller.verifyOtp,
  )

  fastify.post(
    '/refresh',
    {
      schema: refreshSchema,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    controller.refresh,
  )

  fastify.post(
    '/logout',
    { schema: { tags: ['Auth'], summary: 'Revoke current device session' }, preHandler: [fastify.authenticate] },
    controller.logout,
  )

  fastify.post(
    '/logout-all',
    {
      schema: { tags: ['Auth'], summary: 'Revoke ALL device sessions (bumps session_version)' },
      preHandler: [fastify.authenticate],
    },
    controller.logoutAll,
  )

  fastify.get(
    '/sessions',
    {
      schema: {
        tags: ['Auth'],
        summary: 'List active device sessions',
        response: {
          200: {
            type: 'object',
            properties: {
              sessions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    deviceType: { type: 'string' },
                    ipAddress: { type: 'string' },
                    userAgent: { type: 'string' },
                    lastActiveAt: { type: 'string', nullable: true },
                    createdAt: { type: 'string' },
                    expiresAt: { type: 'string' },
                    isCurrent: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
      preHandler: [fastify.authenticate],
    },
    controller.listSessions,
  )
}

export default authRoutes

// GET /auth/me — token restore path (dashboard/mobile session bootstrap).
export async function registerMeRoute(fastify) {
  fastify.get('/me', { preHandler: [fastify.authenticate] }, async (request) => {
    const { query } = await import('../../config/database.js')
    const { rows } = await query(
      `SELECT id, phone_e164, full_name, role, profile_photo_url FROM users WHERE id = $1`,
      [request.userId],
    )
    if (rows.length === 0) throw new DomainError(ERROR_CODES.NOT_FOUND, 'User not found')
    const u = rows[0]
    return {
      id: u.id,
      phone: u.phone_e164,
      fullName: u.full_name,
      role: u.role,
      profilePhotoUrl: u.profile_photo_url,
      permissions: request.permissions || [],
    }
  })
}
