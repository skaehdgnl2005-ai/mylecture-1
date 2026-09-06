/**
 * Proves the two properties the whole design rests on, against real Postgres.
 *
 *  A. claim_job() never dispenses slots faster than the configured rate, no
 *     matter how many callers race — the property an in-process semaphore
 *     cannot provide on an autoscaling serverless host.
 *  B. reserve_attempt() never lets a device exceed per_device_limit and never
 *     lets a session exceed total_limit, under simultaneous submissions,
 *     including double-taps sharing an idempotency key.
 *
 * Run against the docker Postgres:
 *   PGURL=postgres://postgres:test@localhost:55432/mirae pnpm tsx scripts/verify-gate.ts
 */
import { Client, Pool } from 'pg'

const URL = process.env.PGURL ?? 'postgres://postgres:test@localhost:55432/mirae'
const pool = new Pool({ connectionString: URL, max: 30 })

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function reset(admin: Client, opts: { perDevice?: number; total?: number } = {}) {
  await admin.query(`delete from job_events; delete from images; delete from jobs;
                     delete from devices; delete from sessions;
                     update pacer set next_slot_at = now();`)
  await admin.query(
    `insert into sessions (code, per_device_limit, total_limit, per_minute_limit)
     values ('TEST', $1, $2, 5)`,
    [opts.perDevice ?? 2, opts.total ?? 50],
  )
}

async function seedJobs(admin: Client, n: number) {
  const device = '11111111-1111-1111-1111-111111111111'
  await admin.query(
    `insert into devices (id, session_code, label) values ($1,'TEST','test') on conflict do nothing`,
    [device],
  )
  for (let i = 0; i < n; i++) {
    await admin.query(
      `insert into jobs (session_code, device_id, idempotency_key, attempt_no, inputs, action_en)
       values ('TEST', $1, $2, 1, '{}'::jsonb, 'doing something')`,
      [device, `seed-${i}`],
    )
  }
}

// ── A. the rate gate ────────────────────────────────────────────────────────
async function testRateGate() {
  console.log('\nA. claim_job() rate gate under concurrent claimers')
  const admin = new Client({ connectionString: URL })
  await admin.connect()
  await reset(admin)
  await seedJobs(admin, 40)

  const SPACING_MS = 300 // scaled down so the test runs in seconds
  const MAX_IN_FLIGHT = 4
  const WINDOW_MS = 3000

  const claims: number[] = []
  const t0 = Date.now()

  // 20 concurrent claimers, exactly like 20 phones polling at once.
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      while (Date.now() - t0 < WINDOW_MS) {
        const { rows } = await pool.query(
          'select * from claim_job($1,$2,$3)',
          [SPACING_MS, MAX_IN_FLIGHT, 'fifo'],
        )
        if (rows[0]?.id) {
          claims.push(Date.now() - t0)
          // Simulate the generation completing so in-flight does not saturate.
          await pool.query(
            `update jobs set status='done', lease_expires_at=null where id=$1`,
            [rows[0].id],
          )
        } else {
          await new Promise((r) => setTimeout(r, 25))
        }
      }
    }),
  )

  const theoreticalMax = Math.ceil(WINDOW_MS / SPACING_MS) + 1
  check(
    `dispensed ${claims.length} slots in ${WINDOW_MS}ms (ceiling ${theoreticalMax})`,
    claims.length <= theoreticalMax,
    `${claims.length} <= ${theoreticalMax}`,
  )

  // No two consecutive claims closer together than the spacing (minus clock slop).
  let minGap = Infinity
  for (let i = 1; i < claims.length; i++) minGap = Math.min(minGap, claims[i] - claims[i - 1])
  check(
    `minimum gap between claims >= spacing`,
    claims.length < 2 || minGap >= SPACING_MS - 20,
    `min gap ${minGap === Infinity ? 'n/a' : minGap + 'ms'} vs ${SPACING_MS}ms`,
  )

  await admin.end()
}

// ── A2. concurrency bound ───────────────────────────────────────────────────
async function testInFlightBound() {
  console.log('\nA2. claim_job() respects MAX_IN_FLIGHT when nothing completes')
  const admin = new Client({ connectionString: URL })
  await admin.connect()
  await reset(admin)
  await seedJobs(admin, 40)

  // Spacing 0 so only the in-flight bound can stop it. Nothing is marked done,
  // so every claim stays 'running' and holds a slot.
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      pool.query('select * from claim_job($1,$2,$3)', [0, 3, 'fifo']),
    ),
  )
  const claimed = results.filter((r) => r.rows[0]?.id).length
  check(`claimed ${claimed} with MAX_IN_FLIGHT=3`, claimed <= 3, `${claimed} <= 3`)

  const { rows } = await admin.query(
    `select count(*)::int as n from jobs where status='running' and lease_expires_at > now()`,
  )
  check('running rows match', rows[0].n <= 3, `running=${rows[0].n}`)
  await admin.end()
}

