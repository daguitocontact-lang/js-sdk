import { expBackoff } from './backoff'

/**
 * Resilient WebSocket client. Adds reconnect-with-backoff, heartbeats, a
 * stale-watchdog (closes half-open sockets so the reconnect loop kicks in),
 * focus/online listeners (browsers wake from a long backoff immediately),
 * and a small offline send queue.
 *
 * Inlined into the SDK (not pulled from a workspace dep) so the published
 * package has zero peer deps.
 */

export interface WSClientOptions<TInbound = unknown, TOutbound = unknown> {
  url: string | (() => string | Promise<string>)
  protocols?: string | string[]
  autoReconnect?: boolean
  heartbeatMs?: number
  heartbeatMessage?: () => TOutbound
  isHeartbeatAck?: (msg: TInbound) => boolean
  queueWhileDisconnected?: boolean
  maxQueueSize?: number
  backoff?: { baseMs?: number; maxMs?: number }
  staleMs?: number
  reconnectOnFocus?: boolean
  onOpen?: () => void
  onClose?: (event: CloseEvent) => void
  onError?: (event: Event) => void
  onMessage: (msg: TInbound) => void
  parse?: (raw: string) => TInbound
  serialize?: (msg: TOutbound) => string
}

export interface WSHandle<TOutbound = unknown> {
  send(msg: TOutbound): void
  close(): void
  readonly state: 'connecting' | 'open' | 'closing' | 'closed'
}

export function createWSClient<TInbound = unknown, TOutbound = unknown>(
  opts: WSClientOptions<TInbound, TOutbound>,
): WSHandle<TOutbound> {
  const heartbeatMs = opts.heartbeatMs ?? 25_000
  const autoReconnect = opts.autoReconnect ?? true
  const queueWhileDisconnected = opts.queueWhileDisconnected ?? true
  const maxQueueSize = opts.maxQueueSize ?? 100
  const baseMs = opts.backoff?.baseMs ?? 1_000
  const maxMs = opts.backoff?.maxMs ?? 30_000
  const staleMs = opts.staleMs ?? heartbeatMs * 2.5
  const reconnectOnFocus =
    opts.reconnectOnFocus ?? (typeof window !== 'undefined' && typeof document !== 'undefined')
  const parse = opts.parse ?? ((raw: string) => JSON.parse(raw) as TInbound)
  const serialize = opts.serialize ?? ((msg: TOutbound) => JSON.stringify(msg))

  let socket: WebSocket | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let closedByUser = false
  let attempt = 0
  let lastInboundAt = 0
  const queue: TOutbound[] = []

  const clearHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  const clearWatchdog = () => {
    if (watchdogTimer) {
      clearInterval(watchdogTimer)
      watchdogTimer = null
    }
  }

  const startHeartbeat = () => {
    clearHeartbeat()
    if (!opts.heartbeatMessage) return
    heartbeatTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        try {
          socket.send(serialize(opts.heartbeatMessage!()))
        } catch {
          // closure/onerror will surface.
        }
      }
    }, heartbeatMs)
  }

  // Half-open sockets (NAT timeout, suspended laptop) often never fire
  // `onclose`. The watchdog closes them so the reconnect loop re-enters.
  const startWatchdog = () => {
    clearWatchdog()
    if (staleMs <= 0) return
    const tick = Math.max(1_000, Math.floor(staleMs / 3))
    watchdogTimer = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastInboundAt < staleMs) return
      try {
        socket.close(4000, 'stale')
      } catch {
        // onclose will still fire eventually or the reconnect loop will retry.
      }
    }, tick)
  }

  const flushQueue = () => {
    while (queue.length && socket?.readyState === WebSocket.OPEN) {
      const msg = queue.shift()!
      socket.send(serialize(msg))
    }
  }

  const scheduleReconnect = () => {
    if (closedByUser || !autoReconnect) return
    const delay = expBackoff(attempt, baseMs, maxMs)
    attempt += 1
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      void connect()
    }, delay)
  }

  const forceReconnectIfNotOpen = () => {
    if (closedByUser) return
    if (socket?.readyState === WebSocket.OPEN) return
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    attempt = 0
    void connect()
  }

  const onVisibilityChange = () => {
    if (typeof document === 'undefined') return
    if (document.visibilityState === 'visible') forceReconnectIfNotOpen()
  }
  const onOnline = () => forceReconnectIfNotOpen()

  if (reconnectOnFocus && typeof window !== 'undefined') {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    window.addEventListener('online', onOnline)
  }

  async function connect(): Promise<void> {
    if (closedByUser) return
    const url = typeof opts.url === 'function' ? await opts.url() : opts.url
    const ws = new WebSocket(url, opts.protocols)
    socket = ws

    ws.onopen = () => {
      attempt = 0
      lastInboundAt = Date.now()
      startHeartbeat()
      startWatchdog()
      flushQueue()
      opts.onOpen?.()
    }

    ws.onmessage = (event) => {
      lastInboundAt = Date.now()
      let parsed: TInbound
      try {
        parsed = parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      if (opts.isHeartbeatAck?.(parsed)) return
      opts.onMessage(parsed)
    }

    ws.onerror = (event) => {
      opts.onError?.(event)
    }

    ws.onclose = (event) => {
      clearHeartbeat()
      clearWatchdog()
      opts.onClose?.(event)
      if (socket === ws) socket = null
      scheduleReconnect()
    }
  }

  void connect()

  return {
    send(msg: TOutbound) {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(serialize(msg))
        return
      }
      if (queueWhileDisconnected && queue.length < maxQueueSize) {
        queue.push(msg)
      }
    },
    close() {
      closedByUser = true
      clearHeartbeat()
      clearWatchdog()
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (reconnectOnFocus && typeof window !== 'undefined') {
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onVisibilityChange)
        }
        window.removeEventListener('online', onOnline)
      }
      if (socket) {
        try {
          socket.close()
        } catch {
          // already closing.
        }
        socket = null
      }
    },
    get state() {
      if (closedByUser) return 'closed'
      if (!socket) return 'connecting'
      switch (socket.readyState) {
        case WebSocket.CONNECTING:
          return 'connecting'
        case WebSocket.OPEN:
          return 'open'
        case WebSocket.CLOSING:
          return 'closing'
        default:
          return 'closed'
      }
    },
  }
}
