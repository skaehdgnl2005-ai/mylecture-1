import { test as setup, expect, request as playwrightRequest } from '@playwright/test'
import { PASSWORD, TEACHER_STATE } from './helpers'

/**
 * Logs the teacher in ONCE per run and writes the cookie to disk, which every
 * project then loads through `use.storageState`.
 *
 * WHY THIS EXISTS
 *   POST /api/teacher/login allows ten attempts a minute, keyed 'local' for
 *   every local request because there is one shared password (lib/auth.ts).
 *   That limit is the product working as intended. But Playwright gives each
 *   test a fresh browser context AND a fresh `request` context, each with its
 *   own empty cookie jar, so a suite that authenticates per test spends one or
 *   two logins per test and eventually trips it. The failure then surfaces as
 *   '잠시 뒤 다시 시도해 주세요' partway through an unrelated test — an auth bug
 *   that is not an auth bug, and one that appears only as the suite grows.
 *
 *   With this, a whole run costs one login no matter how many tests are added.
 *   helpers.ts still logs in on demand, so a test that deliberately drops the
 *   cookie can get it back.
 *
 * The teacher cookie lasts a school day, so a single one covers any run.
 */
setup('teacher login', async ({ baseURL }) => {
  // A context of its own rather than the `request` fixture: the fixture already
  // carries storageState, which on the second run would be the file this is
  // about to overwrite — and then this would assert nothing.
  const ctx = await playwrightRequest.newContext({ baseURL })
  const res = await ctx.post('/api/teacher/login', { data: { password: PASSWORD } })
  expect(res.ok(), `login failed: ${res.status()} ${await res.text()}`).toBeTruthy()
  await ctx.storageState({ path: TEACHER_STATE })
  await ctx.dispose()
})
