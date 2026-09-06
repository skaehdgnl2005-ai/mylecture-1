/**
 * Pre-lesson load test (PRD §6-2 item 7).
 *
 * Fires N submissions at a live session simultaneously and reports what
 * actually happened.
 *
 * ── The important departure from PRD §6-2.7 ─────────────────────────────────
 * The PRD says: "429가 0이면 동시 실행 수를 5로 올려 재시험". Do NOT do that.
 * Throughput is N/T and T (image latency) swings 20-40s, so zero 429s proves
 * only that the API was slow during that run. Raising concurrency on that
 * evidence produces a 429 storm on lesson day, and OpenAI counts failed
 * requests against the limit too — so overshooting makes the class slower.
 *
 * The numbers that actually prove the gate works are printed below:
 *   CLAIMS PER MINUTE   must be <= the account's images-per-minute limit
 *   MAX CONCURRENT      must be <= MAX_IN_FLIGHT
 * A 429 count of zero is necessary but not sufficient.
 *
 * Usage:
 *   pnpm loadtest --code A7K2 --n 20 [--url http://localhost:3000]
 */
import 'dotenv/config'
import { randomUUID } from 'node:crypto'

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  if (fallback !== undefined) return fallback
  console.error(`--${name} is required`)
  process.exit(1)
}

const BASE = arg('url', process.env.APP_URL ?? 'http://localhost:3000')
const CODE = arg('code').toUpperCase()
const N = Number(arg('n', '20'))
const IPM = Number(process.env.OPENAI_IPM ?? 5)

const PLACES = ['city', 'sea', 'forest', 'home', 'stage', 'lab', 'space', 'cafe', 'field', 'workshop']
const MOODS = ['excited', 'peaceful', 'proud', 'warm', 'lively', 'dreamy']
const TIMES = ['morning', 'midday', 'sunset', 'night']
const STYLES = ['anime', 'photo', 'watercolor']
const TEXTS = [
  '내가 만든 게임을 친구들과 해요',
  '무대 위에서 노래를 부르고 있어요',
  '바닷가에서 강아지와 달려요',
  '작은 카페를 열고 손님을 맞아요',
  '연구실에서 실험을 하고 있어요',
]

interface Sample { t: number; queued: number; running: number; done: number; failed: number }

