import { test, expect } from '@playwright/test'
import { createSession, deleteSession, teacherLoginUi } from './helpers'

/**
 * 대기열 > 지난 수업 정리.
 *
 * 수업 전 점검's red 대기열 row has been pointing at this button since before it
 * existed. The assertion that matters is the last pair: it must be safe to
 * press with a class already running.
 */
test.describe('지난 수업 정리', () => {
  test.beforeEach(async ({ page }) => {
    await teacherLoginUi(page)
  })

  test('clears the old lesson and leaves the open one alone', async ({ page }) => {
    // Two submissions so the pacer holds the second: at 5 images/minute the
    // first is claimed at once and the next slot is ~13 seconds away, which is
    // what leaves a genuinely queued job behind when the lesson closes.
    const oldCode = await createSession(page.request)
    const device = () => crypto.randomUUID()
    const submit = (code: string) =>
      page.request.post('/api/jobs', {
        data: {
          code,
          deviceId: device(),
          idempotencyKey: crypto.randomUUID(),
          rawText: '공방에서 의자를 만들고 있어요',
          visibleDetail: '',
          place: 'workshop',
          companions: ['friends'],
          mood: 'warm',
          time: 'sunset',
          style: 'anime',
          gender: 'unspecified',
        },
      })

    await submit(oldCode)
    await submit(oldCode)

    // Starting the next class hard-closes the previous one, stranding whatever
    // was still queued. This is how real leftovers are made.
    const liveCode = await createSession(page.request)
    const kept = await submit(liveCode)
    const keptJobId = (await kept.json()).jobId as string

    try {
      await page.goto('/teacher/queue')
      const button = page.getByRole('button', { name: /지난 수업 정리/ })
      await expect(button).toBeEnabled({ timeout: 15_000 })
      await expect(button).toContainText('건')

      // It destroys student work, so it asks — and says out loud that the open
      // lesson is not in scope.
      page.once('dialog', (d) => {
        expect(d.message()).toContain('지금 열려 있는 수업은 건드리지 않아요')
        return d.accept()
      })
      await button.click()

      await expect(page.getByText('정리했어요', { exact: false })).toBeVisible({ timeout: 15_000 })
      await expect(page.getByRole('button', { name: /지난 수업 정리/ })).toBeDisabled()

      // The open lesson's job was never touched.
      const after = await (await page.request.get('/api/teacher/queue')).json()
      const keptRow = (after.jobs as Array<{ id: string; error_code: string | null }>).find(
        (j) => j.id === keptJobId,
      )
      expect(keptRow, 'the open lesson job should still be listed').toBeTruthy()
      expect(keptRow!.error_code).not.toBe('swept')

      // And the 수업 전 점검 row this button exists for would now be green.
      expect(after.closedLeftovers).toBe(0)
    } finally {
      await deleteSession(page.request, oldCode)
      await deleteSession(page.request, liveCode)
    }
  })
})
