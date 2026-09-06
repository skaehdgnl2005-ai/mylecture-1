'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { PrimaryButton } from './ui'

export function TeacherLogin() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/teacher/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const d = await res.json()
      if (d.ok) router.refresh()
      else setError(d.message ?? '들어갈 수 없어요.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-5">
        <h1 className="text-2xl font-semibold text-gray-900">선생님 화면</h1>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="관리자 비밀번호"
          autoComplete="current-password"
          className="w-full rounded-2xl border-2 border-gray-200 bg-white p-4 focus:border-brand-400 focus:outline-none"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <PrimaryButton onClick={submit} disabled={busy || !password}>
          {busy ? '확인 중…' : '들어가기'}
        </PrimaryButton>
      </div>
    </main>
  )
}
