/**
 * Quote request/response schemas (spec 09 §1-§2) + zod validation used by
 * the quotes service (Fastify JSON schema handles the HTTP contract).
 */

import { z } from 'zod'

export const CoordinateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
})

export const QuoteRequestSchema = z.object({
  pickup: CoordinateSchema,
  drop: CoordinateSchema,
  vehicleCategoryId: z.string().uuid().optional(), // null = all categories
  couponCode: z.string().trim().min(1).max(32).optional(),
})

export function validateQuoteRequest(body) {
  const parsed = QuoteRequestSchema.safeParse(body)
  if (!parsed.success) {
    const err = new Error('Invalid quote request')
    err.statusCode = 400
    err.code = 'VALIDATION_ERROR'
    err.details = parsed.error.flatten()
    throw err
  }
  return parsed.data
}
