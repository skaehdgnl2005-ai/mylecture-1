/**
 * RUNBOOK 수업 전날 5 — the 24-picture age-drift grid.
 *
 * 스타일 3 × 시간 4 × 위험한 동반자 2(아이, 팬/관객) = 24장, quality `low`.
 *
 * WHAT IT IS FOR
 *   One thing about this app cannot be tested by any assertion: whether the
 *   image model draws a Korean 25-year-old as a 25-year-old. Anime style drifts
 *   youngest, and the two companions below make it worse — `아이` gives the
 *   subject a child to be the parent of, and `팬/관객` pulls the whole frame
 *   toward idol imagery. If 25 comes out looking like a high-schooler anywhere,
 *   it will be in these 24 cells. A teacher has to LOOK at them.
 *
 * WHY IT PACES ITSELF
 *   Twenty-four images fired at once IS the 429 storm the whole queue exists to
 *   prevent — and OpenAI counts failed requests against the per-minute limit, so
 *   the punishment for trying compounds. This script goes one at a time with the
 *   same spacing the app's pacer uses (60000 / (IPM * 0.92), lib/env.ts), which
 *   is strictly more conservative than claim_job(): that allows MAX_IN_FLIGHT
 *   concurrent, this allows one.
 *
 *   It deliberately does NOT go through claim_job() itself. That path needs an
 *   open session, spends the class's quota, and drops 24 test pictures into the
 *   gallery the students are about to use.
 *
 * WHY IT REFUSES TO SPEND BY DEFAULT
 *   Every other script here is free to run. This one is not, so a bare
 *   invocation prints the plan and the price and stops. `--go` is the only way
 *   to spend money.
 *
 *   pnpm tsx scripts/age-drift-grid.ts           # plan + price, draws nothing
 *   pnpm tsx scripts/age-drift-grid.ts --go      # ~$0.12, several minutes
 *
 * MOCK_OPENAI=1 in .env.local makes even --go free, which is how you check that
 * the file layout and the contact sheet work before spending anything.
 */
import 'dotenv/config'
import { config } from 'dotenv'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import OpenAI from 'openai'
import type { ImagesResponse, ImageGenerateParamsNonStreaming } from 'openai/resources/images'
import {
  buildImagePrompt, FALLBACK_ACTION, STYLE, TIME, COMPANION,
  type StyleId, type TimeId, type CompanionId,
} from '../src/lib/prompt/build-image-prompt'
import { IMAGE_COST_USD } from '../src/lib/pricing'

config({ path: '.env.local', override: true })

// ── the grid ────────────────────────────────────────────────────────────────
const STYLES: StyleId[] = ['anime', 'photo', 'watercolor']
const TIMES: TimeId[] = ['morning', 'midday', 'sunset', 'night']
/** The two the RUNBOOK calls 위험한 동반자. Everything else drifts less. */
const COMPANIONS: CompanionId[] = ['child', 'audience']

/**
 * Held fixed so style, time and companion are the ONLY things that vary.
 *
 * 공방/스튜디오 because it is the one place that reads naturally with both a
 * young child and a watching crowd — and because a person at a work bench is
 * where "is this a 25-year-old or a 17-year-old?" is hardest to fudge.
 *
 * The action comes from FALLBACK_ACTION rather than being written here: every
 * English string the model sees lives in build-image-prompt.ts, and this script
 * is not going to be the exception that starts a second list.
 */
const PLACE = 'workshop' as const
const ACTION = FALLBACK_ACTION[PLACE]
/** PRD §5-1: 표시 안 함 is the default, and it keeps the test on age alone. */
const GENDER = 'unspecified' as const
const QUALITY = 'low' as const

const IPM = Number(process.env.OPENAI_IPM ?? 5)
const MODEL = process.env.IMAGE_MODEL ?? 'gpt-image-2'
const SIZE = process.env.IMAGE_SIZE ?? '1024x1536'
const MOCK = process.env.MOCK_OPENAI === '1'
const GO = process.argv.includes('--go')
const OUT = path.join(process.cwd(), 'out', 'age-drift')

/** Identical to spacingMs() in lib/env.ts, which this script cannot import. */
const spacingMs = Math.ceil(60_000 / (IPM * 0.92))

interface Cell {
  style: StyleId
  time: TimeId
  companion: CompanionId
  file: string
  prompt: string
  error?: string
}

function plan(): Cell[] {
  const cells: Cell[] = []
  // Companion outermost, then time, then style: the contact sheet puts the
  // three styles of one scene side by side, which is the comparison being made.
  for (const companion of COMPANIONS) {
    for (const time of TIMES) {
      for (const style of STYLES) {
        cells.push({
          style,
          time,
          companion,
          file: `${companion}-${time}-${style}.jpg`,
          prompt: buildImagePrompt({
            actionEn: ACTION,
            visibleDetailEn: null,
            place: PLACE,
            companions: [companion],
            mood: 'warm',
            time,
            style,
            gender: GENDER,
            attempt: 1,
          }),
        })
      }
    }
  }
  return cells
}

async function draw(client: OpenAI, cell: Cell): Promise<Buffer> {
  if (MOCK) {
    // Same 1x1 JPEG lib/openai/image.ts uses, so --go is exercisable for free.
    return Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
        'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
        'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
      'base64',
    )
  }
  const res: ImagesResponse = await client.images.generate({
    model: MODEL,
    prompt: cell.prompt,
    n: 1,
    stream: false,
    size: SIZE as ImageGenerateParamsNonStreaming['size'],
    quality: QUALITY,
    output_format: 'jpeg',
    moderation: 'auto',
  })
  const b64 = res.data?.[0]?.b64_json
  if (!b64) throw new Error('OpenAI returned no image data')
  return Buffer.from(b64, 'base64')
}

