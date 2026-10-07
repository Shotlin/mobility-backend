/**
 * Seed a dashboard super admin: node scripts/seed-admin.js [phone] [password]
 * Password is bcrypt-hashed; the account role is SUPER_ADMIN.
 */
import bcrypt from 'bcrypt'
import pg from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const phone = process.argv[2] || '+919999000001'
const password = process.argv[3] || process.env.ADMIN_SEED_PASSWORD || 'ChangeMe!2026'
const digits = phone.replace(/[^\d]/g, '').slice(-10)

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
})

const hash = await bcrypt.hash(password, 10)
const { rows } = await pool.query(
  `INSERT INTO users (phone_e164, role, full_name, password_hash)
   VALUES ($1, 'SUPER_ADMIN', 'Super Admin', $2)
   ON CONFLICT (phone_e164) DO UPDATE SET role = 'SUPER_ADMIN', password_hash = $2
   RETURNING id, role`,
  [`+91${digits}`, hash],
)
console.log(`✅ Super admin ready: +91${digits} (role=${rows[0].role}, id=${rows[0].id})`)
await pool.end()
