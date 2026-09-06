import type { MetadataRoute } from 'next'

// "홈 화면에 추가" only. No service worker: PRD §6-1 says offline is not needed,
// and a stale cached shell during a lesson would be worse than no PWA at all.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '10년 뒤의 나',
    short_name: '10년 뒤의 나',
    description: '10년 뒤 가장 행복한 어느 하루를 그려 보세요.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f9fafb',
    theme_color: '#3763f4',
    lang: 'ko',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  }
}
