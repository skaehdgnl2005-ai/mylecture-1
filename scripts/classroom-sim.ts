/**
 * Classroom simulation: N phones behaving like the real StudentApp.
 *
 * scripts/load-test.ts fires N submissions in one burst and then watches the
 * queue drain from ONE process polling N job ids. That proves the rate gate,
 * but it is not what a classroom does to the server. A classroom is:
 *
 *   - N phones joining within a minute of the QR going up
 *   - each phone filling the five steps at its own pace, then submitting
 *   - each phone polling /api/jobs/{id} every pollIntervalMs while waiting —
 *     and every one of those polls kicks the worker (a second Vercel
 *     invocation plus a DB round trip), so 30 phones is ~12 req/s sustained
 *   - each result screen prefetching the full-size picture through the
 *     /api/images/{id}/file proxy (a Vercel function streaming ~1MB)
 *   - phones drifting to the gallery and polling it with ETags
 *   - the teacher's laptop refreshing three routes every 4 seconds
 *   - many phones drawing a second picture
 *
 * This script does all of that, with the SAME intervals the client uses (it
 * reads pollIntervalMs from the server like the phone does), and reports what
 * the server did under it: latency percentiles per route, status codes,
 * errors, time-to-first-picture per phone, and the same GATE lines as the
 * load test. Any failed job, any 5xx, any client-side timeout is a finding.
 *
 * Costs REAL money against a real deployment: N x pictures images at the
 * session's quality, plus a cent or so of translation. Run it with
 * MOCK_OPENAI=1 locally first, and against production only with a budget.
 *
 * Usage:
 *   pnpm tsx scripts/classroom-sim.ts --url https://... --n 30 \
 *     [--code A7K2 | --password ...]   # existing session, or create one
 *     [--pictures 2]                   # per phone (default 2)
 *     [--quality low|medium|high]      # set on the created session
 *     [--stagger 60]                   # seconds over which phones submit
 *     [--gallery 0.6]                  # share of phones that open the gallery
 *     [--teacher]                      # simulate the dashboard + projector
 *     [--close]                        # 수업 닫기 (draining) at the end
 *     [--minutes 30]                   # hard stop
 *     [--out out/classroom-sim]        # JSON report dir
 */
import 'dotenv/config'
import { config } from 'dotenv'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join as pathJoin } from 'node:path'

config({ path: '.env.local', override: false })

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1) return process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : 'true'
  return fallback
}

const BASE = (arg('url', process.env.APP_URL ?? 'http://127.0.0.1:3000') as string).replace(/\/$/, '')
const N = Number(arg('n', '30'))
const PICTURES = Number(arg('pictures', '2'))
const STAGGER_S = Number(arg('stagger', '60'))
const GALLERY_SHARE = Number(arg('gallery', '0.6'))
const TEACHER = arg('teacher') === 'true'
const CLOSE = arg('close') === 'true'
const MINUTES = Number(arg('minutes', '30'))
const OUT = arg('out', 'out/classroom-sim') as string
const QUALITY = arg('quality')
const PASSWORD = arg('password', process.env.TEACHER_PASSWORD)
let CODE = arg('code')?.toUpperCase()
const IPM = Number(process.env.OPENAI_IPM ?? 5)
const MAX_IN_FLIGHT = Number(process.env.MAX_IN_FLIGHT ?? 4)
/** A phone gives up on one request after this long. School wifi is slow, not infinite. */
const REQUEST_TIMEOUT_MS = 20_000

// ── metrics ─────────────────────────────────────────────────────────────────
interface Sample { route: string; status: number; ms: number; t: number; bytes?: number }
const samples: Sample[] = []
const errors: Array<{ t: number; route: string; message: string }> = []
const t0 = Date.now()
const since = () => Date.now() - t0

/** Route label with ids collapsed, so percentiles group properly. */
function routeLabel(method: string, path: string): string {
  return `${method} ${path
    .replace(/\/api\/jobs\/[0-9a-f-]{36}.*/, '/api/jobs/{id}')
    .replace(/\/api\/images\/[0-9a-f-]{36}\/file/, '/api/images/{id}/file')
    .replace(/\/api\/gallery\/[A-Z0-9]{4}\/mine/, '/api/gallery/{code}/mine')
    .replace(/\/api\/gallery\/[A-Z0-9]{4}/, '/api/gallery/{code}')
    .replace(/\/api\/teacher\/session-images\?.*/, '/api/teacher/session-images')
    .replace(/\/api\/teacher\/qr\?.*/, '/api/teacher/qr')
    .replace(/\/api\/teacher\/sessions\/[A-Z0-9]{4}/, '/api/teacher/sessions/{code}')}`
}

