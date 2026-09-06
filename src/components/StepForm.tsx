'use client'

import { useEffect, useRef, useState } from 'react'
import { clsx } from 'clsx'
import {
  PLACE_CHIPS, COMPANION_CHIPS, MOOD_CHIPS, TIME_CHIPS, STYLE_CARDS,
  GENDER_CHIPS, STARTER_CHIPS,
} from '@/lib/chips'
import { Chip, BottomBar, PrimaryButton, StepDots, BackButton, Question, Hint } from './ui'

export interface FormValue {
  rawText: string
  visibleDetail: string
  place: string
  companions: string[]
  mood: string
  time: string
  style: string
  gender: string
}

const EMPTY: FormValue = {
  rawText: '', visibleDetail: '', place: '', companions: [],
  mood: '', time: '', style: '', gender: 'unspecified',
}

const TOTAL = 5

export function StepForm({
  allowedStyles,
  styleSamples,
  onSubmit,
  submitting,
  error,
  initialValue,
  onChange,
}: {
  allowedStyles: string[]
  styleSamples: Record<string, string | null>
  onSubmit: (v: FormValue) => void
  submitting: boolean
  /** Set when the server rejected a submission; jumps back to the right step. */
  error: { field: 1 | 2 | null; message: string; helpline?: boolean } | null
  /**
   * Answers to start from. StudentApp keeps them, because this component
   * unmounts while the waiting screen is up: a generation that fails after that
   * used to drop the student back onto five empty questions, with no idea which
   * one to change.
   */
  initialValue?: FormValue
  onChange?: (v: FormValue) => void
}) {
  // Where to open. A first visit starts at question 1. Coming BACK from a failed
  // generation, open the question the server blamed — or, when it blamed nothing
  // in particular, the last step, where 그림 그리기 is and where one tap retries.
  const [step, setStep] = useState(() => {
    if (!error) return 0
    return error.field ? error.field - 1 : TOTAL - 1
  })
  const [v, setV] = useState<FormValue>(initialValue ?? EMPTY)

  const set = <K extends keyof FormValue>(k: K, value: FormValue[K]) =>
    setV((prev) => ({ ...prev, [k]: value }))

  // Hand the answers up so they survive this component unmounting while the
  // waiting screen is shown. Kept in an effect rather than inside `set` so the
  // state updater stays pure.
  useEffect(() => {
    onChange?.(v)
  }, [v, onChange])

  // A NEW rejection arriving while the form is already up — the safety pipeline
  // answers before any job exists, so the component never unmounted in that
  // case. Jump to the question the server blamed.
  const lastError = useRef(error)
  useEffect(() => {
    if (error && error !== lastError.current && error.field) setStep(error.field - 1)
    lastError.current = error
  }, [error])

  // A style the teacher switched off while this form was open.
  //
  // The card vanishes from step 5 the moment the list changes, so a selection
  // still pointing at it would leave 그림 그리기 enabled on a choice the student
  // can no longer see — and the server refuses that submission. Clearing it
  // disables the button until they pick again, which IS the message.
  //
  // Returning `prev` unchanged when there is nothing to clear matters: the
  // parent rebuilds this array on some renders, so this effect re-runs often.
  useEffect(() => {
    setV((prev) => (prev.style && !allowedStyles.includes(prev.style) ? { ...prev, style: '' } : prev))
  }, [allowedStyles])

  const canAdvance = [
    v.rawText.trim().length > 0,
    v.place !== '',
    v.companions.length > 0,
    v.mood !== '' && v.time !== '',
    v.style !== '',
  ][step]

  const toggleCompanion = (id: string) => {
    // "혼자" is exclusive; picking it clears everything else and vice versa.
    if (id === 'alone') {
      set('companions', v.companions.includes('alone') ? [] : ['alone'])
      return
    }
    const without = v.companions.filter((c) => c !== 'alone')
    if (without.includes(id)) {
      set('companions', without.filter((c) => c !== id))
    } else if (without.length < 2) {
      set('companions', [...without, id])
    }
  }

  const next = () => (step === TOTAL - 1 ? onSubmit(v) : setStep((s) => s + 1))

  const visibleStyles = STYLE_CARDS.filter((s) => allowedStyles.includes(s.id))

  return (
    <div className="h-screen-safe flex flex-col">
      <header className="pt-safe flex items-center gap-2 px-3 pb-2">
        {step > 0 ? <BackButton onClick={() => setStep((s) => s - 1)} /> : <div className="h-11 w-11" />}
        <StepDots total={TOTAL} current={step} />
      </header>

      <div className="flex-1 overflow-y-auto px-5 pb-6">
        {error && (
          <div
            role="alert"
            className={clsx(
              'mb-5 rounded-2xl px-4 py-3 text-[15px] leading-relaxed whitespace-pre-line',
              error.helpline
                ? 'bg-amber-50 text-amber-900'
                : 'bg-red-50 text-red-800',
            )}
          >
            {error.message}
          </div>
        )}

        {step === 0 && (
          <section className="space-y-5">
            <Question>
              10년 뒤, 가장 행복한 어느 하루.
              <br />
              나는 지금 <span className="text-brand-600">무엇을 하고 있나요?</span>
            </Question>
            <div>
              <textarea
                value={v.rawText}
                onChange={(e) => set('rawText', e.target.value.slice(0, 40))}
                maxLength={40}
                rows={3}
                autoComplete="off"
                placeholder="예) 내가 만든 게임을 친구들과 처음 같이 해보고 있어요"
                className="w-full resize-none rounded-2xl border-2 border-gray-200 bg-white p-4 leading-relaxed placeholder:text-gray-300 focus:border-brand-400 focus:outline-none"
              />
              <div className="mt-1 text-right text-sm text-gray-400">
                {v.rawText.length}/40
              </div>
            </div>
            <div className="space-y-2">
              <Hint>이렇게 시작해도 좋아요 (눌러서 고치기)</Hint>
              <div className="flex flex-wrap gap-2">
                {STARTER_CHIPS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => set('rawText', s)}
                    className="rounded-full border-2 border-dashed border-gray-200 bg-white px-4 py-2.5 text-left text-[15px] text-gray-600 active:bg-gray-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="space-y-5">
            <Question>
              <span className="text-brand-600">어디</span>인가요?
            </Question>
            <div className="flex flex-wrap gap-2">
              {PLACE_CHIPS.map((p) => (
                <Chip key={p.id} label={p.ko} selected={v.place === p.id} onClick={() => set('place', p.id)} />
              ))}
            </div>
            <div className="space-y-2 pt-2">
              <Hint>주변에 무엇이 보이나요? (안 써도 괜찮아요)</Hint>
              <input
                value={v.visibleDetail}
                onChange={(e) => set('visibleDetail', e.target.value.slice(0, 15))}
                maxLength={15}
                autoComplete="off"
                placeholder="예) 큰 창문, 트로피, 망원경"
                className="w-full rounded-2xl border-2 border-gray-200 bg-white p-4 placeholder:text-gray-300 focus:border-brand-400 focus:outline-none"
              />
              <div className="text-right text-sm text-gray-400">{v.visibleDetail.length}/15</div>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="space-y-5">
            <Question>
              그 순간 나는 <span className="text-brand-600">누구와</span> 있나요?
            </Question>
            <Hint>최대 2개까지 고를 수 있어요</Hint>
            <div className="flex flex-wrap gap-2">
              {COMPANION_CHIPS.map((c) => {
                const selected = v.companions.includes(c.id)
                const full = v.companions.length >= 2 && !selected && c.id !== 'alone'
                const blockedByAlone = v.companions.includes('alone') && c.id !== 'alone'
                return (
                  <Chip
                    key={c.id}
                    label={c.ko}
                    selected={selected}
                    disabled={full || blockedByAlone}
                    onClick={() => toggleCompanion(c.id)}
                  />
                )
              })}
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="space-y-6">
            <Question>
              그 장면의 <span className="text-brand-600">분위기와 시간</span>은?
            </Question>
            <div className="space-y-3">
              <Hint>분위기</Hint>
              <div className="flex flex-wrap gap-2">
                {MOOD_CHIPS.map((m) => (
                  <Chip key={m.id} label={m.ko} selected={v.mood === m.id} onClick={() => set('mood', m.id)} />
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <Hint>시간</Hint>
              <div className="flex flex-wrap gap-2">
                {TIME_CHIPS.map((t) => (
                  <Chip key={t.id} label={t.ko} selected={v.time === t.id} onClick={() => set('time', t.id)} />
                ))}
              </div>
            </div>
          </section>
        )}

        {step === 4 && (
          <section className="space-y-6">
            <Question>어떤 그림으로 그릴까요?</Question>
            <div className="grid gap-3">
              {visibleStyles.map((s) => {
                const selected = v.style === s.id
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => set('style', s.id)}
                    className={clsx(
                      'flex items-center gap-4 rounded-2xl border-2 p-3 text-left transition-colors',
                      selected ? 'border-brand-500 bg-brand-50' : 'border-gray-200 bg-white',
                    )}
                  >
                    <div className="h-20 w-16 shrink-0 overflow-hidden rounded-xl bg-gray-100">
                      {styleSamples[s.id] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={styleSamples[s.id]!} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-xs text-gray-300">
                          예시
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={clsx('text-lg font-semibold', selected ? 'text-brand-700' : 'text-gray-900')}>
                        {s.ko}
                      </div>
                      <div className="text-sm text-gray-500">{s.blurb}</div>
                    </div>
                    {selected && (
                      <svg width="22" height="22" viewBox="0 0 16 16" className="shrink-0 text-brand-600" aria-hidden="true">
                        <path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                )
              })}
            </div>

            <div className="space-y-3 border-t border-gray-100 pt-5">
              <Hint>그림 속 내 모습 (안 골라도 괜찮아요)</Hint>
              <div className="flex flex-wrap gap-2">
                {GENDER_CHIPS.map((g) => (
                  <Chip key={g.id} label={g.ko} selected={v.gender === g.id} onClick={() => set('gender', g.id)} />
                ))}
              </div>
            </div>
          </section>
        )}
      </div>

      <BottomBar>
        <PrimaryButton disabled={!canAdvance || submitting} onClick={next}>
          {submitting ? '보내는 중…' : step === TOTAL - 1 ? '그림 그리기' : '다음'}
        </PrimaryButton>
      </BottomBar>
    </div>
  )
}

export { EMPTY as EMPTY_FORM }
