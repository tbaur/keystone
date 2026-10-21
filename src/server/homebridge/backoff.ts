export interface BackoffOptions {
  baseMs?: number
  maxMs?: number
  /** The shortest delay. Defaults to half of `baseMs`. */
  minMs?: number
  random?: () => number
}

/** Exponential backoff with full jitter: each delay is random up to a cap that doubles. */
export class Backoff {
  private attempt = 0
  private readonly baseMs: number
  private readonly maxMs: number
  private readonly minMs: number
  private readonly random: () => number

  constructor(options: BackoffOptions = {}) {
    this.baseMs = options.baseMs ?? 1000
    this.maxMs = options.maxMs ?? 60_000
    this.minMs = options.minMs ?? this.baseMs / 2
    this.random = options.random ?? Math.random
  }

  next(): number {
    const cap = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt)
    this.attempt = Math.min(this.attempt + 1, 30)
    return Math.max(this.minMs, Math.round(cap * this.random()))
  }

  reset(): void {
    this.attempt = 0
  }
}
