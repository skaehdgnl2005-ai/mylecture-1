import type { MetadataRoute } from 'next'

// Belt and braces with the root layout's robots metadata. The gallery is
// reachable only with a session code and must never be indexed (PRD §6-4).
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: '*', disallow: '/' }] }
}
