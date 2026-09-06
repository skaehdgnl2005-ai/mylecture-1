import { type APIRequestContext, type Page, expect } from '@playwright/test'

export const PASSWORD = process.env.TEACHER_PASSWORD ?? 'test1234'

export async function teacherLogin(request: APIRequestContext) {
  const res = await request.post('/api/teacher/login', { data: { password: PASSWORD } })
  expect(res.ok()).toBeTruthy()
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
