'use client'

import { clsx } from 'clsx'

/**
 * Chip.
 *
 * PRD §7 accessibility: the selected state is shown by colour AND a check icon,
 * never colour alone. Touch target is >= 44px.
 */
export function Chip({
  label,
  selected,
  disabled,
  onClick,
}: {
  label: string
  selected: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'inline-flex min-h-[48px] items-center gap-2 rounded-full border-2 px-5 py-2.5',
        'text-base transition-colors select-none',
        selected
          ? 'border-brand-500 bg-brand-50 font-semibold text-brand-700'
          : 'border-gray-200 bg-white text-gray-700 active:bg-gray-50',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      {selected && (
        <svg
          width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"
          className="shrink-0"
        >
          <path
            d="M3 8.5l3.2 3.2L13 5"
            fill="none" stroke="currentColor" strokeWidth="2.4"
            strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      )}
      {label}
    </button>
  )
}

/** Bottom-fixed primary action. 48px+ tall, thumb-reachable, clears the home indicator. */
export function BottomBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="pb-safe sticky bottom-0 z-10 border-t border-gray-100 bg-gray-50/95 px-5 pt-3 backdrop-blur">
      {children}
    </div>
  )
}

export function PrimaryButton({
  children,
  disabled,
  onClick,
  type = 'button',
}: {
  children: React.ReactNode
  disabled?: boolean
  onClick?: () => void
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'h-14 w-full rounded-2xl text-lg font-semibold transition-colors',
        disabled
          ? 'bg-gray-200 text-gray-400'
          : 'bg-brand-500 text-white active:bg-brand-600',
      )}
    >
      {children}
    </button>
  )
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'h-12 w-full rounded-2xl border-2 border-gray-200 bg-white text-base font-semibold text-gray-700',
        disabled && 'opacity-40',
      )}
    >
      {children}
    </button>
  )
}

/** Five progress dots (PRD §5-1). */
export function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex items-center gap-2" role="progressbar" aria-valuenow={current + 1} aria-valuemin={1} aria-valuemax={total} aria-label={`${total}단계 중 ${current + 1}단계`}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={clsx(
            'h-2 rounded-full transition-all',
            i === current ? 'w-6 bg-brand-500' : i < current ? 'w-2 bg-brand-300' : 'w-2 bg-gray-200',
          )}
        />
      ))}
    </div>
  )
}

export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="이전 질문으로"
      className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-gray-500 active:bg-gray-100"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

export function Question({ children }: { children: React.ReactNode }) {
  return <h1 className="text-2xl leading-snug font-semibold text-gray-900">{children}</h1>
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[15px] leading-relaxed text-gray-500">{children}</p>
}
