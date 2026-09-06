import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import './globals.css'

/**
 * Static subset, NOT PretendardVariable.woff2.
 *
 * The variable file every Korean Next.js tutorial recommends is 2.0 MB, which
 * alone breaks PRD §8's 3-second-on-3G budget. There is no single-file variable
 * subset — the variable build ships either full or as 92 dynamic chunks. Two
 * static subset weights at ~261 KB each is the honest trade.
 *
 * adjustFontFallback defaults to 'Arial', i.e. Latin metrics applied to a Hangul
 * face, which produces visible reflow on the step form. Hence false.
 */
const pretendard = localFont({
  src: [
    { path: './fonts/Pretendard-Regular.subset.woff2', weight: '400', style: 'normal' },
    { path: './fonts/Pretendard-SemiBold.subset.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-pretendard',
  display: 'swap',
  adjustFontFallback: false,
  preload: true,
})

export const metadata: Metadata = {
  title: '10년 뒤의 나',
  description: '10년 뒤 가장 행복한 어느 하루를 그려 보세요.',
  // Inherited by every route. The whole app is unlisted by design (PRD §6-4).
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
  appleWebApp: { capable: true, statusBarStyle: 'default', title: '10년 뒤의 나' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Makes env(safe-area-inset-*) non-zero, so the fixed footer button clears
  // the home indicator instead of sitting under it.
  viewportFit: 'cover',
  // The default ('resizes-visual') lets the Korean IME keyboard OVERLAY a
  // position: fixed footer rather than pushing it up.
  interactiveWidget: 'resizes-content',
  themeColor: '#3763f4',
  // userScalable is deliberately not set: disabling zoom fails WCAG 1.4.4 and
  // PRD §7 requires AA.
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={pretendard.variable}>
      <body>{children}</body>
    </html>
  )
}
