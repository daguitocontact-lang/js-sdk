import { joinHttp } from './url'
import type { UploadableFile, ReactNativeFileDescriptor } from './types'

/**
 * Upload a file payload through the platform's presigned PUT pipeline.
 *
 * Accepts a browser/Node `File`/`Blob` OR a React Native / Expo
 * descriptor `{ uri, type, name, size? }`. The SDK detects the shape and
 * sends bytes the way each runtime's `fetch` understands.
 *
 * Two-step flow (so bytes never go through the API server):
 *   1) POST /api/widget/upload — SDK exchanges its api_key + session_id
 *      for a short-lived signed PUT URL.
 *   2) PUT (direct to object storage) — runtime uploads the file with
 *      the exact mime/size the signature was minted for.
 *
 * This endpoint lives under the widget surface today because that's where
 * api_key auth is wired. A future "platform api keys" surface will likely
 * reuse the same primitive.
 */

export interface UploadInput {
  apiUrl: string
  apiKey: string
  sessionId: string
  file: UploadableFile
  kind: 'image' | 'audio' | 'document' | 'video'
  filename?: string
}

export interface UploadResult {
  mediaKey: string
  mimeType: string
  sizeBytes: number
}

function isReactNativeDescriptor(file: UploadableFile): file is ReactNativeFileDescriptor {
  // Blob/File expose `slice` and a numeric `size`; the RN descriptor has
  // a string `uri` and lacks both. Check `uri` first to short-circuit on
  // the common-case Blob/File path.
  return (
    typeof file === 'object' &&
    file !== null &&
    typeof (file as ReactNativeFileDescriptor).uri === 'string' &&
    typeof (file as Blob).slice !== 'function'
  )
}

interface FileMeta {
  mimeType: string
  sizeBytes: number
  filename?: string
}

function describeFile(file: UploadableFile, fallbackName?: string): FileMeta {
  if (isReactNativeDescriptor(file)) {
    return {
      mimeType: file.type || 'application/octet-stream',
      // RN descriptors don't always expose byte count. The signer accepts
      // 0 as "unknown" and verifies the actual size on completion.
      sizeBytes: typeof file.size === 'number' ? file.size : 0,
      filename: fallbackName ?? file.name,
    }
  }
  // File/Blob — `name` only exists on File; Blob falls back to fallbackName.
  const asFile = file as File
  return {
    mimeType: asFile.type || 'application/octet-stream',
    sizeBytes: asFile.size,
    filename: fallbackName ?? (typeof asFile.name === 'string' ? asFile.name : undefined),
  }
}

export async function uploadFile(input: UploadInput): Promise<UploadResult> {
  const meta = describeFile(input.file, input.filename)

  const signed = await fetch(joinHttp(input.apiUrl, '/api/widget/upload'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: input.sessionId,
      api_key: input.apiKey,
      kind: input.kind,
      mime_type: meta.mimeType,
      size_bytes: meta.sizeBytes,
      filename: meta.filename,
    }),
  })
  if (!signed.ok) {
    const text = await signed.text().catch(() => '')
    throw new Error(`upload sign HTTP ${signed.status}: ${text || signed.statusText}`)
  }
  const body = (await signed.json()) as {
    ok: boolean
    upload_url: string
    key: string
    required_headers: Record<string, string>
  }

  // Direct PUT to object storage. The signature binds mime + size, so the
  // headers must match exactly what the signer authorised — passing them
  // through unchanged. RN's fetch reads the `{uri,type,name}` body and
  // streams the file from disk; browser/Node send the Blob/File bytes.
  const put = await fetch(body.upload_url, {
    method: 'PUT',
    headers: body.required_headers,
    body: input.file as BodyInit,
  })
  if (!put.ok) throw new Error(`object storage PUT HTTP ${put.status}: ${put.statusText}`)

  return { mediaKey: body.key, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes }
}
