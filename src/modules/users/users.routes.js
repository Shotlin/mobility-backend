/**
 * Users module — passenger/driver identity profile (spec 09 §2).
 * Resource access is ownership-based: a user reads/updates only /users/me.
 */

import { query } from '../../config/database.js'
import { DomainError, ERROR_CODES } from '../../constants/errors.js'

async function usersRoutes(fastify) {
  fastify.get(
    '/me',
    {
      schema: {
        tags: ['Users'],
        summary: 'Current user profile',
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              phone: { type: 'string' },
              fullName: { type: 'string', nullable: true },
              email: { type: 'string', nullable: true },
              gender: { type: 'string', nullable: true },
              role: { type: 'string' },
              profilePhotoUrl: { type: 'string', nullable: true },
              createdAt: { type: 'string' },
            },
          },
        },
      },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const { rows } = await query(
        `SELECT id, phone_e164, full_name, email, gender, role, profile_photo_url, created_at
           FROM users WHERE id = $1`,
        [request.userId],
      )
      if (rows.length === 0) {
        throw new DomainError(ERROR_CODES.NOT_FOUND, 'User not found')
      }
      const u = rows[0]
      return {
        id: u.id,
        phone: u.phone_e164,
        fullName: u.full_name,
        email: u.email,
        gender: u.gender,
        role: u.role,
        profilePhotoUrl: u.profile_photo_url,
        createdAt: u.created_at,
      }
    },
  )

  fastify.patch(
    '/me',
    {
      schema: {
        tags: ['Users'],
        summary: 'Update own profile',
        body: {
          type: 'object',
          properties: {
            fullName: { type: 'string', minLength: 1, maxLength: 120 },
            email: { type: 'string', format: 'email', maxLength: 255 },
            gender: { type: 'string', enum: ['FEMALE', 'MALE', 'OTHER'] },
          },
          additionalProperties: false,
          minProperties: 1,
        },
      },
      preHandler: [fastify.authenticate],
    },
    async (request) => {
      const b = request.body
      const { rows } = await query(
        `UPDATE users SET
           full_name = COALESCE($2, full_name),
           email = COALESCE($3, email),
           gender = COALESCE($4, gender)
         WHERE id = $1
         RETURNING id, phone_e164, full_name, email, gender, role`,
        [request.userId, b.fullName ?? null, b.email ?? null, b.gender ?? null],
      )
      const u = rows[0]
      return {
        id: u.id,
        phone: u.phone_e164,
        fullName: u.full_name,
        email: u.email,
        gender: u.gender,
        role: u.role,
      }
    },
  )
}

export default usersRoutes
