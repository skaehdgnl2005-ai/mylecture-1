// ============================================================================
// SERVER ONLY — never import from a Client Component.
//
// Assembles the gpt-image-2 prompt. Every English string the model can ever
// see lives in this one file, so the entire closed vocabulary is auditable at
// once. Structure follows OpenAI's documented order: scene -> subject ->
// details -> constraints, as short labeled segments separated by line breaks.
//
// This replaces PRD §5-2 wholesale. Four changes carry the weight:
//   1. Every place string ends with a DEPTH ANCHOR — something the camera
//      physically cannot see from close up. This pulls the shot wide far more
//      reliably than any fraction language.
//   2. Scene before subject (OpenAI's documented ordering guidance).
//   3. "one third of the frame" -> "one third of the image HEIGHT ... ground
//      beneath the feet visible" (a linear measure with a check, not an area).
//   4. "vertical 3:4" deleted. Size is an API parameter, and aspect-ratio words
//      inside a prompt sometimes produce a drawn border or letterbox.
//      (1024x1536 is in fact 2:3, not 3:4 — the PRD's phrasing was doubly off.)
// ============================================================================

export type PlaceId =
  | 'city' | 'sea' | 'forest' | 'home' | 'stage' | 'lab'
  | 'space' | 'cafe' | 'field' | 'workshop' | 'other'
export type CompanionId =
  | 'alone' | 'friends' | 'family' | 'coworkers'
  | 'pet' | 'audience' | 'students' | 'child'
export type MoodId = 'excited' | 'peaceful' | 'proud' | 'warm' | 'lively' | 'dreamy'
export type TimeId = 'morning' | 'midday' | 'sunset' | 'night'
export type StyleId = 'anime' | 'photo' | 'watercolor'
export type GenderId = 'male' | 'female' | 'unspecified'

// ─────────────────────────────────────────────────────────── PLACE (11) ─────
// Question 2, single select. `ko` is the gallery tag and the ONLY string here
// that ever reaches /g/{code}.
export const PLACE: Record<PlaceId, { ko: string; en: string }> = {
  city:     { ko: '도시',         en: 'a busy city street between tall buildings, crosswalks, shop signage and parked scooters, the street receding far into the distance behind them' },
  sea:      { ko: '바다',         en: 'a wide open beach of wet sand and low breaking waves, the horizon line clearly visible far behind them under open sky' },
  forest:   { ko: '숲/산',        en: 'a green mountain forest trail with tall trees on both sides, layered ridgelines fading into haze in the far distance' },
  home:     { ko: '우리 집',       en: 'a bright lived-in apartment living room with a low sofa, a full bookshelf and a wide window, both the far wall and part of the ceiling visible' },
  stage:    { ko: '무대',         en: 'a concert stage seen from the audience floor, stage lights and speaker stacks overhead and the dark hall stretching back around them' },
  lab:      { ko: '연구실',        en: 'a working research laboratory with long benches of equipment and monitors, the far end of the room visible down the central aisle' },
  space:    { ko: '우주',         en: 'the interior of a spacecraft with a large curved viewing window, Earth and stars outside, the module walls visible on both sides' },
  cafe:     { ko: '카페',         en: 'a warm neighbourhood cafe interior with a counter and coffee machine, wooden tables and a big street-facing window, several tables between the camera and them' },
  field:    { ko: '운동장',        en: 'a large outdoor sports field with painted lines on the ground, stands and floodlights ringing the far edge' },
  workshop: { ko: '공방/스튜디오', en: 'a cluttered maker workshop, tools hung on a pegboard wall, a big work table and stacked material along the sides, the whole room readable' },
  other:    { ko: '기타',         en: 'a simple open everyday space with plenty of room on all sides, ordinary furniture and objects at the edges of the frame and a far wall visible' },
}

// ──────────────────────────────────────────────────────────── TIME (4) ──────
export const TIME: Record<TimeId, { ko: string; en: string; light: string }> = {
  morning: { ko: '아침', en: 'in the early morning',     light: 'soft low golden light coming in from one side, long gentle shadows, clear cool air' },
  midday:  { ko: '한낮', en: 'in the middle of the day', light: 'bright even daylight, crisp short shadows, a high open sky' },
  sunset:  { ko: '노을', en: 'at sunset',                light: 'warm orange and pink light raking low across everything, long shadows, a glowing sky' },
  night:   { ko: '밤',   en: 'at night',                 light: 'cool ambient darkness lit by nearby lamps, lit windows and city light, warm pools of light against deep blue shadow' },
}