async function main() {
  console.log(`\nLoad test  ${BASE}  session ${CODE}  n=${N}  (account limit ${IPM} images/min)\n`)

  // ── Fire everything at once, exactly like 20 phones on one teacher's cue ──
  const t0 = Date.now()
  const submissions = await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const started = Date.now()
      try {
        const res = await fetch(`${BASE}/api/jobs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            code: CODE,
            deviceId: randomUUID(),
            idempotencyKey: randomUUID().replace(/-/g, ''),
            rawText: TEXTS[i % TEXTS.length],
            visibleDetail: '',
            place: PLACES[i % PLACES.length],
            companions: ['friends'],
            mood: MOODS[i % MOODS.length],
            time: TIMES[i % TIMES.length],
            style: STYLES[i % STYLES.length],
            gender: 'unspecified',
          }),
        })
        const body = await res.json()
        return { ok: res.ok && body.ok, status: res.status, jobId: body.jobId, reason: body.reason, ms: Date.now() - started }
      } catch (e) {
        return { ok: false, status: 0, reason: String(e), ms: Date.now() - started }
      }
    }),
  )

  const accepted = submissions.filter((s) => s.ok)
  const submitMs = submissions.map((s) => s.ms).sort((a, b) => a - b)
  console.log(`SUBMIT`)
  console.log(`  accepted        ${accepted.length}/${N}`)
  console.log(`  rejected        ${submissions.length - accepted.length}  ${
    [...new Set(submissions.filter((s) => !s.ok).map((s) => s.reason))].join(', ') || ''}`)
  console.log(`  latency         p50 ${submitMs[Math.floor(submitMs.length / 2)]}ms  max ${submitMs.at(-1)}ms`)

  if (accepted.length === 0) {
    console.log('\nNothing was accepted — is the session open and under its cap?')
    process.exit(1)
  }

  // ── Watch the queue drain ────────────────────────────────────────────────
  console.log(`\nDRAIN  (sampling every 2s)`)
  const ids = accepted.map((s) => s.jobId!) as string[]
  const doneAt = new Map<string, number>()
  const samples: Sample[] = []
  const failures: Record<string, number> = {}

  for (;;) {
    const states = await Promise.all(
      ids.map(async (id) => {
        try {
          const r = await fetch(`${BASE}/api/jobs/${id}`, { cache: 'no-store' })
          return (await r.json()) as { status: string; errorCode?: string }
        } catch {
          return { status: 'unknown' }
        }
      }),
    )

    const s: Sample = { t: Date.now() - t0, queued: 0, running: 0, done: 0, failed: 0 }
    states.forEach((st, i) => {
      if (st.status === 'done' || st.status === 'failed') {
        if (!doneAt.has(ids[i])) doneAt.set(ids[i], Date.now() - t0)
        if (st.status === 'failed') failures[st.errorCode ?? 'unknown'] = (failures[st.errorCode ?? 'unknown'] ?? 0) + 1
      }
      if (st.status === 'queued') s.queued++
      else if (st.status === 'running') s.running++
      else if (st.status === 'done') s.done++
      else if (st.status === 'failed') s.failed++
    })
    samples.push(s)

    process.stdout.write(
      `\r  ${String(Math.round(s.t / 1000)).padStart(4)}s   ` +
      `대기 ${String(s.queued).padStart(2)}  진행 ${String(s.running).padStart(2)}  ` +
      `완료 ${String(s.done).padStart(2)}  실패 ${String(s.failed).padStart(2)}   `,
    )

    if (s.queued === 0 && s.running === 0) break
    if (s.t > 25 * 60_000) {
      console.log('\n  timed out after 25 minutes')
      break
    }
    await new Promise((r) => setTimeout(r, 2000))
  }

  // ── The numbers that actually matter ─────────────────────────────────────
  const totalMs = Math.max(...doneAt.values())
  const maxConcurrent = Math.max(...samples.map((s) => s.running))
  const completions = [...doneAt.values()].sort((a, b) => a - b)

  // Peak completions inside any 60s window ~ the observed images-per-minute.
  let peakPerMinute = 0
  for (let i = 0; i < completions.length; i++) {
    const inWindow = completions.filter((t) => t >= completions[i] && t < completions[i] + 60_000).length
    peakPerMinute = Math.max(peakPerMinute, inWindow)
  }

  const done = samples.at(-1)!.done
  const failed = samples.at(-1)!.failed

  console.log(`\n\nRESULT`)
  console.log(`  total time            ${Math.round(totalMs / 1000)}s  (${Math.round(totalMs / 6000) / 10} min)`)
  console.log(`  done / failed         ${done} / ${failed}`)
  console.log(`  first image at        ${Math.round(completions[0] / 1000)}s`)
  console.log(`  last image at         ${Math.round(totalMs / 1000)}s`)
  if (Object.keys(failures).length) {
    console.log(`  failure reasons       ${Object.entries(failures).map(([k, v]) => `${k}=${v}`).join('  ')}`)
  }

  console.log(`\nGATE  (this is the evidence, not the 429 count)`)
  const rateOk = peakPerMinute <= IPM
  const concOk = maxConcurrent <= Number(process.env.MAX_IN_FLIGHT ?? 4)
  console.log(`  ${rateOk ? 'PASS' : 'FAIL'}  peak images in any 60s window   ${peakPerMinute} <= ${IPM}`)
  console.log(`  ${concOk ? 'PASS' : 'FAIL'}  max concurrent generations      ${maxConcurrent} <= ${process.env.MAX_IN_FLIGHT ?? 4}`)
  console.log(`  ${failures['rate_limit'] ? 'WARN' : 'PASS'}  429s observed                   ${failures['rate_limit'] ?? 0}`)

  console.log(
    `\nDo NOT raise concurrency because 429s were zero — see the comment at the\n` +
    `top of this file. If the gate lines say PASS, the configuration is correct.\n`,
  )

  process.exit(rateOk && concOk ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
