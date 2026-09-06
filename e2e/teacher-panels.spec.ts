import { test, expect } from '@playwright/test'
import { createSession, deleteSession, fillForm, teacherLogin, teacherLoginUi } from './helpers'

/**
 * The three teacher controls the RUNBOOK already instructs teachers to use.
 *
 * Separate from acceptance.spec.ts, which is frozen to the PRD §9 criteria: a
 * failure here means "the documentation describes a button that is not there",
 * which is a different question from "does the product meet its acceptance
 * criteria".
 */

test.describe('teacher console panels', () => {
  test.beforeEach(async ({ page }) => {
    await teacherLoginUi(page)
  })

  // RUNBOOK 수업 전날 1번 — and it must work BEFORE a session exists, which is
  // the state where the console otherwise renders only 새 수업 시작.
  test('수업 전 점검 runs with no session open and shows five rows plus the 40-image estimate', async ({
    page,
  }) => {
    await page.goto('/teacher')
    const panel = page.locator('section', { has: page.getByRole('heading', { name: '수업 전 점검' }) })
    await expect(panel).toBeVisible()

    // Nothing has run yet: no result, and an explicit invitation to run one.
    await expect(panel.getByText('수업 전날 한 번 눌러 보세요', { exact: false })).toBeVisible()
    await expect(panel.getByText('지금 설정으로 40장 그리는 시간')).toHaveCount(0)

    await panel.getByRole('button', { name: '점검 시작' }).click()

    // Five named checks, each dual-coded with a word as well as a colour.
    for (const name of ['데이터베이스', '이미지 저장소', 'OpenAI 연결', '대기열', '자동 실행(pg_cron)']) {
      await expect(panel.getByText(name, { exact: true })).toBeVisible({ timeout: 90_000 })
    }
    const pills = panel.getByText(/^(정상|확인 필요)$/)
    await expect(pills).toHaveCount(5)

    // The number the lesson plan is built on.
    await expect(panel.getByText('지금 설정으로 40장 그리는 시간')).toBeVisible()
    await expect(panel.getByText('분', { exact: true })).toBeVisible()
    await expect(panel.getByText('그림 모델')).toBeVisible()
    await expect(panel.getByText('분당 한도')).toBeVisible()

    // Re-runnable, and it says when the answer was taken.
    await expect(panel.getByRole('button', { name: '다시 점검' })).toBeVisible()
    await expect(panel.getByText('기준이에요', { exact: false })).toBeVisible()
  })

  // RUNBOOK 수업 전날 3번 — the warning is the point of this test.
  test('스타일 예시 생성 warns about the class budget before it will run', async ({ page }) => {
    await page.goto('/teacher')
    const panel = page.locator('section', { has: page.getByRole('heading', { name: '스타일 예시' }) })
    await expect(panel).toBeVisible()

    await expect(panel.getByRole('button', { name: '스타일 예시 생성' })).toBeVisible()
    await expect(panel.getByText('수업 전날에 만들어 주세요', { exact: false })).toBeVisible()
    for (const style of ['애니메이션', '실사', '수채화']) {
      await expect(panel.getByText(style, { exact: true })).toBeVisible()
    }

    // A cancelled confirm must not start a run — this button spends real images.
    page.once('dialog', (d) => d.dismiss())
    await panel.getByRole('button', { name: '스타일 예시 생성' }).click()
    await expect(panel.getByRole('button', { name: '스타일 예시 생성' })).toBeEnabled()
  })

  test('an open session escalates the style-sample warning to a second question', async ({
    page,
    request,
  }) => {
    const code = await createSession(request)
    try {
      await page.goto('/teacher')
      const panel = page.locator('section', { has: page.getByRole('heading', { name: '스타일 예시' }) })
      await expect(panel.getByText('지금 수업이 열려 있어요').first()).toBeVisible()

      const asked: string[] = []
      page.on('dialog', (d) => {
        asked.push(d.message())
        // Accept the first, dismiss the second: the run must not start.
        return asked.length === 1 ? d.accept() : d.dismiss()
      })
      await panel.getByRole('button', { name: '스타일 예시 생성' }).click()
      await expect.poll(() => asked.length).toBe(2)
      expect(asked[1]).toContain('지금 수업이 열려 있어요')
    } finally {
      await deleteSession(request, code)
    }
  })

  // PRD §F3, and RUNBOOK's 학생 폰이 초기화됨 row.
  test('이 기기 횟수 초기화 gives a student their attempts back', async ({ page, request, browser }) => {
    const code = await createSession(request)
    try {
      // A student burns both attempts from their own browser context.
      const student = await browser.newContext({ viewport: { width: 360, height: 780 } })
      const sp = await student.newPage()
      await sp.goto(`/s/${code}`)
      for (let i = 1; i <= 2; i++) {
        await fillForm(sp, `무대에서 노래를 부르고 있어요 ${i}`)
        await expect(sp.getByRole('button', { name: '그림 저장하기' })).toBeVisible({ timeout: 90_000 })
        if (i === 1) await sp.getByRole('button', { name: /다시 그리기/ }).click()
      }
      await sp.reload()
      await expect(sp.getByText('그림을 모두 그렸어요. 친구들 그림을 구경해 볼까요?')).toBeVisible()

      // The teacher sees that phone with nothing left.
      await page.goto('/teacher')
      const panel = page.locator('section', { has: page.getByRole('heading', { name: /기기별 남은 횟수/ }) })
      const row = panel.locator('li').first()
      await expect(row.getByText('남은 횟수 0회')).toBeVisible({ timeout: 15_000 })
      await expect(row.getByText('그림 2장')).toBeVisible()

      page.once('dialog', (d) => d.accept())
      await row.getByRole('button', { name: /횟수 초기화/ }).click()

      // used goes back to zero; the pictures do NOT disappear. That distinction
      // is the whole reason the panel shows two numbers.
      await expect(row.getByText('남은 횟수 2회')).toBeVisible({ timeout: 15_000 })
      await expect(row.getByText('그림 2장')).toBeVisible()
      await expect(row.getByText('초기화함', { exact: false })).toBeVisible()

      // And the student can really draw again.
      await sp.reload()
      await expect(sp.getByPlaceholder('예)')).toBeVisible()
      await student.close()
    } finally {
      await teacherLogin(request)
      await deleteSession(request, code)
    }
  })
})
