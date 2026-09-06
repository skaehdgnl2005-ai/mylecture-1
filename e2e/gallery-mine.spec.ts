import { test, expect } from '@playwright/test'
import { createSession, deleteSession, fillForm, teacherLogin } from './helpers'

/**
 * PRD §F2: "학생은 본인 그림만 갤러리에서 내릴 수 있음(기기 ID로 본인 확인)".
 *
 * Until now that was only possible from the result screen, which the student
 * loses the moment they navigate away — and the switch on it could turn off but
 * never back on.
 */

test.describe('a student manages their own picture from the gallery', () => {
  let code: string

  test.beforeEach(async ({ request }) => {
    code = await createSession(request)
  })

  test.afterEach(async ({ request }) => {
    await teacherLogin(request)
    await deleteSession(request, code)
  })

  test('takes their picture down and puts it back', async ({ page }) => {
    await page.goto(`/s/${code}`)
    await fillForm(page)
    await expect(page.getByRole('button', { name: '그림 저장하기' })).toBeVisible({ timeout: 90_000 })

    await page.goto(`/g/${code}`)

    // The card is identifiable as theirs, by a word and not only by a ring.
    const myCard = page.getByRole('button', { name: '내 그림 크게 보기' })
    await expect(myCard).toHaveCount(1, { timeout: 15_000 })
    await expect(page.getByText('내 그림', { exact: true }).first()).toBeVisible()

    // The control lives in the strip, not on the card.
    const strip = page.locator('section', { has: page.getByRole('heading', { name: '내 그림' }) })
    await expect(strip.getByText('올라가 있어요')).toBeVisible()

    await strip.getByRole('button', { name: '내리기' }).click()

    // Immediate feedback, then the poll drops it within the 5s gallery interval.
    await expect(strip.getByText('내려뒀어요')).toBeVisible()
    await expect(strip.getByRole('button', { name: '다시 올리기' })).toBeVisible()
    await expect(myCard).toHaveCount(0, { timeout: 10_000 })

    await strip.getByRole('button', { name: '다시 올리기' }).click()
    await expect(strip.getByText('올라가 있어요')).toBeVisible()
    await expect(page.getByText('다시 올렸어요', { exact: false })).toBeVisible()
    await expect(myCard).toHaveCount(1, { timeout: 10_000 })
  })

  test('the result-screen toggle restores, not just removes', async ({ page }) => {
    await page.goto(`/s/${code}`)
    await fillForm(page)
    const toggle = page.getByRole('checkbox')
    await expect(page.getByRole('button', { name: '그림 저장하기' })).toBeVisible({ timeout: 90_000 })
    await expect(toggle).toBeChecked()

    // Off: the picture leaves the gallery.
    await toggle.uncheck()
    await expect
      .poll(async () => (await (await page.request.get(`/api/gallery/${code}`)).json()).items.length, {
        timeout: 10_000,
      })
      .toBe(0)

    // On again. This is the path that used to change the switch and nothing else.
    await toggle.check()
    await expect
      .poll(async () => (await (await page.request.get(`/api/gallery/${code}`)).json()).items.length, {
        timeout: 10_000,
      })
      .toBe(1)
  })

  test('a classmate sees no controls, and the projector stays anonymous', async ({
    page,
    browser,
  }) => {
    await page.goto(`/s/${code}`)
    await fillForm(page)
    await expect(page.getByRole('button', { name: '그림 저장하기' })).toBeVisible({ timeout: 90_000 })

    // A different browser = a different device id, so nothing is theirs.
    const other = await browser.newContext({ viewport: { width: 360, height: 780 } })
    const op = await other.newPage()
    await op.goto(`/g/${code}`)
    await expect(op.getByRole('button', { name: '크게 보기' })).toHaveCount(1)
    await expect(op.getByRole('heading', { name: '내 그림' })).toHaveCount(0)
    await expect(op.getByRole('button', { name: '내리기' })).toHaveCount(0)

    // Projector mode must not even ask the question — the teacher's browser
    // never acquires a device identity by displaying the class's work.
    const requests: string[] = []
    op.on('request', (r) => requests.push(r.url()))
    await op.goto(`/g/${code}?projector=1`)
    await op.waitForTimeout(1500)
    expect(requests.filter((u) => u.includes('/mine'))).toEqual([])
    expect(await op.evaluate(() => localStorage.getItem('mirae_device_id'))).toBeNull()
    await other.close()
  })
})
