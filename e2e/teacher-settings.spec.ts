import { test, expect } from '@playwright/test'
import {
  createSession, deleteSession, fillFormToStyleStep, teacherLoginUi,
} from './helpers'

/**
 * 설정 > 사용 가능 스타일 · 화질.
 *
 * Separate from acceptance.spec.ts, which is frozen to the PRD §9 criteria, and
 * from teacher-panels.spec.ts, which covers the day-before panels. What is
 * being checked here is narrower and nastier: both controls change something a
 * student is in the middle of, or spend the teacher's money, and both have a
 * way of appearing to work while doing nothing.
 */

const SETTINGS = { name: '설정' }

test.describe('teacher settings', () => {
  test.beforeEach(async ({ page }) => {
    await teacherLoginUi(page)
  })

  test('화질 prints the price on the button and asks before the 4x one', async ({ page }) => {
    const code = await createSession(page.request)
    try {
      await page.goto('/teacher')
      const settings = page.locator('section', { has: page.getByRole('heading', SETTINGS) })
      await expect(settings).toBeVisible()

      // The number is the point. A teacher who learns the multiplier from the
      // invoice learned it too late, so it sits on the control itself.
      await expect(settings.getByText('장당 $0.041', { exact: false })).toBeVisible()
      await expect(settings.getByText('장당 $0.165', { exact: false })).toBeVisible()
      await expect(settings.getByText('장당 $0.005', { exact: false })).toBeVisible()
      await expect(settings.getByText('보통의 약 4배')).toBeVisible()

      // Buttons are addressed by their price, not by the Korean word: 보통
      // appears inside the 높음 button too, in its 보통의 약 4배 warning.
      const quality = (price: string) =>
        settings.getByRole('button').filter({ hasText: `장당 $${price}` })

      // A new session starts at the env default, 보통.
      await expect(quality('0.041')).toHaveAttribute('aria-pressed', 'true')

      // Dismissing the question must leave the session alone — this is the
      // control that multiplies the bill.
      page.once('dialog', (d) => {
        expect(d.message()).toContain('4배')
        return d.dismiss()
      })
      await quality('0.165').click()
      await expect(quality('0.041')).toHaveAttribute('aria-pressed', 'true')

      // Accepting really does change it.
      page.once('dialog', (d) => d.accept())
      await quality('0.165').click()
      await expect(quality('0.165')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })

      // 낮음 is a saving, so it goes straight through with no question.
      await quality('0.005').click()
      await expect(quality('0.005')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
    } finally {
      await deleteSession(page.request, code)
    }
  })

  test('the last remaining style cannot be switched off', async ({ page }) => {
    const code = await createSession(page.request)
    try {
      await page.goto('/teacher')
      const settings = page.locator('section', { has: page.getByRole('heading', SETTINGS) })
      const anime = settings.getByRole('button', { name: /애니메이션/ })

      // Two off, accepting the "students already picking it" question each time.
      page.on('dialog', (d) => d.accept())
      for (const name of [/실사/, /수채화/]) {
        await settings.getByRole('button', { name }).click()
        await expect(settings.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false', {
          timeout: 15_000,
        })
      }

      // The third is refused in the browser rather than by a 400 from zod's
      // .min(1) — a server error here would read as "the app is broken".
      await anime.click()
      await expect(page.getByText('그림은 하나 이상 켜 두어야 해요')).toBeVisible()
      await expect(anime).toHaveAttribute('aria-pressed', 'true')
    } finally {
      await deleteSession(page.request, code)
    }
  })

  /**
   * The case the whole server-side check exists for.
   *
   * A phone reads allowed_styles ONCE, when it joins. A student already on
   * step 5 therefore still has the card the teacher just removed — and
   * POST /api/jobs would accept it, because its zod enum lists all three. The
   * student must be told, not silently drawn, and must not lose their answers.
   */
  test('a style switched off mid-form sends the student back to step 5, not to a dead end', async ({
    page,
    browser,
  }) => {
    const code = await createSession(page.request)
    try {
      const student = await browser.newContext({ viewport: { width: 360, height: 780 } })
      const sp = await student.newPage()
      await sp.goto(`/s/${code}`)
      await fillFormToStyleStep(sp, '무대에서 노래를 부르고 있어요')

      // All three are on the phone, and 실사 is the pick.
      await expect(sp.getByRole('button', { name: /실사/ })).toBeVisible()
      await sp.getByRole('button', { name: /실사/ }).click()
      await expect(sp.getByRole('button', { name: '그림 그리기' })).toBeEnabled()

      // The teacher switches it off while that phone sits on step 5.
      const patched = await page.request.patch(`/api/teacher/sessions/${code}`, {
        data: { allowedStyles: ['anime', 'watercolor'] },
      })
      expect(patched.ok()).toBeTruthy()

      // The phone knows nothing yet — it has not talked to the server since it
      // joined — so the tap is the moment of truth.
      await sp.getByRole('button', { name: '그림 그리기' }).click()

      // Scoped with filter(): Next's route announcer is also role="alert".
      await expect(
        sp.getByRole('alert').filter({ hasText: '선생님이 이 그림은 잠시 껐어요' }),
      ).toBeVisible()
      // The card is gone and the selection with it, so the button cannot be
      // pressed again on a choice that no longer exists.
      await expect(sp.getByRole('button', { name: /실사/ })).toHaveCount(0)
      await expect(sp.getByRole('button', { name: '그림 그리기' })).toBeDisabled()

      // Nothing was charged and nothing was lost: one tap on a style that IS
      // allowed and the same five answers go through.
      await sp.getByRole('button', { name: /수채화/ }).click()
      await sp.getByRole('button', { name: '그림 그리기' }).click()
      await expect(sp.getByRole('button', { name: '그림 저장하기' })).toBeVisible({ timeout: 90_000 })

      // Two attempts were configured and only one was spent.
      await expect(sp.getByRole('button', { name: /다시 그리기 \(남은 1회\)/ })).toBeVisible()
      await student.close()
    } finally {
      await deleteSession(page.request, code)
    }
  })

  test('a student joining after the change never sees the removed style', async ({
    page,
    browser,
  }) => {
    const code = await createSession(page.request)
    try {
      const patched = await page.request.patch(`/api/teacher/sessions/${code}`, {
        data: { allowedStyles: ['anime'] },
      })
      expect(patched.ok()).toBeTruthy()

      const student = await browser.newContext({ viewport: { width: 360, height: 780 } })
      const sp = await student.newPage()
      await sp.goto(`/s/${code}`)
      await fillFormToStyleStep(sp, '연구실에서 실험을 하고 있어요')

      await expect(sp.getByRole('button', { name: /애니메이션/ })).toBeVisible()
      await expect(sp.getByRole('button', { name: /실사/ })).toHaveCount(0)
      await expect(sp.getByRole('button', { name: /수채화/ })).toHaveCount(0)
      await student.close()
    } finally {
      await deleteSession(page.request, code)
    }
  })
})
