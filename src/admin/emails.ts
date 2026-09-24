/**
 * Transactional email service — `client.emails.send({ ... })`.
 *
 * A per-org micro-service (e.g. the "Somos Cocuy" API) sends its own
 * transactional mail THROUGH Daguito instead of talking to a provider directly.
 * Daguito picks the best sender (the org's verified SES mailbox, else its own
 * MailerSend system sender) and, when a `sessionKey` is given, records the send
 * against that CRM conversation so it shows up in the inbox timeline.
 *
 * Auth is the account key on the client — the same `dgsk_acc_…` bound to one org.
 */

import { AdminTransport, DaguitoError } from './http'

/** One attachment; its bytes carried as base64 (e.g. a contract PDF). */
export interface EmailAttachment {
  filename: string
  /** base64-encoded file contents. */
  content: string
  contentType?: string
}

export interface SendEmailInput {
  /** The org whose mailbox sends this mail (the account key must belong to it). */
  orgId: string
  to: string
  subject: string
  html: string
  /** Plain-text alternative. Derived from `html` server-side when omitted. */
  text?: string
  replyTo?: string
  attachments?: EmailAttachment[]
  /**
   * Conversation this email belongs to (`whatsapp:<line>:<customer>`, …). When
   * present, Daguito records the send on that conversation so the CRM shows it.
   * Omit for mail with no conversation.
   */
  sessionKey?: string | null
}

export class EmailsService {
  constructor(private readonly transport: AdminTransport) {}

  async send(input: SendEmailInput): Promise<{ ok: true }> {
    const body: Record<string, unknown> = {
      to: input.to,
      subject: input.subject,
      html: input.html,
    }
    if (input.text !== undefined) body.text = input.text
    if (input.replyTo !== undefined) body.reply_to = input.replyTo
    if (input.attachments !== undefined) {
      body.attachments = input.attachments.map((a) => ({
        filename: a.filename,
        content: a.content,
        ...(a.contentType !== undefined ? { content_type: a.contentType } : {}),
      }))
    }
    const sessionKey = input.sessionKey?.trim()
    if (sessionKey) body.session_key = sessionKey

    const data = await this.transport.request<{ ok?: boolean }>(
      'POST',
      `/organizations/${encodeURIComponent(input.orgId)}/email/send`,
      body,
    )
    if (!data?.ok) throw new DaguitoError('email send did not succeed')
    return { ok: true }
  }
}
