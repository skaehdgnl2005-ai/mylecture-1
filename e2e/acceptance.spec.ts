import { test, expect } from '@playwright/test'
import { createSession, deleteSession, fillForm, teacherLogin } from './helpers'

/**
 * PRD §9 acceptance criteria.
 *
 * Only the criteria that genuinely need a browser live here — the API-level
 * ones (safety attribution, quota arithmetic, idempotency, gallery column
 * exposure) are covered faster and more precisely by scripts/smoke.ts.
 */

test.describe('PRD §9 acceptance', () => {
  let code: string

  test.beforeEach(async ({ request }) => {
    code = await createSession(request)
  })

  test.afterEach(async ({ request }) => {
    await deleteSession(request, code)
  })

  // ①  "학생이 이름 입력 없이 QR로 입장해 5스텝 폼을 완료하고 그림을 받는다"
  test('a student joins with no name, completes 5 steps, and gets a picture', async ({ page }) => {
    await page.goto(`/s/${code}`)

    // No name field anywhere in the flow.
    await expect(page.getByPlaceholder('예)')).toBeVisible()
    await expect(page.locator('input[name*="name" i]')).toHaveCount(0)

    // Five progress dots.
    const dots = page.getByRole('progressbar')
    await expect(dots).toHaveAttribute('aria-valuemax', '5')

    await fillForm(page)

    // Waiting screen shows a real queue position, not a fake progress bar.
    await expect(page.getByText('그림을 그리고 있어요')).toBeVisible()
    await expect(page.getByText(/앞에 \d+명|이제 곧 내 차례예요/)).toBeVisible()

    // Result.
    await expect(page.getByRole('button', { name: '그림 저장하기' })).toBeVisible({ timeout: 90_000 })
    await expect(page.getByAltText('내가 그린 10년 뒤의 하루')).toBeVisible()
    await expect(page.getByRole('button', { name: /다시 그리기 \(남은 1회\)/ })).toBeVisible()
  })

  // ②  "같은 브라우저에서 3번째 생성 시도는 서버가 거부한다"
  test('the third attempt from the same browser is refused', async ({ page }) => {
    await page.goto(`/s/${code}`)

    for (let i = 1; i <= 2; i++) {
      await fillForm(page, `무대에서 노래를 부르고 있어요 ${i}`)
      await expect(page.getByRole('button', { name: '그림 저장하기' })).toBeVisible({ timeout: 90_000 })
      if (i === 1) await page.getByRole('button', { name: /다시 그리기/ }).click()
    }

    // After the second, the redraw button is gone and the gallery link is offered.
    await expect(page.getByRole('button', { name: /다시 그리기/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '친구들 그림 보기' })).toBeVisible()

    // Reloading does not grant more: the server, not the client, decides.
    await page.reload()
    await expect(page.getByText('그림을 모두 그렸어요. 친구들 그림을 구경해 볼까요?')).toBeVisible()
  })

  // ④  "교사가 그림을 숨기면 5초 이내 갤러리에서 사라진다"
  test('a teacher hide clears the gallery within 5 seconds', async ({ page, request }) => {
    await page.goto(`/s/${code}`)
    await fillForm(page)
    await expect(page.getByRole('button', { name: '그림 저장하기' })).toBeVisible({ timeout: 90_000 })

    await page.goto(`/g/${code}`)
    const card = page.getByRole('button', { name: '크게 보기' })
    await expect(card).toHaveCount(1)

    await teacherLogin(request)
    const list = await (await request.get(`/api/teacher/session-images?code=${code}`)).json()
    const imageId = list.images[0].id

    const hiddenAt = Date.now()
    await request.patch(`/api/teacher/images/${imageId}`, { data: { isHidden: true } })

    // The gallery polls on its own; no reload.
    await expect(card).toHaveCount(0, { timeout: 5000 })
    expect(Date.now() - hiddenAt).toBeLessThan(5000)
  })

  // ⑤  "갤러리에 이름·ID·시간이 노출되지 않고, 세션 코드 없이는 접근할 수 없다"
  test('the gallery is anonymous and unreachable without the code', async ({ page }) => {
    await page.goto(`/s/${code}`)
    await fillForm(page, '바닷가에서 강아지와 달려요')
    await expect(page.getByRole('button', { name: '그림 저장하기' })).toBeVisible({ timeout: 90_000 })

    // The device UUID this browser is using. It must not reach the gallery.
    const deviceId = await page.evaluate(() => localStorage.getItem('mirae_device_id'))
    expect(deviceId).toBeTruthy()

    await page.goto(`/g/${code}`)
    await expect(page.getByRole('button', { name: '크게 보기' })).toHaveCount(1)

    const html = await page.content()
    // The free sentence must never appear (PRD §F2).
    expect(html).not.toContain('강아지와 달려요')
    // No device identity.
    expect(html).not.toContain(deviceId!)
    // No timestamps in any shape (PRD: 시간 노출 없음).
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    expect(html).not.toContain('created_at')
    // NOTE: the storage object key IS a random UUID and does appear inside the
    // image URL. That is deliberate — an unguessable key is what keeps the URL
    // space non-enumerable. It carries no identity, so it is not what §9 forbids.

    // Only the chip tags are shown. fillForm() picks 무대 / 친구들 / 설레는 /
    // 노을 / 애니메이션, so those are the five tags the lightbox should carry —
    // and nothing else.
    await page.getByRole('button', { name: '크게 보기' }).click()
    for (const tag of ['무대', '친구들', '설레는', '노을', '애니메이션']) {
      await expect(page.getByText(tag, { exact: true })).toBeVisible()
    }

    // An unknown code is a 404, so the gallery cannot be browsed without one.
    const res = await page.goto('/g/ZZZZ')
    expect(res?.status()).toBe(404)
  })

  // ⑦  "세션 총 상한 도달 시 '오늘 그림은 모두 그렸어요' 안내가 뜬다"
  test('the session cap message appears when the total limit is reached', async ({ page, request }) => {
    await teacherLogin(request)
    await request.patch(`/api/teacher/sessions/${code}`, { data: { totalLimit: 1 } })

    // Burn the single allowance from another device.
    const other = await request.post('/api/jobs', {
      data: {
        code, deviceId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
        rawText: '카페에서 커피를 내려요', visibleDetail: '', place: 'cafe',
        companions: ['alone'], mood: 'peaceful', time: 'morning',
        style: 'watercolor', gender: 'unspecified',
      },
    })
    expect((await other.json()).ok).toBeTruthy()

    await page.goto(`/s/${code}`)
    await fillForm(page)
    await expect(page.getByText('오늘 그림은 모두 그렸어요')).toBeVisible()
  })
})