// ──────────────────────────────────────────────────────────── MOOD (6) ──────
// Full sentences: gpt-image-2 reads descriptive natural language, not tags.
export const MOOD: Record<MoodId, { ko: string; en: string }> = {
  excited:  { ko: '설레는',   en: 'The moment feels bright and full of anticipation, as if something good is just about to begin.' },
  peaceful: { ko: '평화로운', en: 'The moment feels calm and unhurried, quiet and completely settled.' },
  proud:    { ko: '당당한',   en: 'The moment feels confident and self-assured, shoulders open and posture tall.' },
  warm:     { ko: '따뜻한',   en: 'The moment feels warm and affectionate, close and kind.' },
  lively:   { ko: '신나는',   en: 'The moment feels lively and full of energy, with movement everywhere in the frame.' },
  dreamy:   { ko: '몽환적인', en: 'The moment feels dreamlike and softly unreal, hazy light and gentle blur toward the edges.' },
}

// ─────────────────────────────────────────────────────── COMPANIONS (8) ─────
// Multi select, MAX 2. Counts are deliberately small ("two or three") — a wide
// shot with six rendered faces is where gpt-image-2 falls apart at 1024x1536.
export const COMPANION: Record<CompanionId, { ko: string; en: string; exclusive?: boolean }> = {
  alone:     { ko: '혼자',     en: '', exclusive: true },
  friends:   { ko: '친구들',   en: 'two or three friends of a similar age' },
  family:    { ko: '가족',     en: 'two family members' },
  coworkers: { ko: '동료들',   en: 'two coworkers' },
  pet:       { ko: '반려동물', en: 'their pet dog close beside them' },
  audience:  { ko: '팬/관객',  en: 'a crowd of people watching them, their faces soft and out of focus in the background' },
  students:  { ko: '학생들',   en: 'a small group of students listening to them' },
  child:     { ko: '아이',     en: 'their own young child beside them' },
}

const ALONE_EN =
  'They are alone in the scene, completely absorbed in what they are doing.'

// If the action already names an animal, do not add a second one.
const PET_OVERRIDE: Array<[RegExp, string]> = [
  [/\bcat\b/i,    'their pet cat close beside them'],
  [/\brabbit\b/i, 'their pet rabbit close beside them'],
  [/\bbird\b/i,   'their pet bird perched close beside them'],
  [/\bhorse\b/i,  'their horse standing close beside them'],
]

// ─────────────────────────────────────────────────────────── STYLE (3) ──────
export const STYLE: Record<StyleId, { ko: string; en: string; reinforce: string }> = {
  anime: {
    ko: '애니메이션',
    en: 'Hand-drawn anime illustration in the style of a heartfelt animated feature film, soft cel shading, warm colours, carefully painted background art',
    reinforce: 'Clean confident linework, painted backgrounds with real depth, gentle film-like colour grading.',
  },
  photo: {
    ko: '실사',
    en: 'Photorealistic cinematic film still, 35mm look, natural depth of field, realistic skin and fabric texture',
    reinforce: 'Shot on a full-frame camera with a 35mm lens, natural grain, believable everyday lighting.',
  },
  watercolor: {
    ko: '수채화',
    en: 'Delicate watercolour painting, visible cold-press paper texture, gentle washes of colour, loose expressive brushwork',
    reinforce: 'Pigment pools and soft bleeding edges, white paper left showing through in the highlights.',
  },
}

// ────────────────────────────────────────────────────────── GENDER (3) ──────
// State the NUMBER, not "mid-20s". Anime training data skews any unnumbered
// "young adult" downward, and a figure that reads as a high-schooler in a
// product built for 14-year-olds is the exact failure to avoid.
export const GENDER: Record<GenderId, { ko: string; subject: string; short: string }> = {
  male:        { ko: '남',         subject: 'a 25-year-old Korean man',    short: 'man' },
  female:      { ko: '여',         subject: 'a 25-year-old Korean woman',  short: 'woman' },
  unspecified: { ko: '표시 안 함', subject: 'a 25-year-old Korean person', short: 'person' },
}

const framingBlock = (short: string) =>
  `The ${short} stands about one third of the image height, head near the upper-third line, ` +
  `with the ground beneath the feet visible. ` +
  `The ${short} is turned toward the action, engaged and unposed, not looking at the camera. ` +
  `Faces are small in the frame; keep them simple, clean and calm.`

// Three negatives — exactly OpenAI's own documented examples — plus positive
// restatements. "no captions" is redundant with "no text". "no split panels"
// became its positive form: naming a strong compositional noun inside a
// negative raises that noun's salience and some results come back gridded.
const CONSTRAINTS =
  'Constraints: no text, no watermark, no logos. Surfaces are clean and unmarked. ' +
  'A single continuous frame, one scene, edge to edge. ' +
  'The people are fictional and resemble no real person.'

// gpt-image-2 exposes no seed we control, so attempt 2 with identical chips
// returns a near-identical picture — the student would have lost their retry.
const VARIATION: Record<number, string> = {
  1: '',
  2: '\nVariation: choose a less obvious camera position and a different arrangement of the surroundings than the most typical one for this scene.',
}

