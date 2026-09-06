import { describe, it, expect } from 'vitest'
import {
  PLACE_CHIPS, COMPANION_CHIPS, MOOD_CHIPS, TIME_CHIPS, STYLE_CARDS, GENDER_CHIPS,
  STARTER_CHIPS,
} from './chips'
import {
  PLACE, COMPANION, MOOD, TIME, STYLE, GENDER, STARTER_CHIPS as SERVER_STARTERS,
} from './prompt/build-image-prompt'

/**
 * The client cannot import the prompt builder (it is server-only and holds every
 * English string the image model sees), so the chip vocabulary is mirrored. This
 * test is what keeps the mirror honest — without it, adding a place chip to one
 * file and not the other fails at runtime with a blank prompt segment.
 */
describe('client chip mirror matches the server dictionaries', () => {
  const cases: Array<[string, ReadonlyArray<{ id: string; ko: string }>, Record<string, { ko: string }>]> = [
    ['place', PLACE_CHIPS, PLACE],
    ['companion', COMPANION_CHIPS, COMPANION],
    ['mood', MOOD_CHIPS, MOOD],
    ['time', TIME_CHIPS, TIME],
    ['style', STYLE_CARDS, STYLE],
    ['gender', GENDER_CHIPS, GENDER],
  ]

  for (const [name, chips, dict] of cases) {
    it(`${name}: same ids`, () => {
      expect([...chips].map((c) => c.id).sort()).toEqual(Object.keys(dict).sort())
    })
    it(`${name}: same Korean labels`, () => {
      for (const c of chips) expect(c.ko, `${name}.${c.id}`).toBe(dict[c.id].ko)
    })
  }

  it('starter chips match', () => {
    expect([...STARTER_CHIPS]).toEqual(SERVER_STARTERS)
  })

  it('PRD §5-1 counts: 11 places, 8 companions, 6 moods, 4 times, 3 styles', () => {
    expect(PLACE_CHIPS).toHaveLength(11)
    expect(COMPANION_CHIPS).toHaveLength(8)
    expect(MOOD_CHIPS).toHaveLength(6)
    expect(TIME_CHIPS).toHaveLength(4)
    expect(STYLE_CARDS).toHaveLength(3)
  })
})

// ── Guard: the prompt vocabulary must never reach the browser ───────────────
// build-image-prompt.ts is intentionally importable (pure data + pure
// functions, so it is unit-testable), which means a comment is the only thing
// stopping someone importing it from a Client Component and shipping every
// English prompt string — plus the framing and constraint text — to the phone.
// PRD §5-2 says the prompt is not shown to students. This makes that checkable.
describe('prompt module never reaches a client bundle', () => {
  it('no "use client" file imports lib/prompt', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const root = path.join(process.cwd(), 'src')

    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) return walk(full)
        return /\.(ts|tsx)$/.test(e.name) ? [full] : []
      })

    const offenders = walk(root).filter((file) => {
      if (file.includes('.test.')) return false
      const src = fs.readFileSync(file, 'utf8')
      const isClient = /^\s*['"]use client['"]/m.test(src)
      const importsPrompt = /from\s+['"](@\/lib\/prompt|\.\.?\/[^'"]*prompt\/build-image-prompt)/.test(src)
      return isClient && importsPrompt
    })

    expect(offenders.map((f) => f.replace(process.cwd(), ''))).toEqual([])
  })
})
