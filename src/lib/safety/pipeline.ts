import 'server-only'
import { scan } from './banned-words'
import { moderateFields } from '@/lib/openai/moderation'
import { translateAction, translateDetail } from '@/lib/openai/translate'
import { FALLBACK_ACTION, type PlaceId } from '@/lib/prompt/build-image-prompt'

/**
 * Layers 1-3 run PER FIELD and BEFORE any job row is inserted.
 *
 * That single ordering decision satisfies two PRD requirements at once:
 *  - §5-3 "tell them roughly which answer was the problem": we still know which
 *    field we were looking at when we rejected.
 *  - §5-3 "failure does not consume the attempt": a rejected submission never
 *    becomes a job, so there is nothing to decrement. There is no decrement
 *    path anywhere in the system, which is why it cannot drift.
 */

export type RejectKind = 'banned' | 'moderation' | 'selfharm' | 'nonsense' | 'unsafe'

export interface SafetyReject {
  ok: false
  kind: RejectKind
  /** 1 = the free sentence, 2 = "보이는 것". Drives the Korean copy. */
  field: 1 | 2 | null
  message: string
  /** Rendered as a distinct, gentler screen with helpline numbers. */
  helpline?: boolean
}

export interface SafetyPass {
  ok: true
  actionEn: string
  visibleDetailEn: string | null
  /** True when the translator refused and we fell back to a chip-derived action. */
  usedFallback: boolean
}

export type SafetyResult = SafetyPass | SafetyReject

// ── Korean copy. Middle-school reading level, no technical terms. ───────────
const COPY = {
  bannedField1: '1번 문장에 쓸 수 없는 말이 있어요. 조금 바꿔볼까요?',
  bannedField2: '2번에 적은 말은 쓸 수 없어요. 다른 걸 적어볼까요?',
  moderationField1: '1번 문장을 조금 다르게 써볼까요?',
  moderationField2: '2번 답변을 바꿔볼까요?',
  nonsense: '1번 문장을 조금 더 자세히 써주세요. 무엇을 하고 있는지 알려주면 돼요.',
  nonsenseDetail: '2번에 보이는 것을 조금 더 또렷하게 적어주세요.',
  offTopic: '10년 뒤에 무엇을 하고 있을지 적어주세요.',
  // Deliberately NOT routed through the generic "다른 말로 바꿔볼까요?" path.
  selfharm:
    '지금 많이 힘들구나. 혼자 담아두지 않아도 괜찮아요.\n' +
    '선생님이나 어른에게 이야기해 보면 좋겠어요.\n\n' +
    '언제든 이야기할 수 있어요\n· 자살예방상담 109\n· 청소년상담 1388\n\n' +
    '그림은 다른 이야기로 그려볼까요? 횟수는 그대로예요.',
} as const

export interface SafetyInput {
  rawText: string
  visibleDetail: string
  place: PlaceId
}

export async function runSafetyPipeline(input: SafetyInput): Promise<SafetyResult> {
  const text = input.rawText.trim()
  const detail = input.visibleDetail.trim()

  // ── L1: deterministic word filter, per field ─────────────────────────────
  const s1 = scan(text)
  const s2 = detail ? scan(detail) : { hard: [], soft: [], selfharm: [], ok: true }

  if (s1.selfharm.length > 0 || s2.selfharm.length > 0) {
    return { ok: false, kind: 'selfharm', field: null, message: COPY.selfharm, helpline: true }
  }
  if (s1.hard.length > 0) {
    return { ok: false, kind: 'banned', field: 1, message: COPY.bannedField1 }
  }
  if (s2.hard.length > 0) {
    return { ok: false, kind: 'banned', field: 2, message: COPY.bannedField2 }
  }
  // Soft matches (brands, real people) are deliberately NOT surfaced. The
  // translator generalises them away and the student sees a lovely picture.

  // ── L2: Moderation API, both fields in one array call ────────────────────
  const mod = await moderateFields([text, detail])
  if (!mod.ok) {
    if (mod.reason === 'selfharm') {
      return { ok: false, kind: 'selfharm', field: null, message: COPY.selfharm, helpline: true }
    }
    const field = mod.fieldIndex === 0 ? 1 : 2
    return {
      ok: false,
      kind: 'moderation',
      field,
      message: field === 1 ? COPY.moderationField1 : COPY.moderationField2,
    }
  }

  // ── L3: translate + sanitise, per field ──────────────────────────────────
  const action = await translateAction(text)

  if (!action.ok) {
    if (action.reason === 'unsafe') {
      return { ok: false, kind: 'unsafe', field: 1, message: COPY.moderationField1 }
    }
    if (action.reason === 'off_topic') {
      return { ok: false, kind: 'nonsense', field: 1, message: COPY.offTopic }
    }
    return { ok: false, kind: 'nonsense', field: 1, message: COPY.nonsense }
  }

  let visibleDetailEn: string | null = null
  let usedFallback = false
  if (detail) {
    const d = await translateDetail(detail)
    if (d.ok) {
      visibleDetailEn = d.phrase
    } else if (d.reason === 'unsafe') {
      return { ok: false, kind: 'unsafe', field: 2, message: COPY.moderationField2 }
    }
    // A merely unusable detail is dropped silently — it is an optional field,
    // and blocking a submission over it would be disproportionate.
  }

  return { ok: true, actionEn: action.phrase, visibleDetailEn, usedFallback }
}

/**
 * PRD §5-1 says "번역 실패 시 원문 그대로 삽입". We do NOT do that: inserting raw
 * Korean silently disables the layer that strips real people and brands, and the
 * DB CHECK would reject the row anyway. This chip-derived action is the
 * replacement — nobody goes home without a picture, nobody bypasses sanitation.
 */
export function fallbackAction(place: PlaceId): string {
  return FALLBACK_ACTION[place]
}

export const SAFETY_COPY = COPY
