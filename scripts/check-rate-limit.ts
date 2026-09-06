/**
 * Reads the account's ACTUAL images-per-minute limit. Run this before every
 * lesson (PRD §6-2 item 7).
 *
 * WHY READ IT INSTEAD OF INFERRING IT FROM A LOAD TEST:
 * a load test that produces zero 429s only proves the API was slow that run.
 * Throughput is N/T and T swings 20-40s, so the same concurrency can be safe at
 * 10:00 and 44% over the limit at 10:05. The limit is a number; read the number.
 *
 * WHY NOT READ RESPONSE HEADERS: image endpoints do not return x-ratelimit-*
 * headers at all. A header-driven throttle silently never fires.
 *
 * Needs an ADMIN key (sk-admin-...), created at
 *   platform.openai.com > Settings > Organization > Admin keys
 * A normal sk-proj- key returns 401 here. Put it in .env.local as
 * OPENAI_ADMIN_KEY, plus OPENAI_PROJECT_ID (proj_...).
 */
import 'dotenv/config'

const ADMIN = process.env.OPENAI_ADMIN_KEY
const PROJECT = process.env.OPENAI_PROJECT_ID
const MODEL = process.env.IMAGE_MODEL ?? 'gpt-image-2'

// Published gpt-image-2 ladder, for interpreting whatever we read back.
const TIERS: Array<[string, number, string]> = [
  ['Tier 1', 5, '$5 결제'],
  ['Tier 2', 20, '$50 결제'],
  ['Tier 3', 50, '$100 결제'],
  ['Tier 4', 150, '$250 결제'],
  ['Tier 5', 250, '$1,000 결제'],
]

function report(ipm: number) {
  const spacingMs = Math.ceil(60_000 / (ipm * 0.92))
  const fortyMin = Math.round((40 / (ipm * 0.92)) * 10) / 10
  const tier = TIERS.find(([, v]) => v === ipm)

  console.log(`\n  images per minute : ${ipm}${tier ? `  (${tier[0]})` : ''}`)
  console.log(`  request spacing   : ${spacingMs} ms  -> set OPENAI_IPM=${ipm}`)
  console.log(`  20 students x 2   : ~${fortyMin} minutes of pure API time`)
  if (ipm <= 5) {
    console.log(
      `\n  NOTE: lowering IMAGE_QUALITY does NOT make this faster — the limit\n` +
      `        counts IMAGES, not tokens or seconds. Only a tier upgrade does.\n` +
      `        Tier 2 ($50 prepaid, need not be spent) would make it ~2.9 min.`,
    )
  }
}

async function main() {
  if (!ADMIN || !PROJECT) {
    console.log(
      '\nOPENAI_ADMIN_KEY / OPENAI_PROJECT_ID are not set, so the real limit\n' +
      'cannot be read. Falling back to the published ladder for reference:\n',
    )
    for (const [name, ipm, qual] of TIERS) {
      console.log(`  ${name.padEnd(7)} ${String(ipm).padStart(3)} images/min   (${qual})`)
    }
    console.log(`\nCurrently configured: OPENAI_IPM=${process.env.OPENAI_IPM ?? 5}`)
    report(Number(process.env.OPENAI_IPM ?? 5))
    console.log(
      '\nTo read the real number, create an Admin key at\n' +
      '  platform.openai.com > Settings > Organization > Admin keys\n' +
      'and set OPENAI_ADMIN_KEY + OPENAI_PROJECT_ID in .env.local.\n',
    )
    return
  }

  const res = await fetch(
    `https://api.openai.com/v1/organization/projects/${PROJECT}/rate_limits`,
    { headers: { Authorization: `Bearer ${ADMIN}` } },
  )

  if (!res.ok) {
    console.error(`\nFailed (${res.status}): ${await res.text()}`)
    if (res.status === 401) {
      console.error('A normal sk-proj- key will not work here — an Admin key is required.')
    }
    process.exit(1)
  }

  const body = (await res.json()) as {
    data: Array<{ model: string; max_images_per_1_minute?: number; max_requests_per_1_minute?: number }>
  }

  console.log('\nProject rate limits:')
  for (const row of body.data) {
    const img = row.max_images_per_1_minute
    console.log(
      `  ${row.model.padEnd(24)} ` +
      `${img != null ? `${String(img).padStart(4)} images/min` : '   — images/min'}` +
      `   ${String(row.max_requests_per_1_minute ?? '—').padStart(6)} req/min`,
    )
  }

  const mine = body.data.find((r) => r.model === MODEL)
  if (!mine) {
    console.error(`\n${MODEL} is not in this project's rate-limit list. Check IMAGE_MODEL.`)
    process.exit(1)
  }
  if (mine.max_images_per_1_minute == null) {
    console.error(`\n${MODEL} reports no max_images_per_1_minute. Keep the configured value.`)
    process.exit(1)
  }

  console.log(`\n=== ${MODEL} ===`)
  report(mine.max_images_per_1_minute)

  const configured = Number(process.env.OPENAI_IPM ?? 5)
  if (configured !== mine.max_images_per_1_minute) {
    console.log(
      `\n  MISMATCH: OPENAI_IPM is ${configured} but the account allows ` +
      `${mine.max_images_per_1_minute}.\n  Update the environment variable before the lesson.`,
    )
    process.exit(2)
  }
  console.log('\n  OPENAI_IPM matches the account. Good to go.\n')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