export interface PromptInput {
  /** Sanitised translator output. NEVER raw Korean. */
  actionEn: string
  visibleDetailEn?: string | null
  place: PlaceId
  companions: CompanionId[]
  mood: MoodId
  time: TimeId
  style: StyleId
  gender: GenderId
  attempt: number
}

function companionPhrase(ids: CompanionId[], actionEn: string): string {
  if (ids.includes('alone') || ids.length === 0) return ALONE_EN
  const parts = ids.slice(0, 2).map((id) => {
    if (id === 'pet') {
      const hit = PET_OVERRIDE.find(([re]) => re.test(actionEn))
      return hit ? hit[1] : COMPANION.pet.en
    }
    return COMPANION[id].en
  })
  return `With them in the scene: ${parts.join(' and ')}.`
}

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/

/**
 * Hard gate before every image call. Throws if any Hangul survived into the
 * assembled prompt. This is the mechanical enforcement of "the translator ran
 * and its output was used", and it is what catches PRD §5-1's raw-Korean
 * fallback if anyone ever reintroduces it. The DB has the same check.
 */
export function assertPromptIsClean(prompt: string): void {
  if (HANGUL.test(prompt)) throw new Error('PROMPT_CONTAINS_HANGUL')
  if (prompt.length > 3000) throw new Error('PROMPT_TOO_LONG')
}

export function buildImagePrompt(i: PromptInput): string {
  const g = GENDER[i.gender]
  const place = PLACE[i.place]
  const time = TIME[i.time]
  const style = STYLE[i.style]

  const detail = i.visibleDetailEn?.trim()
    ? ` Clearly visible nearby: ${i.visibleDetailEn.trim()}.`
    : ''

  const prompt = [
    `Style: ${style.en}`,
    ``,
    `Scene: ${place.en}, ${time.en}.${detail} ${time.light}.`,
    `Subject: ${g.subject}, clearly an adult with adult proportions and adult features, ` +
      `${i.actionEn}. That action is happening right now, mid-motion. ` +
      companionPhrase(i.companions, i.actionEn),
    framingBlock(g.short),
    `Mood: ${MOOD[i.mood].en}`,
    `Rendering: ${style.reinforce}`,
    CONSTRAINTS + (VARIATION[i.attempt] ?? VARIATION[2]),
  ].join('\n')

  assertPromptIsClean(prompt)
  return prompt
}

/**
 * Gallery tags. Built from chip IDs ONLY — never by iterating `inputs`, because
 * the day someone adds a field to `inputs` would be the day the free sentence
 * appears on the projector.
 */
export function buildGalleryTags(
  i: Pick<PromptInput, 'place' | 'companions' | 'mood' | 'time' | 'style'>,
): string[] {
  return [
    PLACE[i.place].ko,
    ...i.companions.slice(0, 2).map((c) => COMPANION[c].ko),
    MOOD[i.mood].ko,
    TIME[i.time].ko,
    STYLE[i.style].ko,
  ]
}

/**
 * Used when the translator fails or refuses. Replaces PRD §5-1's "insert the
 * raw Korean" fallback, which would silently disable the layer that strips real
 * people and brands. Nobody goes home without a picture; nobody bypasses
 * sanitation.
 */
export const FALLBACK_ACTION: Record<PlaceId, string> = {
  city:     'walking through the city smiling, looking around',
  sea:      'walking barefoot along the water at the edge of the sea',
  forest:   'hiking up a forest trail, pausing to look out',
  home:     'sitting on the floor at home doing something they love',
  stage:    'singing into a microphone on stage',
  lab:      'looking closely at an experiment on the bench',
  space:    'floating beside the window looking out at Earth',
  cafe:     'making coffee behind the counter of their own cafe',
  field:    'running across the field mid-game',
  workshop: 'building something with their hands at the work table',
  other:    'doing something they love, hands busy and eyes bright',
}

/** The 3 starter chips on question 1 (PRD §5-1). */
export const STARTER_CHIPS: string[] = [
  '무대 위에서 노래를 부르고 있어요',
  '내가 만든 가게에서 손님을 맞아요',
  '반려견과 바닷가를 달리고 있어요',
]

export const PLACE_IDS = Object.keys(PLACE) as PlaceId[]
export const COMPANION_IDS = Object.keys(COMPANION) as CompanionId[]
export const MOOD_IDS = Object.keys(MOOD) as MoodId[]
export const TIME_IDS = Object.keys(TIME) as TimeId[]
export const STYLE_IDS = Object.keys(STYLE) as StyleId[]
export const GENDER_IDS = Object.keys(GENDER) as GenderId[]
