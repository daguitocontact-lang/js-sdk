import type { SendableMessage } from '../types'

/**
 * Shared outbound-message framing for every producer surface (WebhookStreamSession,
 * InputStream, FlowChannel.input). Keeps the wire mapping in one place so the
 * roles never drift on how a `SendableMessage` becomes an InboundMessage +
 * base_input envelope.
 */

/** Media kinds passed as a `File`/`Blob` need a presigned upload the streaming
 *  token can't mint — those callers must use WidgetSession instead. */
export function requiresUpload(message: SendableMessage): boolean {
  return (
    (message.kind === 'image' ||
      message.kind === 'audio' ||
      message.kind === 'document' ||
      message.kind === 'video') &&
    'file' in message
  )
}

export function toInboundMessage(message: SendableMessage): Record<string, unknown> {
  // The streaming WS path historically uses kind=text on the InboundMessage
  // and moves image/multi-image references onto base_input. Pre-uploaded media
  // kinds carry the mediaKey on InboundMessage.media.
  if (message.kind !== 'form-response' && 'mediaKey' in message) {
    return {
      kind: message.kind,
      text: message.text,
      media: {
        // MediaRefSchema on the server uses `key` (not `media_key`); the SDK
        // helper takes camelCase `mediaKey` as a friendlier alias.
        key: message.mediaKey,
        mime_type: message.mimeType,
        size_bytes: message.sizeBytes,
        // Client-owned media: Daguito fetches the bytes from this presigned URL
        // instead of signing the key against its own storage.
        ...(message.mediaUrl ? { url: message.mediaUrl } : {}),
      },
    }
  }
  if (message.kind === 'form-response') {
    // form-response has its own widget endpoint; on the streaming surface we
    // still allow it for completeness — the flow can branch on
    // base_input.is_form_response.
    return { kind: 'text', text: '[form-response]' }
  }
  if (message.kind === 'text') return { kind: 'text', text: message.text }
  return { kind: 'text', text: 'text' in message ? (message.text ?? '') : '' }
}

export function computeBaseInput(message: SendableMessage): Record<string, unknown> {
  if (message.kind === 'image' && 'imageUrl' in message) return { image_url: message.imageUrl }
  if (message.kind === 'image-multi' && message.imageUrls) {
    return { image_urls: message.imageUrls }
  }
  if (message.kind === 'form-response') {
    return {
      form_response: message.payload,
      form_response_id: message.formId,
      is_form_response: true,
    }
  }
  return {}
}
