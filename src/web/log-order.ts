/** The order of the log: by Homebridge's time, then by id. Pages and the "older" cursor use the same order. */
export interface LineKey {
  ts: number
  id: number
}

/** True when `a` comes before `b` in the log. */
export function isBefore(a: LineKey, b: LineKey): boolean {
  return a.ts < b.ts || (a.ts === b.ts && a.id < b.id)
}

/** A copy of `lines` in log order. */
export function inLogOrder<T extends LineKey>(lines: readonly T[]): T[] {
  return [...lines].sort((a, b) => a.ts - b.ts || a.id - b.id)
}

/** A sortable local-day number, such as 20261020. */
export function dayNumber(ts: number): number {
  const date = new Date(ts)
  return date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate()
}

/**
 * Lines that arrive while the reader is scrolled up, kept to be shown when
 * they come back down. Past `limit` the oldest no longer join up with the
 * view, so the hold reports that it overflowed and keeps nothing.
 */
export class HeldLines<T> {
  private lines: T[] = []
  private hasOverflowed = false
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  get overflowed(): boolean {
    return this.hasOverflowed
  }

  add(lines: readonly T[]): void {
    if (this.hasOverflowed) {
      return
    }
    this.lines.push(...lines)
    if (this.lines.length > this.limit) {
      this.lines = []
      this.hasOverflowed = true
    }
  }

  /** Everything held, emptying the hold. */
  take(): T[] {
    const lines = this.lines
    this.lines = []
    this.hasOverflowed = false
    return lines
  }

  clear(): void {
    this.take()
  }
}