let cookie = ''
async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers; ms: number; bytes: number }> {
  const label = routeLabel(method, path)
  const started = Date.now()
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie && path.startsWith('/api/teacher') ? { cookie } : {}),
        ...(cookie && path.startsWith('/api/health') ? { cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    })
    const sc = res.headers.get('set-cookie')
    if (sc) cookie = sc.split(';')[0]
    const buf = Buffer.from(await res.arrayBuffer())
    const ms = Date.now() - started
    samples.push({ route: label, status: res.status, ms, t: since(), bytes: buf.length })
    let parsed: Record<string, unknown> = {}
    if (res.status !== 304 && (res.headers.get('content-type') ?? '').includes('json')) {
      try {
        parsed = JSON.parse(buf.toString('utf8'))
      } catch {
        parsed = {}
      }
    }
    if (res.status >= 500) errors.push({ t: since(), route: label, message: `HTTP ${res.status} ${buf.toString('utf8').slice(0, 120)}` })
    return { status: res.status, body: parsed, headers: res.headers, ms, bytes: buf.length }
  } catch (e) {
    const ms = Date.now() - started
    samples.push({ route: label, status: 0, ms, t: since() })
    errors.push({ t: since(), route: label, message: String((e as Error)?.name === 'TimeoutError' ? `client timeout after ${REQUEST_TIMEOUT_MS}ms` : e) })
    return { status: 0, body: {}, headers: new Headers(), ms, bytes: 0 }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo)

// ── the classroom ───────────────────────────────────────────────────────────
const TEXTS = [
  '내가 만든 게임을 친구들과 해요',
  '무대 위에서 노래를 부르고 있어요',
  '바닷가에서 강아지와 달려요',
  '작은 카페를 열고 손님을 맞아요',
  '연구실에서 실험을 하고 있어요',
  '공방에서 의자를 만들고 있어요',
  '숲에서 사진을 찍고 있어요',
  '도서관에서 책을 고르고 있어요',
  '병원에서 환자를 돌보고 있어요',
  '요리를 만들어 친구들에게 줘요',
]
const PLACES = ['city', 'sea', 'forest', 'home', 'stage', 'lab', 'space', 'cafe', 'field', 'workshop']
const MOODS = ['excited', 'peaceful', 'proud', 'warm', 'lively', 'dreamy']
const TIMES = ['morning', 'midday', 'sunset', 'night']
const STYLES = ['anime', 'photo', 'watercolor']

type JobEnd = { jobId: string; attempt: number; submittedAt: number; endedAt: number; status: string; errorCode?: string; firstPosition?: number; polls: number; imageBytes?: number }

interface Phone {
  i: number
  deviceId: string
  joined: boolean
  joinMs?: number
  pollMs: number
  allowedStyles: string[]
  /** What this phone believes right now, for the timeline. */
  state: 'idle' | 'form' | 'queued' | 'running' | 'result' | 'gallery' | 'blocked' | 'done'
  position?: number
  jobs: JobEnd[]
  galleryPolls: number
  gallery304: number
  blockedReason?: string
}

const phones: Phone[] = Array.from({ length: N }, (_, i) => ({
  i,
  deviceId: randomUUID(),
  joined: false,
  pollMs: 2500,
  allowedStyles: STYLES,
  state: 'idle',
  jobs: [],
  galleryPolls: 0,
  gallery304: 0,
}))

let stopAll = false

async function join(p: Phone) {
  const r = await call('POST', '/api/session/join', { code: CODE, deviceId: p.deviceId })
  p.joinMs = r.ms
  if (r.status !== 200 || r.body.ok !== true) {
    p.state = 'blocked'
    p.blockedReason = `join ${r.status} ${String(r.body.message ?? '')}`
    return false
  }
  p.joined = true
  p.pollMs = Number(r.body.pollIntervalMs ?? 2500)
  const s = r.body.session as { allowedStyles?: string[] } | undefined
  if (s?.allowedStyles) p.allowedStyles = s.allowedStyles
  p.state = 'form'
  return true
}

