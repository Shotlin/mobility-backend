/**
 * Auth controller — thin HTTP adapter over AuthService.
 * Error envelope rendered by the global error handler (spec 09 §7).
 */

import { AuthService } from './auth.service.js'

export class AuthController {
  constructor(service = new AuthService()) {
    this.service = service
  }

  requestOtp = async (request, reply) => {
    const result = await this.service.requestOtp({
      phoneRaw: request.body.phone,
      role: request.body.role,
    })
    return reply.code(200).send(result)
  }

  verifyOtp = async (request, reply) => {
    const result = await this.service.verifyOtp({
      phoneRaw: request.body.phone,
      otp: request.body.otp,
      role: request.body.role,
      request,
    })
    return reply.code(200).send(result)
  }

  refresh = async (request, reply) => {
    const result = await this.service.refresh({
      refreshToken: request.body.refreshToken,
      request,
    })
    return reply.code(200).send(result)
  }

  logout = async (request, reply) => {
    const result = await this.service.logout({
      userId: request.userId,
      sessionId: request.session?.id,
    })
    return reply.code(200).send(result)
  }

  logoutAll = async (request, reply) => {
    const result = await this.service.logoutAll({
      userId: request.userId,
      sessionId: request.session?.id,
      actorRole: request.roles?.[0],
    })
    return reply.code(200).send(result)
  }

  listSessions = async (request) => {
    return this.service.listSessions({
      userId: request.userId,
      currentSessionId: request.session?.id,
    })
  }
}
