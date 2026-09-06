// ============================================================================
// Layer 1 of the safety pipeline: a deterministic Korean word filter.
//
// Design call that matters most: HARD-BLOCK vs SOFT-STRIP.
//   hard-block -> refuse the submission, tell the student which answer to change
//   soft-strip -> say nothing, let the translator generalise it away
//
// Almost everything is soft-strip. Hard-blocking 유튜브 / 마인크래프트 / 포켓몬
// would reject a large share of perfectly delightful middle-school answers and
// teach twenty teenagers that the app is broken. Hard blocks are reserved for
// violence, sexual content, self-harm, drugs and slurs.
//
// Self-harm gets its own severity tier with its own copy — never the generic
// "다른 말로 바꿔볼까요?" path.
// ============================================================================

export type Severity = 'hard' | 'soft' | 'selfharm'
export type Category =
  | 'violence' | 'weapon' | 'sexual' | 'selfharm' | 'drugs' | 'slur'
  | 'brand' | 'realperson'

export interface Rule {
  category: Category
  severity: Severity
  patterns: string[]
}

// ─────────────────────────────────────────────────────── false positives ────
// Ship this on day one, not after a kid gets blocked for writing 미술 선생님.
//
// Single-syllable entries are landmines:
//   술 -> 미술 예술 기술 마술 수술 시술      총 -> 총각 총알 총회
//   칼 -> 칼국수                              죽 -> 죽순 죽집 김치죽
// So every pattern below is 2+ syllables, and anything that still collides is
// un-flagged here when the match falls inside an allowlisted term.
export const FALSE_POSITIVE_ALLOWLIST: string[] = [
  '미술', '예술', '기술', '마술', '수술', '시술', '건축술', '술래',
  '총각', '총알받이', '총회', '총장', '총리', '사총사',
  '칼국수', '칼슘', '연필칼', '가위바위보',
  '죽순', '죽집', '김치죽', '전복죽', '죽마고우',
  '찐친', '찐맛', '찐행복',
  '강아지', '고양이새끼', '병아리',
  '자살골',           // football
  '폭탄머리', '폭포', '폭신',
  '대마도',           // the island
  '담배꽁초줍기',      // volunteering
]

// ────────────────────────────────────────────────────────────── the rules ────
export const RULES: Rule[] = [
  {
    category: 'selfharm',
    severity: 'selfharm',
    patterns: [
      '자살', '자해', '죽고싶', '죽고 싶', '죽어버리', '목매', '목을매',
      '손목긋', '손목 긋', '뛰어내리', '사라지고싶', '사라지고 싶',
      '없어지고싶', '없어지고 싶', '살기싫', '살기 싫', '살고싶지않',
      '태어나지말', '내가없어지', '유서', '극단적선택',
    ],
  },
  {
    category: 'violence',
    severity: 'hard',
    patterns: [
      '죽이고', '죽였', '죽인다', '살인', '시체', '시신', '학살', '고문',
      '때려죽', '패죽', '목졸라', '목을졸', '찔러죽', '피흘리', '피가철철',
      '토막', '참수', '폭행', '구타', '집단폭행', '살해',
    ],
  },
  {
    category: 'weapon',
    severity: 'hard',
    patterns: [
      '총으로', '총을쏘', '총쏘', '총기', '권총', '소총', '기관총', '저격',
      '칼로찌', '칼을들', '칼부림', '흉기', '폭탄', '폭발물', '수류탄',
      '테러', '사제총', '도끼로', '망치로때',
    ],
  },
  {
    category: 'sexual',
    severity: 'hard',
    patterns: [
      '섹스', '성관계', '자위', '야동', '포르노', '음란', '나체', '알몸',
      '벗은몸', '가슴만지', '성기', '변태', '몰카', '몰래카메라', '스킨십하는',
      '19금', '야한', '헐벗', '누드',
    ],
  },
  {
    category: 'drugs',
    severity: 'hard',
    patterns: [
      '마약', '필로폰', '히로뽕', '코카인', '헤로인', '대마초', '떨피',
      '술마시', '술을마시', '술취', '만취', '소주마시', '맥주마시', '음주',
      '담배피', '담배를피', '흡연', '전자담배', '액상대마',
    ],
  },
  {
    category: 'slur',
    severity: 'hard',
    patterns: [
      '씨발', '시발', '씨팔', '개새끼', '씨발새끼', '병신', '지랄', '좆',
      '보지', '자지', '니미', '엠창', '애미', '창녀', '창놈',
      '찐따', '왕따시키', '따돌리', '일진', '빵셔틀', '패드립',
      '장애인비하', '틀딱', '급식충', '한남충', '김치녀', '메갈',
    ],
  },
  // ── soft-strip below: never shown to the student, translator generalises ──
  {
    category: 'brand',
    severity: 'soft',
    patterns: [
      '유튜브', '유튜버', '틱톡', '인스타', '인스타그램', '페이스북', '트위터',
      '넷플릭스', '디즈니', '마인크래프트', '로블록스', '포켓몬', '피카츄',
      '나이키', '아디다스', '구찌', '샤넬', '루이비통', '애플', '아이폰',
      '삼성', '갤럭시', '스타벅스', '맥도날드', '코카콜라', '롯데',
      'BTS', '방탄소년단', '블랙핑크', '뉴진스', '아이브', '에스파',
      '리그오브레전드', '롤', '배그', '오버워치', '젤다', '마리오',
    ],
  },
  {
    category: 'realperson',
    severity: 'soft',
    patterns: [
      '손흥민', '김연아', '박지성', '이강인', '류현진', '봉준호', '아이유',
      '유재석', '강호동', '백종원', '페이커', '일론머스크', '머스크',
      '트럼프', '바이든', '대통령', '아인슈타인', '스티브잡스', '잡스',
      '빌게이츠', '메시', '호날두', '르브론',
    ],
  },
]