/**
 * A contact sheet, not 24 loose files.
 *
 * Rows are one scene, columns are the three styles, so the anime cell sits next
 * to the photo cell of the SAME scene — which is the only way the age gap is
 * visible. Twenty-four files in a folder do not show it.
 */
function contactSheet(cells: Cell[]): string {
  const rows: string[] = []
  for (const companion of COMPANIONS) {
    for (const time of TIMES) {
      const group = cells.filter((c) => c.companion === companion && c.time === time)
      const cellsHtml = group
        .map((c) =>
          c.error
            ? `<figure class="bad"><div class="miss">${c.error}</div><figcaption>${STYLE[c.style].ko}</figcaption></figure>`
            : `<figure><img src="${c.file}" alt="${STYLE[c.style].ko}" loading="lazy"><figcaption>${STYLE[c.style].ko}</figcaption></figure>`,
        )
        .join('')
      rows.push(
        `<section><h2>${COMPANION[companion].ko} · ${TIME[time].ko}</h2><div class="row">${cellsHtml}</div></section>`,
      )
    }
  }
  return `<!doctype html>
<html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>연령 드리프트 점검 · 24장</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #f6f6f7; color: #111; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .lede { color: #666; font-size: 14px; line-height: 1.6; margin: 0 0 24px; max-width: 60ch; }
  .lede b { color: #b91c1c; }
  section { margin-bottom: 28px; }
  h2 { font-size: 14px; font-weight: 600; color: #555; margin: 0 0 8px; }
  .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; max-width: 900px; }
  figure { margin: 0; background: #fff; border-radius: 12px; overflow: hidden; }
  img { display: block; width: 100%; aspect-ratio: 2/3; object-fit: cover; background: #eee; }
  figcaption { font-size: 12px; color: #666; padding: 6px 10px; }
  .bad .miss { display: grid; place-items: center; aspect-ratio: 2/3; background: #fef2f2; color: #b91c1c; font-size: 11px; padding: 8px; text-align: center; }
</style>
<h1>연령 드리프트 점검 · ${cells.length}장</h1>
<p class="lede">
  가로 세 칸이 같은 장면의 <b>애니메이션 / 실사 / 수채화</b>예요.
  볼 것은 하나입니다 — <b>25살이 고등학생처럼 보이는 칸이 있나요?</b>
  있다면 그 스타일을 수업에서 빼거나(선생님 화면 &gt; 설정 &gt; 학생이 고를 수 있는 그림),
  build-image-prompt.ts 의 해당 style.reinforce 문구를 손보세요.
</p>
${rows.join('\n')}
</html>
`
}

async function main() {
  const cells = plan()
  const cost = cells.length * IMAGE_COST_USD[QUALITY]
  const minutes = Math.ceil((cells.length * spacingMs) / 60_000)

  console.log(`\n연령 드리프트 그리드 — ${cells.length}장`)
  console.log(`  스타일 ${STYLES.length} × 시간 ${TIMES.length} × 동반자 ${COMPANIONS.length}`)
  console.log(`  장소 ${PLACE} · 화질 ${QUALITY} · ${SIZE} · ${MODEL}`)
  console.log(`  분당 한도 ${IPM} → ${spacingMs}ms 간격, 한 번에 한 장`)
  console.log(`  예상 비용 약 $${cost.toFixed(2)}${MOCK ? '  (MOCK_OPENAI=1 이라 실제로는 $0)' : ''}`)
  console.log(`  예상 시간 최소 ${minutes}분`)
  console.log(`  저장 위치 ${OUT}`)

  if (!GO) {
    console.log('\n지금은 아무것도 그리지 않았어요. 실제로 그리려면 --go 를 붙이세요:')
    console.log('  pnpm tsx scripts/age-drift-grid.ts --go\n')
    console.log('첫 프롬프트 미리보기:\n')
    console.log(cells[0].prompt.split('\n').map((l) => `  ${l}`).join('\n'), '\n')
    return
  }

  if (!MOCK && !process.env.OPENAI_API_KEY) {
    console.error('\nOPENAI_API_KEY 가 없어요.\n')
    process.exit(1)
  }

  await mkdir(OUT, { recursive: true })
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? 'mock' })

  let ok = 0
  let nextSlot = 0
  for (const [i, cell] of cells.entries()) {
    // Space the STARTS, exactly as the pacer does. Waiting after a call instead
    // would make the interval spacing + latency and quietly halve the rate.
    const wait = nextSlot - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    nextSlot = Date.now() + spacingMs

    const label = `${i + 1}/${cells.length} ${cell.file}`
    try {
      const bytes = await draw(client, cell)
      await writeFile(path.join(OUT, cell.file), bytes)
      ok++
      console.log(`  ok    ${label}`)
    } catch (e) {
      // One refusal must not cost the other 23. The cell is marked in the sheet
      // so a hole is visible rather than silently missing.
      cell.error = (e as Error).message.slice(0, 120)
      console.log(`  FAIL  ${label} — ${cell.error}`)
    }
  }

  const sheet = path.join(OUT, 'index.html')
  await writeFile(sheet, contactSheet(cells), 'utf8')

  console.log(`\n${ok}/${cells.length}장 완료. 실제 비용 약 $${(ok * IMAGE_COST_USD[QUALITY]).toFixed(2)}`)
  console.log(`\n이 파일을 브라우저로 여세요:\n  ${sheet}\n`)
  console.log('볼 것은 하나예요 — 25살이 고등학생처럼 나온 칸이 있는지.\n')
}

main().catch((e) => {
  console.error('\n', e)
  process.exit(1)
})
