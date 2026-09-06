/**
 * Applies supabase/migrations/*.sql in filename order.
 *
 * Uses a direct Postgres connection (SUPABASE_DB_URL) because PostgREST cannot
 * execute DDL. Get the connection string from
 *   Supabase Dashboard > Project Settings > Database > Connection string > URI
 * and put it in .env.local as SUPABASE_DB_URL.
 *
 * Each file runs inside its own transaction, so a failure leaves the database
 * on the last good migration rather than half-applied.
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'

const DIR = path.join(process.cwd(), 'supabase', 'migrations')

async function main() {
  const url = process.env.SUPABASE_DB_URL
  if (!url) {
    console.error('SUPABASE_DB_URL is not set. See the comment at the top of this file.')
    process.exit(1)
  }

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
  if (files.length === 0) {
    console.error(`No .sql files in ${DIR}`)
    process.exit(1)
  }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await client.connect()

  try {
    await client.query(`
      create table if not exists _migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`)

    const { rows } = await client.query<{ name: string }>('select name from _migrations')
    const applied = new Set(rows.map((r) => r.name))

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  skip  ${file}`)
        continue
      }
      const sql = fs.readFileSync(path.join(DIR, file), 'utf8')
      process.stdout.write(`  apply ${file} ... `)
      try {
        await client.query('begin')
        await client.query(sql)
        await client.query('insert into _migrations (name) values ($1)', [file])
        await client.query('commit')
        console.log('ok')
      } catch (e) {
        await client.query('rollback')
        console.log('FAILED')
        console.error(`\n${file}:\n${(e as Error).message}\n`)
        process.exit(1)
      }
    }
    console.log('\nAll migrations applied.')
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