// ── B. quota under simultaneous submission ──────────────────────────────────
async function testQuota() {
  console.log('\nB. reserve_attempt() caps under simultaneous taps')
  const admin = new Client({ connectionString: URL })
  await admin.connect()
  await reset(admin, { perDevice: 2, total: 50 })

  const device = '22222222-2222-2222-2222-222222222222'

  // 10 simultaneous distinct submissions from ONE device, limit 2.
  const r1 = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      pool.query(`select * from reserve_attempt('TEST',$1,$2,'{}'::jsonb,'원문','doing something',null)`, [
        device,
        `tap-${i}`,
      ]),
    ),
  )
  const ok1 = r1.filter((r) => r.rows[0].ok).length
  check(`device got ${ok1} of 10 attempts with per_device_limit=2`, ok1 === 2, `${ok1} === 2`)

  const reasons = r1.filter((r) => !r.rows[0].ok).map((r) => r.rows[0].reason)
  check('all refusals cite quota', reasons.every((x) => x === 'quota'), reasons.join(','))

  // Double-tap: same idempotency key, fired 8 times at once.
  await reset(admin, { perDevice: 2, total: 50 })
  const r2 = await Promise.all(
    Array.from({ length: 8 }, () =>
      pool.query(`select * from reserve_attempt('TEST',$1,'same-key','{}'::jsonb,'원문','doing something',null)`, [
        device,
      ]),
    ),
  )
  const created = r2.filter((r) => r.rows[0].ok).length
  const dupes = r2.filter((r) => r.rows[0].reason === 'duplicate').length
  const { rows: jobCount } = await admin.query(`select count(*)::int as n from jobs`)
  check(`one tap created ${jobCount[0].n} job`, jobCount[0].n === 1, `created=${created} duplicate=${dupes}`)

  // Session cap with 20 distinct devices.
  await reset(admin, { perDevice: 2, total: 5 })
  const r3 = await Promise.all(
    Array.from({ length: 20 }, (_, i) => {
      const d = `33333333-3333-3333-3333-${String(i).padStart(12, '0')}`
      return pool.query(`select * from reserve_attempt('TEST',$1,$2,'{}'::jsonb,'원문','doing something',null)`, [
        d,
        `k-${i}`,
      ])
    }),
  )
  const ok3 = r3.filter((r) => r.rows[0].ok).length
  check(`session cap held: ${ok3} of 20 accepted with total_limit=5`, ok3 === 5, `${ok3} === 5`)

  await admin.end()
}

// ── C. failure does not consume the attempt ─────────────────────────────────
async function testFailureDoesNotCharge() {
  console.log('\nC. failed and lease-expired jobs do not consume the attempt')
  const admin = new Client({ connectionString: URL })
  await admin.connect()
  await reset(admin, { perDevice: 2, total: 50 })
  const device = '44444444-4444-4444-4444-444444444444'

  await pool.query(`select * from reserve_attempt('TEST',$1,'a','{}'::jsonb,'원문','x',null)`, [device])
  await pool.query(`select * from reserve_attempt('TEST',$1,'b','{}'::jsonb,'원문','x',null)`, [device])
  let used = (await admin.query(`select used_quota('TEST',$1) as n`, [device])).rows[0].n
  check('two queued jobs consume 2', used === 2, `used=${used}`)

  const third = await pool.query(
    `select * from reserve_attempt('TEST',$1,'c','{}'::jsonb,'원문','x',null)`, [device])
  check('third submission refused', third.rows[0].reason === 'quota', third.rows[0].reason)

  await admin.query(`update jobs set status='failed' where idempotency_key='a'`)
  used = (await admin.query(`select used_quota('TEST',$1) as n`, [device])).rows[0].n
  check('a failure gives the attempt back', used === 1, `used=${used}`)

  const retry = await pool.query(
    `select * from reserve_attempt('TEST',$1,'d','{}'::jsonb,'원문','x',null)`, [device])
  check('student may submit again after a failure', retry.rows[0].ok === true)

  // A crashed worker: status stays 'running' but the lease expires.
  await admin.query(
    `update jobs set status='running', lease_expires_at = now() - interval '1 minute'
      where idempotency_key='b'`)
  used = (await admin.query(`select used_quota('TEST',$1) as n`, [device])).rows[0].n
  check('an expired lease stops counting without any reaper run', used === 1, `used=${used}`)

  await admin.end()
}

// ── D. FIFO vs attempt-priority ordering ────────────────────────────────────
async function testOrdering() {
  console.log('\nD. queue ordering')
  const admin = new Client({ connectionString: URL })
  await admin.connect()
  await reset(admin, { perDevice: 2, total: 50 })

  const early = '55555555-5555-5555-5555-555555555555'
  const late = '66666666-6666-6666-6666-666666666666'
  await admin.query(`insert into devices (id, session_code, label) values ($1,'TEST','e'),($2,'TEST','l')`, [early, late])

  // early device submits its 1st and 2nd; late device then submits its 1st.
  await admin.query(`insert into jobs (session_code, device_id, idempotency_key, attempt_no, inputs, action_en, created_at)
    values ('TEST',$1,'e1',1,'{}'::jsonb,'x', now() - interval '30 s'),
           ('TEST',$1,'e2',2,'{}'::jsonb,'x', now() - interval '20 s'),
           ('TEST',$2,'l1',1,'{}'::jsonb,'x', now() - interval '10 s')`, [early, late])

  const fifo = await pool.query(`select * from claim_job(0, 10, 'fifo')`)
  check('fifo takes the oldest job', fifo.rows[0].idempotency_key === 'e1', fifo.rows[0].idempotency_key)
  await admin.query(`update jobs set status='queued', lease_expires_at=null`)
  await admin.query(`update pacer set next_slot_at = now()`)

  await admin.query(`update jobs set status='done' where idempotency_key='e1'`)
  const ap = await pool.query(`select * from claim_job(0, 10, 'attempt_priority')`)
  check(
    "attempt_priority serves the late student's 1st before the early student's 2nd",
    ap.rows[0].idempotency_key === 'l1',
    ap.rows[0].idempotency_key,
  )

  await admin.end()
}

async function main() {
  await testRateGate()
  await testInFlightBound()
  await testQuota()
  await testFailureDoesNotCharge()
  await testOrdering()
  await pool.end()
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
