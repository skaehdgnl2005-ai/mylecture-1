/**
 * Client-safe mirror of the chip vocabulary.
 *
 * The prompt builder is server-only (it holds every English string the image
 * model can see), so the UI cannot import it. This file exposes ONLY the Korean
 * labels and the ids — no English, so the closed vocabulary stays auditable in
 * exactly one place and nothing about prompt construction reaches the client.
 *
 * The ids are kept in sync by a unit test that imports both.
 */
export const PLACE_CHIPS = [
  { id: 'city', ko: '도시' },
  { id: 'sea', ko: '바다' },
  { id: 'forest', ko: '숲/산' },
  { id: 'home', ko: '우리 집' },
  { id: 'stage', ko: '무대' },
  { id: 'lab', ko: '연구실' },
  { id: 'space', ko: '우주' },
  { id: 'cafe', ko: '카페' },
  { id: 'field', ko: '운동장' },
  { id: 'workshop', ko: '공방/스튜디오' },
  { id: 'other', ko: '기타' },
] as const

export const COMPANION_CHIPS = [
  { id: 'alone', ko: '혼자' },
  { id: 'friends', ko: '친구들' },
  { id: 'family', ko: '가족' },
  { id: 'coworkers', ko: '동료들' },
  { id: 'pet', ko: '반려동물' },
  { id: 'audience', ko: '팬/관객' },
  { id: 'students', ko: '학생들' },
  { id: 'child', ko: '아이' },
] as const

export const MOOD_CHIPS = [
  { id: 'excited', ko: '설레는' },
  { id: 'peaceful', ko: '평화로운' },
  { id: 'proud', ko: '당당한' },
  { id: 'warm', ko: '따뜻한' },
  { id: 'lively', ko: '신나는' },
  { id: 'dreamy', ko: '몽환적인' },
] as const

export const TIME_CHIPS = [
  { id: 'morning', ko: '아침' },
  { id: 'midday', ko: '한낮' },
  { id: 'sunset', ko: '노을' },
  { id: 'night', ko: '밤' },
] as const

export const STYLE_CARDS = [
  { id: 'anime', ko: '애니메이션', blurb: '따뜻한 애니메이션 그림' },
  { id: 'photo', ko: '실사', blurb: '영화 한 장면처럼' },
  { id: 'watercolor', ko: '수채화', blurb: '부드러운 물감 느낌' },
] as const

export const GENDER_CHIPS = [
  { id: 'unspecified', ko: '표시 안 함' },
  { id: 'male', ko: '남' },
  { id: 'female', ko: '여' },
] as const

export const STARTER_CHIPS = [
  '무대 위에서 노래를 부르고 있어요',
  '내가 만든 가게에서 손님을 맞아요',
  '반려견과 바닷가를 달리고 있어요',
] as const

/** Rotating encouragement for the waiting screen (PRD §7). */
export const WAITING_MESSAGES = [
  '색을 고르고 있어요',
  '배경을 그리는 중이에요',
  '빛을 넣고 있어요',
  '조금만 더 기다려 주세요',
  '거의 다 됐어요',
  '마지막으로 다듬는 중이에요',
] as const
