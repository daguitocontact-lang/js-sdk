import { joinHttp } from './url'

/**
 * Upload a File/Blob through the platform's presigned PUT pipeline.
 *
 * Two-step flow (so bytes never go through the API server):
 *   1) POST /api/widget/upload — SDK exchanges its api_key + session_id
 *      for a short-lived signed PUT URL.
 *   2) PUT (direct to object storage) — browser uploads the file with
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
  file: File | Blob
  kind: 'image' | 'audio' | 'document'
  filename?: string
}

export interface UploadResult {
  mediaKey: string
  mimeType: string
  sizeBytes: number
}

export async function uploadFile(input: UploadInput): Promise<UploadResult> {
  const mimeType = input.file.type || 'application/octet-stream'
  const sizeBytes = input.file.size

  const signed = await fetch(joinHttp(input.apiUrl, '/api/widget/upload'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: input.sessionId,
      api_key: input.apiKey,
      kind: input.kind,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      filename: input.filename,
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
  // through unchanged.
  const put = await fetch(body.upload_url, {
    method: 'PUT',
    headers: body.required_headers,
    body: input.file,
  })
  if (!put.ok) throw new Error(`object storage PUT HTTP ${put.status}: ${put.statusText}`)

  return { mediaKey: body.key, mimeType, sizeBytes }
}
