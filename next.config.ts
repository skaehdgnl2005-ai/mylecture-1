import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Remote images are optimised by next/image into 512px thumbnails for the
  // gallery grid. images.domains is deprecated; remotePatterns is required or
  // every gallery <Image> 400s.
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co', pathname: '/storage/v1/object/public/**' },
    ],
    // v16 defaults to [75] and SILENTLY coerces any other quality prop to the
    // nearest allowed value, so the projector's 80 must be declared.
    qualities: [75, 80],
  },
  // NOTE: do not add a webpack() config. Turbopack is the default builder in
  // Next 16 and `next build` fails outright if a webpack config exists.
}

export default nextConfig
