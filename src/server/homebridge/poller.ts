import { AUTH_RETRY_MS, HomebridgeApiError } from './api-client.ts'
import { Backoff } from './backoff.ts'

/** Failures stretch a poll's interval up to 6 times, but not past this unless the interval itself is longer. */
const MAX_BACKOFF_MS = 10 * 60_000

export interface PollerOptions {
  intervalMs: number
  task: () => Promise<void>
  /** Gets every error of `task`, which never reaches the caller. */
  onError: (error: unknown) => void
  random?: () => number
}

/**
 * Runs a task now and then every `intervalMs` after it finishes, so a slow
 * call never overlaps the next one. After a failure the wait grows with
 * jitter, and a rejected login waits AUTH_RETRY_MS.
 */
export class Poller {
  private readonly options: PollerOptions
  private readonly backoff: Backoff
  private timer: NodeJS.Timeout | null = null
  private stopped = true

  constructor(options: PollerOptions) {
    this.options = options
    const { intervalMs } = options
    this.backoff = new Backoff({
      baseMs: intervalMs,
      minMs: intervalMs,
      maxMs: Math.max(intervalMs, Math.min(intervalMs * 6, MAX_BACKOFF_MS)),
      random: options.random,
    })
  }

  start(): void {
    this.stopped = false
    void this.run()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async run(): Promise<void> {
    let delay = this.options.intervalMs
    try {
      await this.options.task()
      this.backoff.reset()
    } catch (error) {
      delay = error instanceof HomebridgeApiError && error.kind === 'unauthorized' ? AUTH_RETRY_MS : this.backoff.next()
      this.options.onError(error)
    }
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.run(), delay)
    }
  }
}
