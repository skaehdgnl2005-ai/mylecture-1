import { describe, it, expect } from 'vitest'
import {
  buildImagePrompt, buildGalleryTags, assertPromptIsClean,
  PLACE_IDS, COMPANION_IDS, MOOD_IDS, TIME_IDS, STYLE_IDS, GENDER_IDS,
  PLACE, COMPANION, MOOD, TIME, STYLE,
  type PromptInput,
} from './build-image-prompt'

const base: PromptInput = {
  actionEn: 'playing a game they made with their friends for the first time',
  place: 'city', companions: ['friends'], mood: 'excited',
  time: 'sunset', style: 'anime', gender: 'unspecified', attempt: 1,
}

describe('assertPromptIsClean — the backstop that enforces "the translator ran"', () => {
  it('throws when any Hangul survives into the prompt', () => {
    expect(() => assertPromptIsClean('a scene with 노래 in it'))
      .toThrow('PROMPT_CONTAINS_HANGUL')
  })

  it('throws on an over-long prompt', () => {
    expect(() => assertPromptIsClean('x'.repeat(3001))).toThrow('PROMPT_TOO_LONG')
  })

  it('accepts a clean English prompt', () => {
    expect(() => assertPromptIsClean('a calm English prompt')).not.toThrow()
  })
})

describe('buildImagePrompt — every chip combination stays clean', () => {
  it('produces Hangul-free output across the full cross product', () => {
    let n = 0
    for (const place of PLACE_IDS)
      for (const time of TIME_IDS)
        for (const style of STYLE_IDS)
          for (const gender of GENDER_IDS) {
            const p = buildImagePrompt({ ...base, place, time, style, gender })
            expect(p).not.toMatch(/[가-힣]/)
            n++
          }
    expect(n).toBe(PLACE_IDS.length * TIME_IDS.length * STYLE_IDS.length * GENDER_IDS.length)
  })

  it('handles every companion and mood without throwing', () => {
    for (const c of COMPANION_IDS)
      for (const mood of MOOD_IDS)
        expect(() => buildImagePrompt({ ...base, companions: [c], mood })).not.toThrow()
  })
})

describe('buildImagePrompt — the framing rules that replaced PRD §5-2', () => {
  const p = buildImagePrompt(base)

  it('states framing as a linear height fraction with a visible ground plane', () => {
    expect(p).toContain('one third of the image height')
    expect(p).toContain('ground beneath the feet visible')
  })

  it('never mentions an aspect ratio (size is an API parameter)', () => {
    expect(p).not.toMatch(/3:4|4:3|2:3|vertical|aspect/i)
  })

  it('says the subject is an adult with a stated age, not "mid-20s"', () => {
    expect(p).toContain('25-year-old')
    expect(p).toContain('clearly an adult')
  })

  it('keeps negatives to the three OpenAI documents, as positives elsewhere', () => {
    expect(p).toContain('no text, no watermark, no logos')
    expect(p).not.toContain('split panel')
    expect(p).toContain('A single continuous frame')
  })

  it('ends the place clause with a depth anchor', () => {
    expect(PLACE.city.en).toMatch(/receding far into the distance/)
    expect(PLACE.sea.en).toMatch(/horizon line clearly visible/)
  })
})

describe('buildImagePrompt — retry must not return the same picture', () => {
  it('adds a variation clause on attempt 2 and not on attempt 1', () => {
    const a1 = buildImagePrompt({ ...base, attempt: 1 })
    const a2 = buildImagePrompt({ ...base, attempt: 2 })
    expect(a1).not.toContain('Variation:')
    expect(a2).toContain('Variation:')
    expect(a1).not.toBe(a2)
  })
})

describe('buildImagePrompt — companions', () => {
  it('treats "alone" as exclusive regardless of what else was passed', () => {
    const p = buildImagePrompt({ ...base, companions: ['alone', 'friends'] })
    expect(p).toContain('alone in the scene')
    expect(p).not.toContain(COMPANION.friends.en)
  })

  it('caps at two companions', () => {
    const p = buildImagePrompt({
      ...base,
      companions: ['friends', 'family', 'coworkers'],
    })
    expect(p).toContain(COMPANION.friends.en)
    expect(p).toContain(COMPANION.family.en)
    expect(p).not.toContain(COMPANION.coworkers.en)
  })

  it('does not add a dog when the action already names another animal', () => {
    const p = buildImagePrompt({
      ...base,
      actionEn: 'brushing their cat on the sofa',
      companions: ['pet'],
    })
    expect(p).toContain('pet cat')
    expect(p).not.toContain('pet dog')
  })
})

describe('buildGalleryTags — anonymity is structural', () => {
  it('emits only Korean chip labels, in a fixed order', () => {
    const tags = buildGalleryTags({
      place: 'sea', companions: ['friends', 'pet'],
      mood: 'peaceful', time: 'night', style: 'watercolor',
    })
    expect(tags).toEqual([
      PLACE.sea.ko, COMPANION.friends.ko, COMPANION.pet.ko,
      MOOD.peaceful.ko, TIME.night.ko, STYLE.watercolor.ko,
    ])
  })

  it('cannot leak a free-text sentence even if one is smuggled into the object', () => {
    const smuggled = {
      place: 'home', companions: ['alone'], mood: 'warm', time: 'morning', style: 'photo',
      // a field someone added to `inputs` later:
      rawTextKo: '내가 만든 게임을 친구들과 해요',
    } as never
    const tags = buildGalleryTags(smuggled)
    expect(tags.join(' ')).not.toContain('게임')
    expect(tags).toHaveLength(5)
  })
})
