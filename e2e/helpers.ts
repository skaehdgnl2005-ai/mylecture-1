import { type APIRequestContext, type Page, expect } from '@playwright/test'

export const PASSWORD = process.env.TEACHER_PASSWORD ?? 'test1234'

/**
 * Where auth.setup.ts parks the teacher cookie, and where every project picks
 * it up from (playwright.config.ts `use.storageState`). Gitignored.
 */
export const TEACHER_STATE = 'e2e/.auth/teacher.json'

/**
 * Logs in only if this context is not already authenticated.
 *
 * Normally it does nothing at all: auth.setup.ts logs in once per run and every
 * context starts from that saved cookie, so the `ok()` check below short
 * circuits. The POST is the fallback for a context that has genuinely lost it.
 *
 * That arrangement exists because the login route rate-limits to 10 attempts a
 * minute and every local request shares the key 'local' (one shared password —
 * that limit is the product working as intended). A suite that re-logs-in per
 * test trips it and starts failing on '잠시 뒤 다시 시도해 주세요', which looks
 * like an auth bug and is not one.
 */
export async function teacherLogin(request: APIRequestContext) {
  if ((await request.get('/api/teacher/sessions')).ok()) return
  const res = await request.post('/api/teacher/login', { data: { password: PASSWORD } })
  expect(res.ok()).toBeTruthy()
}

/**
 * Logs the teacher in through the actual form, so the browser context carries
 * the cookie. `teacherLogin(request)` only authenticates the API context, which
 * a `page.goto('/teacher')` does not share.
 */
export async function teacherLoginUi(page: Page) {
  // page.request shares this browser context's cookie jar, so one API call
  // authenticates the pages too — and skips a form round trip that would spend
  // one of the ten logins a minute the route allows (see teacherLogin above).
  await teacherLogin(page.request)
  await page.goto('/teacher')
  const password = page.getByPlaceholder('관리자 비밀번호')
  if (await password.isVisible().catch(() => false)) {
    await password.fill(PASSWORD)
    await page.getByRole('button', { name: '들어가기' }).click()
  }
  // Both screens carry an <h1>선생님 화면</h1>, so the 대기열 link — which only the
  // console has — is what proves the login actually took.
  await expect(page.getByRole('link', { name: '대기열' })).toBeVisible()
}

export async function createSession(request: APIRequestContext): Promise<string> {
  await teacherLogin(request)
  const res = await request.post('/api/teacher/sessions')
  const body = await res.json()
  expect(body.session?.code, JSON.stringify(body)).toBeTruthy()
  return body.session.code as string
}

export async function deleteSession(request: APIRequestContext, code: string) {
  await request.delete(`/api/teacher/sessions/${code}`, { data: { confirm: code } })
}

/** Walks the 5-step form with valid answers and taps 그림 그리기. */
export async function fillForm(page: Page, text = '내가 만든 게임을 친구들과 해요') {
  await page.getByPlaceholder('예)').fill(text)
  await page.getByRole('button', { name: '다음' }).click()

  await page.getByRole('checkbox', { name: '무대' }).click()
  await page.getByRole('button', { name: '다음' }).click()

  await page.getByRole('checkbox', { name: '친구들' }).click()
  await page.getByRole('button', { name: '다음' }).click()

  await page.getByRole('checkbox', { name: '설레는' }).click()
  await page.getByRole('checkbox', { name: '노을' }).click()
  await page.getByRole('button', { name: '다음' }).click()

  await page.getByRole('button', { name: /애니메이션/ }).click()
  await page.getByRole('button', { name: '그림 그리기' }).click()
}
