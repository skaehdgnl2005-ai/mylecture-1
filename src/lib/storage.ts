import 'server-only'
import { db } from './db'
import { env } from './env'

/**
 * Session-scoped, unguessable object keys. Combined with a public bucket this
 * makes the URL space non-enumerable, which is the minimum defensible posture
 * for images generated from the input of minors.
 *
 * Note (documented deliberately, see plan §11 risk 4): teacher "hide" removes
 * an image from the gallery query but does NOT revoke this URL for anyone who
 * already has it. Real revocation would need a private bucket and short-TTL
 * signed URLs.
 */
export function imageKey(sessionCode: string, extension = 'jpg'): string {
  return `${sessionCode}/${crypto.randomUUID()}.${extension}`
}

export async function uploadImage(
  key: string,
  bytes: Buffer,
  contentType: string,
): Promise<{ path: string; url: string }> {
  const bucket = env().SUPABASE_STORAGE_BUCKET

  const { error } = await db().storage.from(bucket).upload(key, bytes, {
    // Supabase defaults contentType to text/plain;charset=UTF-8. Forget this and
    // browsers download the file instead of rendering it.
    contentType,
    // A string of seconds, not a number.
    cacheControl: '31536000',
    // Never upsert: overwriting a path serves stale CDN content, and the
    // projector is the worst place to discover that.
    upsert: false,
  })
  if (error) throw new Error(`storage upload failed: ${error.message}`)

  const { data } = db().storage.from(bucket).getPublicUrl(key)
  return { path: key, url: data.publicUrl }
}

export async function deleteImages(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const bucket = env().SUPABASE_STORAGE_BUCKET
  // Storage objects are removed BEFORE the DB rows that point at them, so a
  // failure here leaves a recoverable pointer rather than an orphaned blob.
  const { error } = await db().storage.from(bucket).remove(paths)
  if (error) throw new Error(`storage delete failed: ${error.message}`)
}

export async function downloadImage(path: string): Promise<Blob> {
  const bucket = env().SUPABASE_STORAGE_BUCKET
  const { data, error } = await db().storage.from(bucket).download(path)
  if (error || !data) throw new Error(`storage download failed: ${error?.message}`)
  return data
}