// ⑥  "OpenAI API 키가 클라이언트 번들·네트워크 응답 어디에도 나타나지 않는다"
test('no secret appears in any network response the browser receives', async ({ page, request }) => {
  const code = await createSession(request)
  const leaks: string[] = []

  const SECRETS = [
    process.env.OPENAI_API_KEY,
    process.env.SUPABASE_SECRET_KEY,
    process.env.WORKER_SECRET,
    process.env.TEACHER_PASSWORD,
    'sk-proj-', 'sk-admin-', 'sb_secret_', 'service_role',
  ].filter((v): v is string => !!v && v.length >= 8)

  page.on('response', async (res) => {
    const ct = res.headers()['content-type'] ?? ''
    if (!/javascript|json|html|text/.test(ct)) return
    let body = ''
    try {
      body = await res.text()
    } catch {
      return
    }
    // Match the ACTUAL configured values plus high-entropy prefixes. A bare
    // 'sk-' matches 'task-' and 'risk-' in minified JS and is useless here.
    for (const needle of SECRETS) {
      if (needle && body.includes(needle)) leaks.push(`${needle.slice(0, 12)}… in ${res.url()}`)
    }
    // The prompt vocabulary is server-only too (PRD §5-2: not shown to students).
    if (body.includes('one third of the image height')) leaks.push(`prompt text in ${res.url()}`)
  })

  await page.goto(`/s/${code}`)
  await fillForm(page)
  await expect(page.getByRole('button', { name: '그림 저장하기' })).toBeVisible({ timeout: 90_000 })
  await page.goto(`/g/${code}`)

  expect(leaks).toEqual([])
  await deleteSession(request, code)
})
