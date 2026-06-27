import { InputStream } from './input-stream'
import { OutputStream } from './output-stream'
import type { FlowChannelOptions } from './types'

/**
 * The flow channel façade — the "Midulabs Flow ID" of the diagram: one shared
 * `sessionKey` that producers fan IN to and consumers fan OUT from.
 *
 *   const channel = new FlowChannel({ apiUrl, webhookId, token, sessionKey })
 *   channel.input().sendText('hola')
 *   channel.output().on('node.token', ({ text }) => append(text))
 *
 * Each leg is a separate socket (a `produce` and a `consume`), so the durable
 * output reconnects independently of the producer. For a single bidirectional
 * socket, use `WebhookStreamSession` instead.
 *
 * Tokens: `inputToken`/`outputToken` override the shared `token` per leg, so a
 * trusted backend can hand a browser exactly the scope it needs (e.g. a
 * `produce` token to a patient, a `consume` token to a listener).
 */
export class FlowChannel {
  private opts: FlowChannelOptions
  private _input: InputStream | null = null
  private _output: OutputStream | null = null

  constructor(opts: FlowChannelOptions) {
    this.opts = opts
  }

  /** Lazily create (and connect on first send) the input leg. */
  input(): InputStream {
    if (!this._input) {
      this._input = new InputStream({
        apiUrl: this.opts.apiUrl,
        webhookId: this.opts.webhookId,
        token: this.resolveToken(this.opts.inputToken, 'input'),
        sessionKey: this.opts.sessionKey,
        baseInput: this.opts.baseInput,
        autoReconnect: this.opts.autoReconnect,
      })
    }
    return this._input
  }

  /** Lazily create (and connect) the output leg. */
  output(): OutputStream {
    if (!this._output) {
      this._output = new OutputStream({
        apiUrl: this.opts.apiUrl,
        webhookId: this.opts.webhookId,
        token: this.resolveToken(this.opts.outputToken, 'output'),
        sessionKey: this.opts.sessionKey,
        autoReconnect: this.opts.autoReconnect,
      })
    }
    return this._output
  }

  close(): void {
    this._input?.close()
    this._output?.close()
  }

  private resolveToken(perLeg: string | undefined, leg: string): string {
    const token = perLeg ?? this.opts.token
    if (!token) {
      throw new Error(`FlowChannel.${leg}: no token — set channel.token or ${leg}Token`)
    }
    return token
  }
}