// ─────────────────────────────────────────────────────────── normalisation ──
const LEET: Record<string, string> = {
  '0': 'ㅇ', '1': 'ㅣ', '3': 'ㅔ', '4': 'ㅅ', '@': 'ㅇ', '$': 'ㅅ',
}

/**
 * Collapse the cheap evasions: width/compat forms, repeated characters,
 * inserted whitespace and punctuation, simple leetspeak.
 *
 * NOTE the deliberate asymmetry with choseong (below): we normalise spacing
 * away here so "씨 발" is caught, but we do NOT synthesise choseong from full
 * syllables, because that destroys the false-positive rate.
 */
export function normalize(input: string): string {
  let s = input.normalize('NFKC').toLowerCase()
  for (const [from, to] of Object.entries(LEET)) s = s.split(from).join(to)
  s = s.replace(/[\s​-‏⁠]/g, '')
  s = s.replace(/[.,!?~\-_*'"`^()[\]{}<>/\\|:;]/g, '')
  s = s.replace(/(.)\1{2,}/g, '$1$1')
  return s
}

const CHOSEONG_TO_COMPAT: Record<number, string> = {
  0x1100: 'ㄱ', 0x1101: 'ㄲ', 0x1102: 'ㄴ', 0x1103: 'ㄷ',
  0x1104: 'ㄸ', 0x1105: 'ㄹ', 0x1106: 'ㅁ', 0x1107: 'ㅂ',
  0x1108: 'ㅃ', 0x1109: 'ㅅ', 0x110a: 'ㅆ', 0x110b: 'ㅇ',
  0x110c: 'ㅈ', 0x110d: 'ㅉ', 0x110e: 'ㅊ', 0x110f: 'ㅋ',
  0x1110: 'ㅌ', 0x1111: 'ㅍ', 0x1112: 'ㅎ',
}

/**
 * The choseong (initial-consonant) track, for evasions like "ㅅㅂ".
 *
 * CRITICAL: only characters that were ALREADY standalone jamo in the input are
 * kept. A student who types ㅅㅂ typed jamo; a student who typed 부산 did not.
 * Naive choseong extraction turns 부산 -> ㅂㅅ, 시부모 -> ㅅㅂㅁ, 반사 -> ㅂㅅ,
 * and the filter becomes unusable.
 */
export function choseongTrack(input: string): string {
  // Deliberately does NOT normalize first. NFKC maps compatibility jamo
  // (U+3131-U+314E) into the Hangul Jamo block (U+1100+), and NFD/NFKD would
  // additionally decompose precomposed syllables — which is the thing that
  // must never happen here. Precomposed syllables are left whole and dropped,
  // so 부산 yields '' rather than 'ㅂㅅ'.
  return Array.from(input)
    .map((ch) => {
      const c = ch.codePointAt(0)!
      if (c >= 0x3131 && c <= 0x318e) return ch          // already standalone jamo
      if (CHOSEONG_TO_COMPAT[c]) return CHOSEONG_TO_COMPAT[c] // arrived pre-decomposed
      return ''
    })
    .join('')
}

const CHOSEONG_PATTERNS: Array<{ pattern: string; category: Category; severity: Severity }> = [
  { pattern: 'ㅅㅂ', category: 'slur', severity: 'hard' },
  { pattern: 'ㅆㅂ', category: 'slur', severity: 'hard' },
  { pattern: 'ㅄ', category: 'slur', severity: 'hard' },
  { pattern: 'ㅂㅅ', category: 'slur', severity: 'hard' },
  { pattern: 'ㅈㄹ', category: 'slur', severity: 'hard' },
  { pattern: 'ㄲㅈ', category: 'slur', severity: 'hard' },
]

export interface Match {
  term: string
  category: Category
  severity: Severity
}

export interface ScanResult {
  hard: Match[]
  soft: Match[]
  selfharm: Match[]
  /** true when nothing hard-blocking or self-harm-related was found */
  ok: boolean
}

function allowlistCovers(normalized: string, term: string): boolean {
  // If every occurrence of `term` sits inside an allowlisted word, it is a
  // false positive (미술 containing 술, 총각 containing 총, ...).
  const covering = FALSE_POSITIVE_ALLOWLIST
    .map((a) => normalize(a))
    .filter((a) => a.includes(term))
  if (covering.length === 0) return false

  let from = 0
  for (;;) {
    const at = normalized.indexOf(term, from)
    if (at === -1) return true // every occurrence was covered
    const covered = covering.some((a) => {
      const start = normalized.lastIndexOf(a, at)
      return start !== -1 && start + a.length > at && start <= at
    })
    if (!covered) return false
    from = at + term.length
  }
}

export function scan(input: string): ScanResult {
  const norm = normalize(input)
  const cho = choseongTrack(input)
  const hard: Match[] = []
  const soft: Match[] = []
  const selfharm: Match[] = []

  for (const rule of RULES) {
    for (const raw of rule.patterns) {
      const term = normalize(raw)
      if (!term || !norm.includes(term)) continue
      if (allowlistCovers(norm, term)) continue
      const m: Match = { term: raw, category: rule.category, severity: rule.severity }
      if (rule.severity === 'hard') hard.push(m)
      else if (rule.severity === 'selfharm') selfharm.push(m)
      else soft.push(m)
    }
  }

  for (const cp of CHOSEONG_PATTERNS) {
    if (cho.includes(cp.pattern)) {
      hard.push({ term: cp.pattern, category: cp.category, severity: cp.severity })
    }
  }

  return { hard, soft, selfharm, ok: hard.length === 0 && selfharm.length === 0 }
}