/** One attempt: submit, then poll exactly the way StudentApp does. */
async function drawOne(p: Phone, attempt: number): Promise<JobEnd | null> {
  const idem = randomUUID().replace(/-/g, '')
  const styles = p.allowedStyles.length ? p.allowedStyles : STYLES
  const submittedAt = since()
  const r = await call('POST', '/api/jobs', {
    code: CODE,
    deviceId: p.deviceId,
    idempotencyKey: idem,
    rawText: TEXTS[(p.i + attempt) % TEXTS.length],
    visibleDetail: attempt % 3 === 0 ? '큰 창문' : '',
    place: PLACES[(p.i * 7 + attempt) % PLACES.length],
    companions: attempt % 2 ? ['friends'] : ['family', 'friends'],
    mood: MOODS[p.i % MOODS.length],
    time: TIMES[(p.i + attempt) % TIMES.length],
    style: styles[(p.i + attempt) % styles.length],
    gender: 'unspecified',
  })

  if (r.body.ok !== true) {
    const reason = String(r.body.reason ?? r.status)
    if (reason === 'quota' || reason === 'session_cap') {
      p.state = 'blocked'
      p.blockedReason = reason
      return null
    }
    // A safety rejection or a 5xx: the phone shows a message; a student retries.
    return { jobId: '', attempt, submittedAt, endedAt: since(), status: 'rejected', errorCode: reason, polls: 0 }
  }

  const jobId = String(r.body.jobId)
  p.state = 'queued'
  const end: JobEnd = { jobId, attempt, submittedAt, endedAt: 0, status: 'unknown', polls: 0 }

  await sleep(400)
  while (!stopAll) {
    const st = await call('GET', `/api/jobs/${jobId}?deviceId=${encodeURIComponent(p.deviceId)}`)
    end.polls++
    const d = st.body
    if (d.status === 'done') {
      end.status = 'done'
      end.endedAt = since()
      p.state = 'result'
      // ResultScreen prefetches the file for the share sheet the moment it mounts.
      const f = await call('GET', `/api/images/${d.imageId}/file`)
      end.imageBytes = f.bytes
      return end
    }
    if (d.status === 'failed') {
      end.status = 'failed'
      end.errorCode = String(d.errorCode ?? '')
      end.endedAt = since()
      p.state = 'form'
      return end
    }
    if (typeof d.position === 'number') {
      if (end.firstPosition === undefined) end.firstPosition = d.position
      p.position = d.position
    }
    if (d.status === 'running') p.state = 'running'
    else if (d.status === 'queued') p.state = 'queued'
    if (typeof d.pollIntervalMs === 'number') p.pollMs = d.pollIntervalMs
    await sleep(p.pollMs)
  }
  end.status = 'abandoned'
  end.endedAt = since()
  return end
}

async function galleryLoop(p: Phone) {
  // Gallery.tsx: one /mine on mount, then /api/gallery/{code} every pollIntervalMs with the ETag.
  p.state = 'gallery'
  await call('POST', `/api/gallery/${CODE}/mine`, { deviceId: p.deviceId })
  let etag: string | null = null
  let interval = Number(process.env.GALLERY_POLL_MS ?? 5000)
  while (!stopAll) {
    const r = await call('GET', `/api/gallery/${CODE}`, undefined, etag ? { 'if-none-match': etag } : {})
    p.galleryPolls++
    if (r.status === 304) p.gallery304++
    else if (r.status === 200) {
      etag = r.headers.get('etag')
      if (typeof r.body.pollIntervalMs === 'number') interval = r.body.pollIntervalMs
    }
    await sleep(interval)
  }
}

async function phoneLife(p: Phone) {
  // Phones scan the QR over the first part of the stagger window.
  await sleep(rand(0, STAGGER_S * 300))
  if (!(await join(p))) return

  for (let attempt = 1; attempt <= PICTURES && !stopAll; attempt++) {
    // Five steps take a while; second pictures start after looking at the first.
    await sleep(attempt === 1 ? rand(8_000, STAGGER_S * 1000) : rand(10_000, 40_000))
    let tries = 0
    for (;;) {
      const end = await drawOne(p, attempt)
      if (!end) return // blocked
      p.jobs.push(end)
      if (end.status === 'done') break
      // Failed or rejected: the app returns the student to the form with a fresh
      // key. A real student taps again; twice is plenty to show the pattern.
      if (++tries >= 3 || stopAll) break
      await sleep(rand(2_000, 6_000))
    }
    if (p.state === 'blocked') return
  }

  // Detached on purpose: the gallery poll runs until the lesson ends, and the
  // lesson ends when the DRAWING is done, so awaiting it here would wait for
  // itself. (It did: the first run sat at '완료 60' until the hard stop.)
  if (Math.random() < GALLERY_SHARE) void galleryLoop(p).catch(() => {})
  else p.state = 'done'
}

