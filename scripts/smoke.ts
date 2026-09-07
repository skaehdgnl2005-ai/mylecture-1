/**
 * End-to-end smoke test against a running server.
 *
 * Walks the PRD §9 acceptance criteria that can be checked without a browser.
 * Playwright covers the UI flows; this covers the API contract and the
 * invariants that matter most (quota, safety attribution, anonymity).
 *
 * Requires MOCK_OPENAI=1 so it costs nothing and does not consume the class's
 * images-per-minute budget.
 *
 *   pnpm tsx scripts/smoke.ts [--url http://127.0.0.1:3000] [--password test1234]
 */
import 'dotenv/config'
import { config } from 'dotenv'
import { randomUUID } from 'node:crypto'

config({ path: '.env.local', override: true })

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const BASE = arg('url', process.env.APP_URL ?? 'http://127.0.0.1:3000')
const PASSWORD = arg('password', process.env.TEACHER_PASSWORD ?? 'test1234')

let cookie = ''
let failures = 0
let checks = 0

function check(name: string, ok: boolean, detail = '') {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text)
  } catch {
    body = { _raw: text.slice(0, 200) }
  }
  return { status: res.status, body, headers: res.headers }
}

const submit = (code: string, deviceId: string, rawText: string, idem: string, extra = {}) =>
  api('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      code, deviceId, idempotencyKey: idem, rawText,
      visibleDetail: '', place: 'stage', companions: ['friends'],
      mood: 'excited', time: 'sunset', style: 'anime', gender: 'unspecified',
      ...extra,
    }),
  })

type LiveStats = { done: number; queued: number; running: number; estimatedCostUsd: number }

const liveStats = async (): Promise<LiveStats | null> =>
  ((await api('/api/teacher/sessions')).body.stats as LiveStats | null) ?? null

/**
 * Pump the worker until nothing is queued or running.
 *
 * Any check that compares two counts taken at different moments is otherwise
 * racing the queue: at OPENAI_IPM=5 the pacer releases one picture every ~13s,
 * so work an earlier section left behind keeps completing underneath the next
 * one — and polling a job is itself what wakes the worker. This is what makes a
 * cost snapshot mean what it says. 'tick' is fire-and-forget, so the loop is
 * cheap.
 */
async function drainQueue(timeoutMs = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await liveStats()
    if (!s || (s.queued === 0 && s.running === 0)) return true
    await api('/api/teacher/queue', {
      method: 'POST', body: JSON.stringify({ action: 'tick' }),
    })
    await new Promise((r) => setTimeout(r, 1500))
  }
  return false
}

