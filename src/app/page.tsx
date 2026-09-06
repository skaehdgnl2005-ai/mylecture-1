'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { PrimaryButton } from '@/components/ui'

export default function Home() {
  const router = useRouter()
  const [code, setCode] = useState('')

  const go = () => {
    if (code.length === 4) router.push(`/s/${code.toUpperCase()}`)
  }

  return (
    <main className="h-screen-safe flex flex-col items-center justify-center gap-10 px-8">
      <div className="space-y-3 text-center">
        <h1 className="text-3xl leading-snug font-semibold text-gray-900">
          10년 뒤의 나
        </h1>
        <p className="text-[15px] leading-relaxed text-gray-500">
          가장 행복한 어느 하루를
          <br />
          그림으로 그려 볼까요?
        </p>
      </div>

      <div className="w-full max-w-xs space-y-4">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && go()}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          placeholder="A7K2"
          aria-label="세션 코드 4자리"
          className="w-full rounded-2xl border-2 border-gray-200 bg-white py-5 text-center text-3xl font-semibold tracking-[0.4em] uppercase placeholder:tracking-[0.4em] placeholder:text-gray-200 focus:border-brand-400 focus:outline-none"
        />
        <PrimaryButton disabled={code.length !== 4} onClick={go}>
          들어가기
        </PrimaryButton>
        <p className="text-center text-sm text-gray-400">
          화면에 있는 코드 4자리를 입력해 주세요
        </p>
      </div>
    </main>
  )
}
