export type Listener<T> = (payload: T) => void

/**
 * Tiny typed event emitter. Each session class extends this so integrators
 * get fully-typed `on('event', ...)` autocomplete.
 */
export class Emitter<EventMap extends Record<string, unknown>> {
  private listeners = new Map<keyof EventMap, Set<Listener<unknown>>>()

  on<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): () => void {
    let bucket = this.listeners.get(event)
    if (!bucket) {
      bucket = new Set()
      this.listeners.set(event, bucket)
    }
    bucket.add(listener as Listener<unknown>)
    return () => {
      bucket?.delete(listener as Listener<unknown>)
    }
  }

  off<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<unknown>)
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const bucket = this.listeners.get(event)
    if (!bucket) return
    for (const listener of bucket) {
      try {
        ;(listener as Listener<EventMap[K]>)(payload)
      } catch (err) {
        // A listener throwing must not silence other listeners — surface
        // to console (the integrator's logger is their concern).
        // eslint-disable-next-line no-console
        console.error('[daguito-sdk] listener threw:', err)
      }
    }
  }

  removeAll(): void {
    this.listeners.clear()
  }
}
