/**
 * Upload helper for webhook integrators — one-shot, mirrors `runWebhook`.
 *
 * Mints a presigned PUT URL via the Daguito webhook upload endpoint, PUTs
 * the bytes, and returns the resulting `mediaKey`. The caller feeds that
 * key to a subsequent `session.send(mediaKeyMessage(...))`.
 *
 * The flow mirrors what OpenAI Files API and Anthropic Files API expose:
 * bytes never stream through the Daguito API — only the presign POST does.
 * The PUT goes straight to object storage. Cheaper, faster, scales linearly.
 *
 *   import { uploadFile } from '@daguito/sdk'
 *   const result = await uploadFile({
 *     apiUrl: 'https://api.daguito.com',
 *     webhookId: 'wh_xxx',
 *     token: 'sk_wh_yyy',
 *     kind: 'document',
 *     file: someBlob,
 *     filename: 'contract.pdf',
 *   })
 *   console.log(result.mediaKey)
 */

import { joinHttp } from './url'

// The message kinds that accept an attachment (mirrors `@daguito/core`
// `MESSAGE_KINDS`). text / voice_stream / rich never upload anything.
export type UploadKind = 'image' | 'audio' | 'document'

export interface UploadInput {
  apiUrl: string
  webhookId: string
  token: string
  kind: UploadKind
  /** Browser/Node `File` or `Blob`. Exactly one of `file` or `data`. */
  file?: File | Blob
  /** Raw in-memory bytes. Requires `filename`. */
  data?: Uint8Array
  filename?: string
  mimeType?: string
  /** Default 30000 ms. */
  timeoutMs?: number
}

export interface UploadResult {
  mediaKey: string
  mimeType: string
  sizeBytes: number
  expiresInSec: number
}

export class UploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadError'
  }
}

interface ResolvedPayload {
  body: BodyInit
  filename: string
  mimeType: string
  sizeBytes: number
}

export async function uploadFile(input: UploadInput): Promise<UploadResult> {
  const resolved = resolvePayload(input)

  const presignUrl = joinHttp(input.apiUrl, `/v1/webhooks/${input.webhookId}/upload`)
  const timeoutMs = input.timeoutMs ?? 30_000
  const controller = new AbortController()
  const timeoutId = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null

  try {
    // Step 1: ask Daguito for a presigned PUT URL bound to this exact
    // kind/mime/size. The signer encodes both into the signature so a
    // client cannot upload a larger or different file than it announced.
    const presignResp = await fetch(presignUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: input.kind,
        mime_type: resolved.mimeType,
        size_bytes: resolved.sizeBytes,
        filename: resolved.filename,
      }),
      signal: controller.signal,
    })
    if (!presignResp.ok) {
      const text = await presignResp.text().catch(() => '')
      throw new UploadError(`presign failed: HTTP ${presignResp.status} ${text.slice(0, 200)}`)
    }
    const presign = parsePresign(await presignResp.json())

    // Step 2: PUT bytes directly to object storage. The presigned URL
    // carries auth in its query string — we MUST NOT add the bearer
    // token here (S3/R2 would reject the signed request).
    const putResp = await fetch(presign.uploadUrl, {
      method: 'PUT',
      headers: presign.requiredHeaders,
      body: resolved.body,
      signal: controller.signal,
    })
    if (!putResp.ok) {
      const text = await putResp.text().catch(() => '')
      throw new UploadError(`PUT to storage failed: HTTP ${putResp.status} ${text.slice(0, 200)}`)
    }

    return {
      mediaKey: presign.mediaKey,
      mimeType: resolved.mimeType,
      sizeBytes: resolved.sizeBytes,
      expiresInSec: presign.expiresInSec,
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

function resolvePayload(input: UploadInput): ResolvedPayload {
  const hasFile = input.file !== undefined
  const hasData = input.data !== undefined
  if (hasFile === hasData) {
    throw new UploadError('UploadInput requires exactly one of `file` or `data`')
  }

  if (input.file) {
    const sizeBytes = input.file.size
    if (sizeBytes === 0) throw new UploadError('UploadInput payload is empty')
    const filename = input.filename ?? fileName(input.file) ?? defaultFilename(input.kind)
    const mimeType = input.mimeType || input.file.type || defaultMime(input.kind)
    return { body: input.file, filename, mimeType, sizeBytes }
  }

  // `data` branch — narrow `input.data` for TS.
  const data = input.data
  if (!data) throw new UploadError('UploadInput.data is missing')
  if (!input.filename) {
    throw new UploadError('UploadInput.filename is required when passing raw `data`')
  }
  const sizeBytes = data.byteLength
  if (sizeBytes === 0) throw new UploadError('UploadInput payload is empty')
  const mimeType = input.mimeType || defaultMime(input.kind)
  // Wrap in a Blob so fetch's BodyInit accepts it across DOM/Bun typings —
  // newer lib.dom.d.ts narrows BufferSource and rejects Uint8Array directly.
  return {
    body: new Blob([new Uint8Array(data)], { type: mimeType }),
    filename: input.filename,
    mimeType,
    sizeBytes,
  }
}

function fileName(file: File | Blob): string | undefined {
  // Only `File` carries `.name`; plain `Blob` does not.
  const name = (file as File).name
  return typeof name === 'string' && name.length > 0 ? name : undefined
}

interface PresignBody {
  uploadUrl: string
  mediaKey: string
  requiredHeaders: Record<string, string>
  expiresInSec: number
}

function parsePresign(raw: unknown): PresignBody {
  if (typeof raw !== 'object' || raw === null) {
    throw new UploadError('presign response is not an object')
  }
  const r = raw as Record<string, unknown>
  const uploadUrl = r.upload_url
  const mediaKey = r.key
  if (typeof uploadUrl !== 'string' || typeof mediaKey !== 'string') {
    throw new UploadError('presign response missing `upload_url` or `key`')
  }
  const requiredHeaders =
    typeof r.required_headers === 'object' && r.required_headers !== null
      ? (r.required_headers as Record<string, string>)
      : {}
  const expiresInSec = typeof r.expires_in_sec === 'number' ? r.expires_in_sec : 0
  return { uploadUrl, mediaKey, requiredHeaders, expiresInSec }
}

function defaultMime(kind: UploadKind): string {
  if (kind === 'image') return 'image/jpeg'
  if (kind === 'audio') return 'audio/mpeg'
  return 'application/octet-stream'
}

function defaultFilename(kind: UploadKind): string {
  if (kind === 'image') return 'upload.jpg'
  if (kind === 'audio') return 'upload.mp3'
  return 'upload.bin'
}