async function main() {
  console.log(`\nSmoke test  ${BASE}\n`)

  // ── auth ────────────────────────────────────────────────────────────────
  console.log('1. teacher auth')
  const bad = await api('/api/teacher/login', {
    method: 'POST', body: JSON.stringify({ password: 'definitely-wrong' }),
  })
  check('wrong password rejected', bad.status === 401)

  const login = await api('/api/teacher/login', {
    method: 'POST', body: JSON.stringify({ password: PASSWORD }),
  })
  check('correct password accepted', login.status === 200 && login.body.ok === true)
  if (login.status !== 200) {
    console.log('\nCannot continue without a teacher session.')
    process.exit(1)
  }

  const unauth = await fetch(`${BASE}/api/teacher/sessions`)
  check('teacher API rejects a request with no cookie', unauth.status === 401)

  // ── session ─────────────────────────────────────────────────────────────
  console.log('\n2. session')
  const created = await api('/api/teacher/sessions', { method: 'POST' })
  const session = created.body.session as { code: string } | undefined
  check('session created', !!session?.code, session?.code)
  const CODE = session!.code

  const second = await api('/api/teacher/sessions', { method: 'POST' })
  const secondCode = (second.body.session as { code: string }).code
  const list = await api('/api/teacher/sessions')
  const openCount = (list.body.sessions as Array<{ status: string }>).filter((s) => s.status === 'open').length
  check('only one session is open at a time (PRD F4)', openCount === 1, `open=${openCount}`)

  // Work with the newest one from here.
  const LIVE = secondCode
  const device = randomUUID()

  // ── safety ──────────────────────────────────────────────────────────────
  console.log('\n3. safety pipeline (attribution + no quota charge)')
  const banned = await submit(LIVE, device, '술마시고 있어요', randomUUID())
  check('banned word rejected', banned.body.ok === false, String(banned.body.reason))
  check('  blamed field 1', banned.body.field === 1)
  check('  quota not charged', banned.body.quotaCharged === false)

  const harm = await submit(LIVE, device, '사라지고 싶어요', randomUUID())
  check('self-harm routed to its own tier', harm.body.reason === 'selfharm', String(harm.body.reason))
  check('  helpline shown', harm.body.helpline === true)
  check('  message carries a helpline number', String(harm.body.message).includes('1388'))

  const fp = await submit(LIVE, device, '미술 선생님이 되어 있어요', randomUUID())
  check('false positive 미술 is NOT blocked', fp.body.ok === true, String(fp.body.reason ?? ''))

  const usage1 = await api('/api/session/join', {
    method: 'POST', body: JSON.stringify({ code: LIVE, deviceId: device }),
  })
  const u1 = usage1.body.usage as { used: number; remaining: number }
  check('rejections did not consume attempts', u1.used === 1, `used=${u1.used}`)

  // ── idempotency ─────────────────────────────────────────────────────────
  console.log('\n4. double-tap')
  const dev2 = randomUUID()
  const key = randomUUID()
  const taps = await Promise.all(
    Array.from({ length: 6 }, () => submit(LIVE, dev2, '바닷가를 달리고 있어요', key)),
  )
  const jobIds = new Set(taps.map((t) => t.body.jobId).filter(Boolean))
  check('six simultaneous taps create ONE job', jobIds.size === 1, `distinct jobs=${jobIds.size}`)

  // ── quota ───────────────────────────────────────────────────────────────
  console.log('\n5. quota')
  const dev3 = randomUUID()
  const many = await Promise.all(
    Array.from({ length: 8 }, (_, i) => submit(LIVE, dev3, '무대에서 노래해요', `q-${i}-${randomUUID()}`)),
  )
  const accepted = many.filter((m) => m.body.ok === true).length
  check('per-device limit of 2 holds under 8 simultaneous submissions', accepted === 2, `accepted=${accepted}`)
  const refusal = many.find((m) => m.body.ok === false)
  check('  third submission is refused with reason=quota', refusal?.body.reason === 'quota', String(refusal?.body.reason))

  // ── drain ───────────────────────────────────────────────────────────────
  console.log('\n6. queue drains')
  const deadline = Date.now() + 180_000
  let done = 0
  let queued = 1
  while (Date.now() < deadline && queued > 0) {
    await new Promise((r) => setTimeout(r, 2000))
    // Wake the worker on every pass. GET /api/teacher/queue deliberately does
    // NOT pump (README: the dashboard's refresh only redraws), and this script
    // does not poll a job's status here — so the only thing draining the queue
    // was the single tick that POST /api/jobs kicked off at submit time. That
    // tick stops at SOFT_DEADLINE_MS = 240s, and when it did, this loop sat
    // watching an OPEN pacer slot and a non-empty queue with nothing running:
    // observed as 'done=1 pending=3' for the full 180s, about one run in three.
    //
    // In production pg_cron pumps every 10s and this cannot happen. It happens
    // locally because pump_worker() reads app_url and worker_secret out of
    // Vault and returns silently when they are unset — which is also exactly
    // what a deploy with an unset Vault app_url looks like from outside:
    // work queued, slot open, nothing running.
    await api('/api/teacher/queue', {
      method: 'POST', body: JSON.stringify({ action: 'tick' }),
    })
    const q = await api(`/api/teacher/queue?code=${LIVE}`)
    const jobs = q.body.jobs as Array<{ status: string }>
    done = jobs.filter((j) => j.status === 'done').length
    queued = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length
    process.stdout.write(`\r     done=${done} pending=${queued}   `)
  }
  console.log('')
  check('every job reached a terminal state', queued === 0, `pending=${queued}`)
  check('at least one image was produced', done > 0, `done=${done}`)

  // ── gallery anonymity ───────────────────────────────────────────────────
  console.log('\n7. gallery anonymity (PRD F2 / §9)')
  const g = await api(`/api/gallery/${LIVE}`)
  const items = g.body.items as Array<Record<string, unknown>>
  check('gallery returns images', items.length > 0, `${items.length} items`)
  const keys = new Set(items.flatMap((i) => Object.keys(i)))
  check('exposes ONLY id/url/tags', [...keys].every((k) => ['id', 'url', 'tags'].includes(k)), [...keys].join(','))
  const raw = JSON.stringify(g.body)
  check('no created_at / device_id anywhere', !raw.includes('created_at') && !raw.includes('device_id'))
  check('no Korean free-text sentence leaked', !raw.includes('노래해요') && !raw.includes('선생님'))

  const etag = g.headers.get('etag')
  const cached = await fetch(`${BASE}/api/gallery/${LIVE}`, { headers: { 'if-none-match': etag! } })
  check('unchanged gallery poll returns 304', cached.status === 304, `status=${cached.status}`)

  const missing = await fetch(`${BASE}/api/gallery/ZZZZ`)
  check('unknown session code is not browsable', missing.status === 404)

  // ── teacher hide ────────────────────────────────────────────────────────
  console.log('\n8. teacher hide (PRD §9: gone within 5s)')
  const first = items[0] as { id: string }
  await api(`/api/teacher/images/${first.id}`, {
    method: 'PATCH', body: JSON.stringify({ isHidden: true }),
  })
  const after = await api(`/api/gallery/${LIVE}`)
  const stillThere = (after.body.items as Array<{ id: string }>).some((i) => i.id === first.id)
  check('hidden image disappears on the next poll', !stillThere)

  await api(`/api/teacher/images/${first.id}`, {
    method: 'PATCH', body: JSON.stringify({ isHidden: false }),
  })
  const restored = await api(`/api/gallery/${LIVE}`)
  check('restore brings it back', (restored.body.items as Array<{ id: string }>).some((i) => i.id === first.id))

  // ── student removes own ────────────────────────────────────────────────
  console.log('\n9. student takes their own picture down, and puts it back')
  const notMine = await fetch(`${BASE}/api/gallery/image/${first.id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: randomUUID() }),
  })
  check('another device cannot remove it', notMine.status === 404)

  // Which pictures belong to this device? (POST, so the device UUID never lands
  // in an access log — see the route header.)
  const mine = async (deviceId: string) =>
    api(`/api/gallery/${LIVE}/mine`, { method: 'POST', body: JSON.stringify({ deviceId }) })

  const ownedBefore = await mine(dev2)
  const owned = ownedBefore.body.items as Array<{ id: string; url: string; inGallery: boolean }>
  check('a device can list its own pictures', owned.length > 0, `${owned.length} owned`)
  const ownedKeys = new Set(owned.flatMap((o) => Object.keys(o)))
  check(
    '  and gets ONLY id/url/inGallery',
    // The length guard is not decoration: `every` on an empty set is true, so
    // without it this check would pass loudest exactly when the route is broken.
    ownedKeys.size === 3 && [...ownedKeys].every((k) => ['id', 'url', 'inGallery'].includes(k)),
    [...ownedKeys].join(','),
  )
  const strangerOwned = await mine(randomUUID())
  check(
    '  an unknown device gets an empty list, not a 404 (no existence oracle)',
    strangerOwned.status === 200 && (strangerOwned.body.items as unknown[]).length === 0,
    `status=${strangerOwned.status}`,
  )
  check(
    '  the ownership lookup never reveals which device owns a picture',
    !JSON.stringify(ownedBefore.body).includes('device'),
  )

  const target = owned[0].id
  const removed = await fetch(`${BASE}/api/gallery/image/${target}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: dev2 }),
  })
  const afterRemove = await api(`/api/gallery/${LIVE}`)
  check(
    'the owner CAN take it down, and it leaves the gallery',
    removed.status === 200 && !(afterRemove.body.items as Array<{ id: string }>).some((i) => i.id === target),
  )

  // The bug this route was added for: the result screen's toggle could turn OFF
  // but had no way back ON, so flipping it back changed the UI and nothing else.
  const putBack = await fetch(`${BASE}/api/gallery/image/${target}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: dev2 }),
  })
  const afterRestore = await api(`/api/gallery/${LIVE}`)
  check(
    'and CAN put it back (PUT is the inverse of DELETE)',
    putBack.status === 200 && (afterRestore.body.items as Array<{ id: string }>).some((i) => i.id === target),
    `status=${putBack.status}`,
  )
  const notMineRestore = await fetch(`${BASE}/api/gallery/image/${target}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: randomUUID() }),
  })
  check('another device cannot put it back either', notMineRestore.status === 404)

  // A teacher-hidden picture: the student may still take it down (a harmless
  // no-op that keeps their switch working) but must NOT be able to un-hide it.
  await api(`/api/teacher/images/${target}`, {
    method: 'PATCH', body: JSON.stringify({ isHidden: true }),
  })
  const hiddenList = await mine(dev2)
  check(
    'a hidden picture disappears from the student list, with no explanation',
    !(hiddenList.body.items as Array<{ id: string }>).some((i) => i.id === target),
  )
  const takeDownHidden = await fetch(`${BASE}/api/gallery/image/${target}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: dev2 }),
  })
  check('the owner can still take down a hidden picture', takeDownHidden.status === 200)
  const unhideAttempt = await fetch(`${BASE}/api/gallery/image/${target}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: dev2 }),
  })
  const afterUnhide = await api(`/api/gallery/${LIVE}`)
  check(
    'but CANNOT undo a teacher hide with 다시 올리기',
    unhideAttempt.status === 404 &&
      !(afterUnhide.body.items as Array<{ id: string }>).some((i) => i.id === target),
    `status=${unhideAttempt.status}`,
  )
  await api(`/api/teacher/images/${target}`, {
    method: 'PATCH', body: JSON.stringify({ isHidden: false }),
  })

  // The ETag must notice a swap that leaves the count unchanged — one student
  // restoring while another removes, inside the same 5-second poll window.
  const before = await api(`/api/gallery/${LIVE}`)
  const beforeTag = before.headers.get('etag')!
  const others = (before.body.items as Array<{ id: string }>).filter((i) => i.id !== target)
  await fetch(`${BASE}/api/gallery/image/${target}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: dev2 }),
  })
  await api(`/api/teacher/images/${others[0].id}`, {
    method: 'PATCH', body: JSON.stringify({ isHidden: true }),
  })
  const swapped = await fetch(`${BASE}/api/gallery/${LIVE}`, { headers: { 'if-none-match': beforeTag } })
  check(
    'a count-preserving gallery swap still busts the shared ETag',
    swapped.status === 200,
    `status=${swapped.status}`,
  )
  await api(`/api/teacher/images/${others[0].id}`, {
    method: 'PATCH', body: JSON.stringify({ isHidden: false }),
  })

  // ── teacher device reset ───────────────────────────────────────────────
  console.log('\n10. per-device quota panel (PRD §F3)')
  const listed = await api(`/api/teacher/session-images?code=${LIVE}`)
  const devices = listed.body.devices as Array<{
    id: string
    label: string
    count: number
    used: number
    resetAt: string | null
  }>
  const dev3Row = devices.find((d) => d.id === dev3)
  check('the teacher list carries a quota-derived `used` per device', dev3Row?.used === 2, `used=${dev3Row?.used}`)
  check('  and an anonymous label, never the UUID', !!dev3Row?.label && dev3Row.label !== dev3, dev3Row?.label)

  const reset = await api(`/api/teacher/devices/${dev3}/reset`, {
    method: 'POST',
    body: JSON.stringify({ sessionCode: LIVE }),
  })
  const afterReset = await api(`/api/teacher/session-images?code=${LIVE}`)
  const dev3After = (afterReset.body.devices as typeof devices).find((d) => d.id === dev3)
  check('reset returns the attempts', reset.body.ok === true && dev3After?.used === 0, `used=${dev3After?.used}`)
  // The distinction the panel exists to show: a reset moves `used`, never the
  // picture count, so the two numbers must disagree here.
  check('  but leaves the pictures alone', (dev3After?.count ?? 0) === (dev3Row?.count ?? -1))
  check('  and records when it happened', !!dev3After?.resetAt)

  const canDrawAgain = await submit(LIVE, dev3, '숲에서 사진을 찍고 있어요', randomUUID())
  check('  the student really can draw again', canDrawAgain.body.ok === true, String(canDrawAgain.body.reason ?? ''))

  // ── preflight ──────────────────────────────────────────────────────────
  console.log('\n11. 수업 전 점검 (the shape PreflightPanel renders)')
  const pre = await api('/api/health/preflight')
  const pchecks = pre.body.checks as Array<{ name: string; ok: boolean; detail: string }>
  check('preflight returns five checks', Array.isArray(pchecks) && pchecks.length === 5, `${pchecks?.length}`)
  check(
    '  each has name/ok/detail',
    pchecks.every((c) => typeof c.name === 'string' && typeof c.ok === 'boolean' && typeof c.detail === 'string'),
  )
  const expectations = pre.body.expectations as { fortyImagesMinutes: number; note: string }
  check(
    '  and the 40-image estimate the lesson plan is built on',
    typeof expectations?.fortyImagesMinutes === 'number' && expectations.fortyImagesMinutes > 0,
    `${expectations?.fortyImagesMinutes}분`,
  )
  const pcfg = pre.body.config as Record<string, unknown>
  check(
    '  plus the config strip fields',
    ['imageModel', 'quality', 'imagesPerMinute', 'spacingMs', 'maxInFlight', 'queueOrder'].every((k) => k in pcfg),
  )
  const preNoAuth = await fetch(`${BASE}/api/health/preflight`)
  check('  preflight is behind the teacher password', preNoAuth.status === 401)

  // ── style samples ──────────────────────────────────────────────────────
  console.log('\n12. style samples (PRD §F4)')
  const samplesNoAuth = await fetch(`${BASE}/api/teacher/style-samples`)
  check('style samples are behind the teacher password', samplesNoAuth.status === 401)
  const samples = await api('/api/teacher/style-samples')
  check('the panel can read the pinned samples', Array.isArray(samples.body.samples))

  // ── queue labels ───────────────────────────────────────────────────────
  console.log('\n13. queue screen')
  const queueAll = await api('/api/teacher/queue')
  const queueJobs = queueAll.body.jobs as Array<{ deviceLabel: string; action_en: string | null }>
  check(
    'the 대기열 screen names the device even without a ?code=',
    queueJobs.length > 0 && queueJobs.every((j) => j.deviceLabel !== '알 수 없음'),
    queueJobs[0]?.deviceLabel,
  )
  check(
    '  and shows the English clause, never the Korean sentence',
    !JSON.stringify(queueJobs).includes('노래해요'),
  )

  // ── 사용 가능 스타일 ────────────────────────────────────────────────────
  // The teacher setting is worth nothing unless the SERVER honours it: every
  // phone in the room read allowed_styles once, when it joined, so a client-side
  // filter alone leaves the change doing nothing for the whole class.
  console.log('\n14. 사용 가능 스타일')
  const styleDevice = randomUUID()
  const joinBefore = await api('/api/session/join', {
    method: 'POST', body: JSON.stringify({ code: LIVE, deviceId: styleDevice }),
  })
  const usedBefore = (joinBefore.body.usage as { used: number }).used

  const restrict = await api(`/api/teacher/sessions/${LIVE}`, {
    method: 'PATCH', body: JSON.stringify({ allowedStyles: ['anime'] }),
  })
  check('teacher can restrict which styles students may pick', restrict.body.ok === true)

  const joinAfter = await api('/api/session/join', {
    method: 'POST', body: JSON.stringify({ code: LIVE, deviceId: randomUUID() }),
  })
  check(
    '  a phone joining now sees only the allowed ones',
    JSON.stringify((joinAfter.body.session as { allowedStyles: string[] }).allowedStyles) === '["anime"]',
  )

  const offStyle = await submit(LIVE, styleDevice, '공방에서 그릇을 빚어요', randomUUID(), {
    style: 'watercolor',
  })
  check(
    'a switched-off style is refused rather than silently drawn',
    offStyle.body.reason === 'style_disabled',
    String(offStyle.body.reason),
  )
  check(
    '  and the refusal carries the current list, so step 5 drops the dead card',
    JSON.stringify(offStyle.body.allowedStyles) === '["anime"]',
    JSON.stringify(offStyle.body.allowedStyles),
  )
  check('  the refusal is a 200, not an error status', offStyle.status === 200)
  check('  quota not charged', offStyle.body.quotaCharged === false)

  const joinAfterRefusal = await api('/api/session/join', {
    method: 'POST', body: JSON.stringify({ code: LIVE, deviceId: styleDevice }),
  })
  check(
    '  and the attempt really is still there',
    (joinAfterRefusal.body.usage as { used: number }).used === usedBefore,
    `used ${usedBefore} -> ${(joinAfterRefusal.body.usage as { used: number }).used}`,
  )

  const onStyle = await submit(LIVE, styleDevice, '공방에서 의자를 만들어요', randomUUID(), {
    style: 'anime',
  })
  check('an allowed style still goes through', onStyle.body.ok === true, String(onStyle.body.message ?? ''))

  const noStyles = await api(`/api/teacher/sessions/${LIVE}`, {
    method: 'PATCH', body: JSON.stringify({ allowedStyles: [] }),
  })
  check('the last style cannot be switched off', noStyles.status === 400)

  await api(`/api/teacher/sessions/${LIVE}`, {
    method: 'PATCH', body: JSON.stringify({ allowedStyles: ['anime', 'photo', 'watercolor'] }),
  })

  // ── 화질 ───────────────────────────────────────────────────────────────
  // The per-image prices are pinned here on purpose. `medium` was $0.045 in the
  // code and $0.041 in the PRD; OpenAI's list says $0.041, and this is what
  // stops the wrong one drifting back in — the teacher's 예상 비용 and the price
  // printed on the 화질 buttons are both this constant.
  console.log('\n15. 화질')
  // Settle the queue before snapshotting. Everything finished in this lesson so
  // far was drawn at 'medium'; if leftovers are still trickling in they will be
  // drawn at 'high' a moment from now and this snapshot would be stale.
  check('the queue settles before the cost is measured', await drainQueue())
  const doneNow = (await liveStats())!.done

  const toHigh = await api(`/api/teacher/sessions/${LIVE}`, {
    method: 'PATCH', body: JSON.stringify({ imageQuality: 'high' }),
  })
  check(
    'teacher can change the image quality',
    (toHigh.body.session as { image_quality: string })?.image_quality === 'high',
    String((toHigh.body.session as { image_quality: string })?.image_quality),
  )
  // Everything drawn so far in this lesson was drawn at 'medium'. Switching the
  // session to 'high' must NOT re-price it: the money was already spent at the
  // old quality. This check used to assert the opposite — doneNow x $0.165 —
  // which is precisely the bug migration 0008 closes. A teacher who tapped 높음
  // at minute 8 watched minutes 0-7 jump 33x and had to decide, on that number,
  // whether they could afford to finish the lesson.
  const cost = async () => (await liveStats())!.estimatedCostUsd

  const highCost = await cost()
  check(
    '  a mid-lesson 화질 change does not re-price finished pictures',
    highCost === Math.round(doneNow * 0.041 * 100) / 100,
    `${highCost} for ${doneNow} drawn at medium`,
  )

  // The other half of the same claim: a picture drawn AFTER the switch really is
  // billed at high. Without this, the check above would also pass if the console
  // had simply stopped counting.
  await api(`/api/teacher/sessions/${LIVE}`, {
    method: 'PATCH', body: JSON.stringify({ totalLimit: 50 }),
  })
  const hqSubmit = await submit(LIVE, randomUUID(), '도서관에서 책을 고르고 있어요', randomUUID())
  check('a picture can be submitted at high', hqSubmit.body.ok === true, String(hqSubmit.body.message ?? ''))

  check('  the queue settles again', await drainQueue())
  const hqStatus = String((await api(`/api/jobs/${hqSubmit.body.jobId}`)).body.status)
  check('  and it is drawn', hqStatus === 'done', hqStatus)

  // The queue was empty on both sides of the submit, so this is exactly the one
  // picture — nothing left over can have slipped into the difference.
  const drawnAtHigh = (await liveStats())!.done - doneNow
  check('  exactly one picture was drawn at high', drawnAtHigh === 1, String(drawnAtHigh))

  const mixedCost = await cost()
  const expectedMixed = Math.round((doneNow * 0.041 + drawnAtHigh * 0.165) * 100) / 100
  check(
    '  pictures drawn at high cost $0.165, the earlier ones still $0.041',
    mixedCost === expectedMixed,
    `${mixedCost} vs ${expectedMixed} (${doneNow} medium + ${drawnAtHigh} high)`,
  )

  // And back down: dropping to medium must not refund the high picture either.
  // The prices are still pinned here — $0.041 was the PRD's figure against the
  // $0.045 the code used to carry, and $0.165 is the 높음 button's number.
  await api(`/api/teacher/sessions/${LIVE}`, {
    method: 'PATCH', body: JSON.stringify({ imageQuality: 'medium' }),
  })
  const medCost = await cost()
  check(
    '  and switching back to medium does not refund it (PRD §5-2 prices)',
    medCost === expectedMixed,
    `${medCost} vs ${expectedMixed}`,
  )

  const badQuality = await api(`/api/teacher/sessions/${LIVE}`, {
    method: 'PATCH', body: JSON.stringify({ imageQuality: 'ultra' }),
  })
  check('an unknown quality is refused', badQuality.status === 400)

  // ── session cap ────────────────────────────────────────────────────────
  console.log('\n16. session cap')
  await api(`/api/teacher/sessions/${LIVE}`, {
    method: 'PATCH', body: JSON.stringify({ totalLimit: 1 }),
  })
  const capped = await submit(LIVE, randomUUID(), '숲에서 걷고 있어요', randomUUID())
  check(
    'session cap refuses with the right Korean message',
    capped.body.reason === 'session_cap' && String(capped.body.message).includes('오늘 그림은 모두 그렸어요'),
    `${capped.body.reason}: ${capped.body.message}`,
  )

  // ── draining ───────────────────────────────────────────────────────────
  console.log('\n17. 수업 닫기 drains instead of discarding')
  // Section 16 pinned the session cap at 1 to prove the refusal. Lift it again,
  // or this section measures that instead of what it means to.
  await api(`/api/teacher/sessions/${LIVE}`, {
    method: 'PATCH', body: JSON.stringify({ totalLimit: 50 }),
  })
  const drainDevice = randomUUID()
  const inFlight = await submit(LIVE, drainDevice, '공방에서 의자를 만들고 있어요', randomUUID())
  check('a picture is waiting when the teacher closes', inFlight.body.ok === true)

  await api(`/api/teacher/sessions/${LIVE}`, {
    method: 'PATCH', body: JSON.stringify({ status: 'draining' }),
  })
  const joinWhileDraining = await api('/api/session/join', {
    method: 'POST', body: JSON.stringify({ code: LIVE, deviceId: randomUUID() }),
  })
  check(
    'a draining session takes no new students',
    joinWhileDraining.body.ok === false && joinWhileDraining.body.closed === true,
  )
  const submitWhileDraining = await submit(LIVE, randomUUID(), '바다에서 헤엄쳐요', randomUUID())
  check('and no new submissions', submitWhileDraining.body.ok === false)

  // The picture already in the queue must still be drawn, and the session must
  // close itself once it is. Closing straight to 'closed' would strand it: the
  // worker's tick() returns immediately with no open or draining session.
  const drainDeadline = Date.now() + 120_000
  let drained = false
  while (Date.now() < drainDeadline && !drained) {
    await new Promise((r) => setTimeout(r, 2000))
    const st = await api(`/api/jobs/${inFlight.body.jobId}`)
    if (st.body.status === 'done' || st.body.status === 'failed') drained = true
  }
  const finalJob = await api(`/api/jobs/${inFlight.body.jobId}`)
  check(
    'the picture already in the queue is still drawn',
    finalJob.body.status === 'done',
    String(finalJob.body.status),
  )
  let drainedRow: { code: string; status: string } | undefined
  const closeDeadline = Date.now() + 30_000
  while (Date.now() < closeDeadline) {
    const listNow = await api('/api/teacher/sessions')
    drainedRow = (listNow.body.sessions as Array<{ code: string; status: string }>).find(
      (s) => s.code === LIVE,
    )
    if (drainedRow?.status === 'closed') break
    await new Promise((r) => setTimeout(r, 2000))
  }
  check(
    'and the session closes itself when the queue is empty',
    drainedRow?.status === 'closed',
    String(drainedRow?.status),
  )

  // ── 지난 수업 정리 ──────────────────────────────────────────────────────
  // 수업 전 점검's 대기열 row has always told teachers to go and 정리 the
  // leftovers; this is the action that makes that instruction true.
  //
  // The leftovers are made the way real ones are made: starting a new lesson
  // hard-closes the previous one (POST /api/teacher/sessions), stranding
  // whatever was still queued. Two jobs go in, the pacer holds the second for a
  // full spacing interval, and the lesson is closed underneath it.
  console.log('\n18. 지난 수업 정리')
  const oldCode = (await api('/api/teacher/sessions', { method: 'POST' })).body.session as {
    code: string
  }
  const held = await submit(oldCode.code, randomUUID(), '숲에서 사진을 찍어요', randomUUID())
  const stranded = await submit(oldCode.code, randomUUID(), '카페에서 커피를 내려요', randomUUID())
  check('two pictures are in the old lesson', held.body.ok === true && stranded.body.ok === true)

  // Closes oldCode outright, exactly as a teacher starting the next class does.
  const newCode = (await api('/api/teacher/sessions', { method: 'POST' })).body.session as {
    code: string
  }
  const keep = await submit(newCode.code, randomUUID(), '무대에서 노래를 불러요', randomUUID())
  check('and one is in the lesson that is open now', keep.body.ok === true)

  const beforeSweep = (await api('/api/teacher/queue')).body.closedLeftovers as number
  check('the queue screen counts the old lesson leftovers', beforeSweep > 0, String(beforeSweep))

  const sweep = await api('/api/teacher/queue', {
    method: 'POST', body: JSON.stringify({ action: 'sweep' }),
  })
  check('정리 reports what it cleared', sweep.body.ok === true && (sweep.body.swept as number) > 0, String(sweep.body.swept))

  const afterJobs = (await api('/api/teacher/queue')).body.jobs as Array<{
    id: string
    status: string
    error_code: string | null
  }>
  const strandedRow = afterJobs.find((j) => j.id === stranded.body.jobId)
  check(
    "the old lesson's leftover is failed, not deleted",
    strandedRow?.status === 'failed' && strandedRow?.error_code === 'swept',
    `${strandedRow?.status}/${strandedRow?.error_code}`,
  )
  // The one that matters: 정리 must be safe to press while a class is running.
  const keptRow = afterJobs.find((j) => j.id === keep.body.jobId)
  check(
    'the OPEN lesson is untouched',
    !!keptRow && keptRow.error_code !== 'swept',
    `${keptRow?.status}/${keptRow?.error_code}`,
  )
  check(
    'and 수업 전 점검 would now read zero leftovers',
    ((await api('/api/teacher/queue')).body.closedLeftovers as number) === 0,
  )

  // A swept job is 'failed', and used_quota() excludes failed rows, so the
  // student keeps the attempt. Same promise as every other failure path.
  const strandedStatus = await api(`/api/jobs/${stranded.body.jobId}`)
  check(
    '  and the student keeps the attempt',
    strandedStatus.body.quotaCharged === false,
    String(strandedStatus.body.quotaCharged),
  )

  // ── worker auth ────────────────────────────────────────────────────────
  console.log('\n19. worker endpoint is not open')
  const noSecret = await fetch(`${BASE}/api/worker/tick`, { method: 'POST' })
  check('worker tick requires the shared secret', noSecret.status === 401)

  // ── cleanup ────────────────────────────────────────────────────────────
  console.log('\n20. cleanup')
  for (const c of [CODE, LIVE, oldCode.code, newCode.code]) {
    const del = await api(`/api/teacher/sessions/${c}`, {
      method: 'DELETE', body: JSON.stringify({ confirm: c }),
    })
    check(`session ${c} deleted`, del.body.ok === true, String(del.body.message ?? ''))
  }
  const wrongConfirm = await api(`/api/teacher/sessions/ZZZZ`, {
    method: 'DELETE', body: JSON.stringify({ confirm: 'nope' }),
  })
  check('delete without the matching code is refused', wrongConfirm.status === 400)

  console.log(`\n${failures === 0 ? 'ALL' : `${checks - failures}/${checks}`} CHECKS PASSED${failures ? ` — ${failures} FAILED` : ''}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\n', e)
  process.exit(1)
})
