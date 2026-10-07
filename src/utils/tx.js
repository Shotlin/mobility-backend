/**
 * Transaction helper — wraps critical writes in a single PostgreSQL
 * transaction with the outbox pattern in mind (spec 03 §5, §11):
 * mutate rows + insert outbox events in the SAME transaction, commit once.
 *
 * Usage:
 *   const result = await withTransaction(async (client) => {
 *     ... client.query(...)
 *     await emitEvent(client, {...})
 *     return something
 *   })
 *
 * On throw: rollback and rethrow. Nested calls reuse the ambient client.
 */

import { pool } from '../config/database.js'
import { logger } from '../config/logger.js'

export async function withTransaction(work) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'Rollback failed after error')
    }
    throw err
  } finally {
    client.release()
  }
}