/**
 * The server's own numbers, from the dashboard poll. The phone-side view of
 * '그리는 중' is stale by up to one poll interval (a phone still says running
 * for ~2.5s after its picture landed), so it over-counts concurrency by one or
 * two; stats.running is a live COUNT on the jobs table, and observedIpm is the
 * number of claim_job() calls in the last 60s — the two numbers the gate is
 * actually about.
 */
let serverMaxRunning = 0
let serverPeakIpm = 0
let serverSamples = 0

async function teacherLife() {
  // TeacherConsole.load() every 4s: sessions, then session-images + qr in parallel.
  const projector = (async () => {
    let etag: string | null = null
    while (!stopAll) {
      const r = await call('GET', `/api/gallery/${CODE}`, undefined, etag ? { 'if-none-match': etag } : {})
      if (r.status === 200) etag = r.headers.get('etag')
      await sleep(Number(process.env.GALLERY_POLL_MS ?? 5000))
    }
  })()
  while (!stopAll) {
    const s = await call('GET', '/api/teacher/sessions')
    const stats = s.body.stats as { running?: number; observedIpm?: number } | null
    if (stats) {
      serverSamples++
      serverMaxRunning = Math.max(serverMaxRunning, stats.running ?? 0)
      serverPeakIpm = Math.max(serverPeakIpm, stats.observedIpm ?? 0)
    }
    await Promise.all([
      call('GET', `/api/teacher/session-images?code=${CODE}`),
      call('GET', `/api/teacher/qr?code=${CODE}`),
    ])
    await sleep(4000)
  }
  await projector
}

// ── reporting ───────────────────────────────────────────────────────────────
function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}

function timelineRow(): string {
  const c = { form: 0, queued: 0, running: 0, result: 0, gallery: 0, blocked: 0, done: 0, idle: 0 }
  for (const p of phones) c[p.state]++
  const finished = phones.reduce((a, p) => a + p.jobs.filter((j) => j.status === 'done').length, 0)
  const failed = phones.reduce((a, p) => a + p.jobs.filter((j) => j.status === 'failed' || j.status === 'rejected').length, 0)
  const rps = samples.filter((s) => s.t > since() - 10_000).length / 10
  return (
    `${String(Math.round(since() / 1000)).padStart(5)}s  ` +
    `입장전 ${c.idle}  작성 ${c.form}  대기 ${c.queued}  그리는중 ${c.running}  결과 ${c.result}  갤러리 ${c.gallery}  끝 ${c.done}  막힘 ${c.blocked}  ` +
    `| 완료 ${finished}  실패 ${failed}  | ${rps.toFixed(1)} req/s  | 5xx/timeout ${errors.length}`
  )
}

