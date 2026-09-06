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
  console.log('\n9. student removes their own picture')
  const notMine = await fetch(`${BASE}/api/gallery/image/${first.id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: randomUUID() }),
  })
  check('another device cannot remove it', notMine.status === 404)

  // ── session cap ────────────────────────────────────────────────────────
  console.log('\n10. session cap')
  await api(`/api/teacher/sessions/${LIVE}`, {
    method: 'PATCH', body: JSON.stringify({ totalLimit: 1 }),
  })
  const capped = await submit(LIVE, randomUUID(), '숲에서 걷고 있어요', randomUUID())
  check(
    'session cap refuses with the right Korean message',
    capped.body.reason === 'session_cap' && String(capped.body.message).includes('오늘 그림은 모두 그렸어요'),
    `${capped.body.reason}: ${capped.body.message}`,
  )

  // ── worker auth ────────────────────────────────────────────────────────
  console.log('\n11. worker endpoint is not open')
  const noSecret = await fetch(`${BASE}/api/worker/tick`, { method: 'POST' })
  check('worker tick requires the shared secret', noSecret.status === 401)

  // ── cleanup ────────────────────────────────────────────────────────────
  console.log('\n12. cleanup')
  for (const c of [CODE, LIVE]) {
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
