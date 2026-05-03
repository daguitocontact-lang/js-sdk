export function expBackoff(attempt: number, baseMs: number, maxMs: number): number {
  const delay = Math.min(maxMs, baseMs * 2 ** attempt)
  const jitter = delay * 0.2 * Math.random()
  return Math.floor(delay + jitter)
}