function report() {
  const byRoute = new Map<string, Sample[]>()
  for (const s of samples) byRoute.set(s.route, [...(byRoute.get(s.route) ?? []), s])

  console.log('\n\nROUTES  (latency as the phone sees it; p95 is what the slowest student in each poll cycle feels)')
  console.log('  route                                  n      p50     p95     p99     max   2xx  3xx  4xx  5xx  err')
  for (const [route, list] of [...byRoute.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const ms = list.map((s) => s.ms).sort((a, b) => a - b)
    const cls = (lo: number, hi: number) => list.filter((s) => s.status >= lo && s.status < hi).length
    console.log(
      `  ${route.padEnd(38)} ${String(list.length).padStart(5)}  ${String(pct(ms, 0.5)).padStart(6)}  ${String(pct(ms, 0.95)).padStart(6)}  ${String(pct(ms, 0.99)).padStart(6)}  ${String(ms.at(-1)).padStart(6)}  ` +
        `${String(cls(200, 300)).padStart(4)} ${String(cls(300, 400)).padStart(4)} ${String(cls(400, 500)).padStart(4)} ${String(cls(500, 600)).padStart(4)} ${String(list.filter((s) => s.status === 0).length).padStart(4)}`,
    )
  }

  const jobs = phones.flatMap((p) => p.jobs)
  const done = jobs.filter((j) => j.status === 'done')
  const failed = jobs.filter((j) => j.status === 'failed')
  const rejected = jobs.filter((j) => j.status === 'rejected')
  const firstPic = phones
    .map((p) => p.jobs.find((j) => j.status === 'done' && j.attempt === 1))
    .filter(Boolean)
    .map((j) => (j!.endedAt - j!.submittedAt) / 1000)
    .sort((a, b) => a - b)
  const waits = done.map((j) => (j.endedAt - j.submittedAt) / 1000).sort((a, b) => a - b)

  console.log('\nPHONES')
  console.log(`  joined                 ${phones.filter((p) => p.joined).length}/${N}   join latency p50 ${pct(phones.map((p) => p.joinMs ?? 0).sort((a, b) => a - b), 0.5)}ms`)
  console.log(`  blocked                ${phones.filter((p) => p.state === 'blocked').length}  ${[...new Set(phones.filter((p) => p.blockedReason).map((p) => p.blockedReason))].join(', ')}`)
  console.log(`  pictures done/failed   ${done.length} / ${failed.length}   rejected at submit ${rejected.length}`)
  if (failed.length) {
    const codes: Record<string, number> = {}
    for (const j of failed) codes[j.errorCode ?? '?'] = (codes[j.errorCode ?? '?'] ?? 0) + 1
    console.log(`  failure codes          ${Object.entries(codes).map(([k, v]) => `${k}=${v}`).join('  ')}`)
  }
  if (rejected.length) {
    const codes: Record<string, number> = {}
    for (const j of rejected) codes[j.errorCode ?? '?'] = (codes[j.errorCode ?? '?'] ?? 0) + 1
    console.log(`  rejection reasons      ${Object.entries(codes).map(([k, v]) => `${k}=${v}`).join('  ')}`)
  }
  console.log(`  wait for 1st picture   p50 ${Math.round(pct(firstPic, 0.5))}s   max ${Math.round(firstPic.at(-1) ?? 0)}s   (submit -> result screen)`)
  console.log(`  wait, all pictures     p50 ${Math.round(pct(waits, 0.5))}s   max ${Math.round(waits.at(-1) ?? 0)}s`)
  const polls = done.reduce((a, j) => a + j.polls, 0)
  console.log(`  status polls           ${jobs.reduce((a, j) => a + j.polls, 0)} total  (${done.length ? Math.round(polls / done.length) : 0} per finished picture)`)
  const gp = phones.reduce((a, p) => a + p.galleryPolls, 0)
  const g304 = phones.reduce((a, p) => a + p.gallery304, 0)
  console.log(`  gallery polls          ${gp}  of which 304 ${g304}  (${gp ? Math.round((100 * g304) / gp) : 0}%)`)
  const bytes = done.reduce((a, j) => a + (j.imageBytes ?? 0), 0)
  console.log(`  picture bytes proxied  ${(bytes / 1e6).toFixed(1)} MB through /api/images/{id}/file`)

  // The gate, from what the phones observed: completions per 60s window and
  // how many phones were in 'running' at once.
  const completions = done.map((j) => j.endedAt).sort((a, b) => a - b)
  let peakPerMinute = 0
  for (let i = 0; i < completions.length; i++) {
    peakPerMinute = Math.max(peakPerMinute, completions.filter((t) => t >= completions[i] && t < completions[i] + 60_000).length)
  }
  // With --teacher the gate is judged on the server's counts (see above); the
  // phone-side numbers are printed for reference either way.
  const rateSeen = serverSamples ? serverPeakIpm : peakPerMinute
  const concSeen = serverSamples ? serverMaxRunning : maxRunning
  const rateOk = rateSeen <= IPM
  const concOk = concSeen <= MAX_IN_FLIGHT
  console.log(`\nGATE  (${serverSamples ? `server counts, ${serverSamples} dashboard samples` : "phones' point of view — add --teacher for the server's own counts"})`)
  console.log(`  ${rateOk ? 'PASS' : 'FAIL'}  peak claims per minute                     ${rateSeen} <= ${IPM}`)
  console.log(`  ${concOk ? 'PASS' : 'FAIL'}  max generations in flight                  ${concSeen} <= ${MAX_IN_FLIGHT}`)
  console.log(`  ${errors.length === 0 ? 'PASS' : 'FAIL'}  5xx or client timeouts                     ${errors.length}`)
  console.log(`  ${failed.length === 0 ? 'PASS' : 'WARN'}  failed generations                         ${failed.length}`)
  console.log(`  info  phones: peak finished in any 60s window ${peakPerMinute}, max phones in '그리는 중' ${maxRunning} (stale by up to one poll)`)
  console.log(`  total wall clock                                 ${Math.round(since() / 1000)}s`)

  if (errors.length) {
    console.log('\nERRORS (first 20)')
    for (const e of errors.slice(0, 20)) console.log(`  ${String(Math.round(e.t / 1000)).padStart(5)}s  ${e.route}  ${e.message}`)
  }

  mkdirSync(OUT, { recursive: true })
  const file = pathJoin(OUT, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(
    file,
    JSON.stringify({ base: BASE, code: CODE, n: N, pictures: PICTURES, quality: QUALITY, stagger: STAGGER_S, teacher: TEACHER, phones, errors, samples, maxRunning, serverMaxRunning, serverPeakIpm, serverSamples }, null, 1),
  )
  console.log(`\nreport: ${file}\n`)
  return errors.length === 0 && failed.length === 0 && rateOk && concOk
}

let maxRunning = 0

async function main() {
  console.log(`\nClassroom sim  ${BASE}  phones=${N}  pictures=${PICTURES}  stagger=${STAGGER_S}s  gallery=${GALLERY_SHARE}  teacher=${TEACHER}\n`)

  if (!CODE || TEACHER || CLOSE) {
    if (!PASSWORD) {
      console.error('--password (or TEACHER_PASSWORD) is needed to create a session or simulate the teacher')
      process.exit(1)
    }
    const login = await call('POST', '/api/teacher/login', { password: PASSWORD })
    if (login.status !== 200) {
      console.error(`teacher login failed: ${login.status} ${JSON.stringify(login.body)}`)
      process.exit(1)
    }
  }
  if (!CODE) {
    const created = await call('POST', '/api/teacher/sessions', {
      perDeviceLimit: Math.min(10, PICTURES),
      totalLimit: Math.min(500, N * PICTURES + 5),
    })
    const s = created.body.session as { code?: string } | undefined
    if (!s?.code) {
      console.error(`could not create a session: ${created.status} ${JSON.stringify(created.body)}`)
      process.exit(1)
    }
    CODE = s.code
    if (QUALITY) await call('PATCH', `/api/teacher/sessions/${CODE}`, { imageQuality: QUALITY })
    console.log(`session ${CODE} created (per device ${Math.min(10, PICTURES)}, total ${N * PICTURES + 5}${QUALITY ? `, quality ${QUALITY}` : ''})`)
  } else {
    console.log(`using session ${CODE}`)
  }

  const hardStop = setTimeout(() => {
    console.log(`\n  hard stop after ${MINUTES} minutes`)
    stopAll = true
  }, MINUTES * 60_000)

  const ticker = setInterval(() => {
    const running = phones.filter((p) => p.state === 'running').length
    maxRunning = Math.max(maxRunning, running)
    process.stdout.write(`\r  ${timelineRow()}   `)
  }, 1000)

  const lives = phones.map(phoneLife)
  const teacher = TEACHER ? teacherLife() : Promise.resolve()

  // Everyone has either finished their pictures, been blocked, or is idling in
  // the gallery. Gallery loops run until stopAll, so wait on the drawing part.
  await Promise.all(lives.map((p) => p.catch((e) => errors.push({ t: since(), route: 'phone', message: String(e) }))))
  // Let the gallery pollers and the teacher run a little longer, like the last
  // minute of a lesson, then stop.
  await sleep(10_000)
  stopAll = true
  clearInterval(ticker)
  clearTimeout(hardStop)
  await teacher

  if (CLOSE) {
    const r = await call('PATCH', `/api/teacher/sessions/${CODE}`, { status: 'draining' })
    console.log(`\n  수업 닫기 -> ${(r.body.session as { status?: string })?.status ?? r.status}`)
  }

  const ok = report()
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
