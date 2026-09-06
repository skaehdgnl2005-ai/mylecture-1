import { describe, it, expect } from 'vitest'
import { scan, normalize, choseongTrack } from './banned-words'

describe('normalize', () => {
  it('strips inserted whitespace and punctuation so evasions collapse', () => {
    expect(normalize('씨 발')).toBe(normalize('씨발'))
    expect(normalize('씨.발')).toBe(normalize('씨발'))
  })

  it('collapses long character repeats', () => {
    expect(normalize('아아아아아')).toBe('아아')
  })
})

describe('choseongTrack', () => {
  // The single most important false-positive guard in the module.
  it('ignores full syllables — 부산 must NOT become ㅂㅅ', () => {
    expect(choseongTrack('부산에서 살고 있어요')).toBe('')
    expect(choseongTrack('시부모님과 함께')).toBe('')
    expect(choseongTrack('반사!')).toBe('')
  })

  it('keeps characters that were already standalone jamo', () => {
    expect(choseongTrack('ㅅㅂ')).toBe('ㅅㅂ')
    expect(choseongTrack('진짜 ㅅ ㅂ 짜증나')).toBe('ㅅㅂ')
  })
})

describe('scan — false positives that would break a real classroom', () => {
  const mustPass = [
    '미술 선생님이 되어 있어요',
    '예술 작품을 만들고 있어요',
    '기술을 가르치고 있어요',
    '마술 공연을 하고 있어요',
    '수술을 집도하고 있어요',
    '총각김치를 담그고 있어요',
    '칼국수 가게를 하고 있어요',
    '전복죽을 끓이고 있어요',
    '찐친들과 여행 중이에요',
    '강아지와 산책하고 있어요',
    '축구에서 자살골을 넣었어요',
    '폭포 앞에서 사진을 찍어요',
    '부산 바다에서 서핑해요',
  ]
  for (const text of mustPass) {
    it(`allows: ${text}`, () => {
      const r = scan(text)
      expect(r.hard, `hard-blocked: ${JSON.stringify(r.hard)}`).toEqual([])
      expect(r.selfharm).toEqual([])
      expect(r.ok).toBe(true)
    })
  }
})

describe('scan — genuine hard blocks', () => {
  const mustBlock: Array<[string, string]> = [
    ['죽이고 싶어요', 'violence'],
    ['총으로 쏘고 있어요', 'weapon'],
    ['칼로찌르는 장면', 'weapon'],
    ['술마시고 있어요', 'drugs'],
    ['담배피우고 있어요', 'drugs'],
    ['씨발 진짜', 'slur'],
    ['찐따같은 애들', 'slur'],
  ]
  for (const [text, category] of mustBlock) {
    it(`blocks (${category}): ${text}`, () => {
      const r = scan(text)
      expect(r.ok).toBe(false)
      expect(r.hard.length + r.selfharm.length).toBeGreaterThan(0)
    })
  }

  it('catches jamo evasion ㅅㅂ', () => {
    expect(scan('ㅅㅂ 뭐야').ok).toBe(false)
  })
})

describe('scan — self-harm is its own tier, not a generic block', () => {
  // A 14-year-old cohort uses soft-signal phrasing. These must route to the
  // dedicated path with its own copy, never to "다른 말로 바꿔볼까요?".
  const signals = [
    '사라지고 싶어요',
    '없어지고 싶어요',
    '죽고 싶어요',
    '살기 싫어요',
  ]
  for (const text of signals) {
    it(`routes to selfharm: ${text}`, () => {
      const r = scan(text)
      expect(r.selfharm.length).toBeGreaterThan(0)
      expect(r.ok).toBe(false)
    })
  }
})

describe('scan — brands and real people are soft-strip, never a student-facing error', () => {
  const soft = [
    '유튜브 영상을 찍고 있어요',
    '마인크래프트를 하고 있어요',
    '손흥민이랑 축구하고 있어요',
    '포켓몬을 잡고 있어요',
  ]
  for (const text of soft) {
    it(`passes with a soft match: ${text}`, () => {
      const r = scan(text)
      expect(r.ok, 'must not hard-block a delightful answer').toBe(true)
      expect(r.soft.length).toBeGreaterThan(0)
    })
  }
})
