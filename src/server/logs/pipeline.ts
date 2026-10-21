import type { LogLine } from '../../shared/types.ts'
import type { Logger } from '../logger.ts'
import type { LogStore, NewLogLine } from '../store/log-store.ts'

export interface PipelineOptions {
  store: LogStore
  logger: Logger
  onStored: (lines: LogLine[]) => void
  flushMs?: number
  maxPending?: number
  now?: () => number
}

/** While the store keeps failing, its error is logged this often, with the lines lost since. */
const FAILURE_LOG_MS = 60_000

/**
 * Collects new lines from every instance and writes them in one transaction
 * every `flushMs`. A burst such as a replay becomes a few writes, not hundreds.
 * `maxPending` limits a burst within one `flushMs`: lines past it are dropped.
 */
export class LogPipeline {
  private readonly options: PipelineOptions
  private readonly now: () => number
  private pending: NewLogLine[] = []
  private timer: NodeJS.Timeout | null = null
  private dropped = 0
  private failure: { lost: number, loggedAt: number } | null = null

  constructor(options: PipelineOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /** True while the last write to the store failed. */
  get isFailing(): boolean {
    return this.failure !== null
  }

  push(lines: readonly NewLogLine[]): void {
    const room = (this.options.maxPending ?? 20_000) - this.pending.length
    if (lines.length > room) {
      this.dropped += lines.length - Math.max(room, 0)
    }
    this.pending.push(...lines.slice(0, Math.max(room, 0)))
    this.timer ??= setTimeout(() => this.flush(), this.options.flushMs ?? 100)
  }

  /** Write what is pending now. Safe to call at any time. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.dropped > 0) {
      this.options.logger.warn('log lines dropped; more arrived at once than the pipeline holds', { dropped: this.dropped })
      this.dropped = 0
    }
    const batch = this.pending
    this.pending = []
    if (batch.length === 0) {
      return
    }
    let stored: LogLine[]
    try {
      stored = this.options.store.append(batch)
    } catch (error) {
      this.failed(error, batch.length)
      return
    }
    if (this.failure) {
      this.options.logger.info('log lines stored again', { lost: this.failure.lost })
      this.failure = null
    }
    this.options.onStored(stored)
  }

  private failed(error: unknown, lines: number): void {
    const now = this.now()
    if (!this.failure) {
      this.failure = { lost: 0, loggedAt: -Infinity }
    }
    this.failure.lost += lines
    if (now - this.failure.loggedAt >= FAILURE_LOG_MS) {
      this.options.logger.error('could not store log lines', { error, lost: this.failure.lost })
      this.failure.loggedAt = now
    }
  }
}
