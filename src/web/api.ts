import type { LogLine, LogPage, Overview } from '../shared/types.ts'
import { toParams, type Filters } from './filters.ts'

const PAGE_SIZE = 400
const TIMEOUT_MS = 15_000

/** GET JSON from the dashboard. A 401 means the session ended, so the browser goes to the login page. */
async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (response.status === 401) {
    window.location.assign('/login')
    throw new Error('signed out')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(body?.message ?? `${path} answered ${response.status}`)
  }
  return response.json() as Promise<T>
}

export function fetchOverview(): Promise<Overview> {
  return getJson('/api/overview')
}

export function fetchLogs(filters: Filters, beforeId?: number): Promise<LogPage> {
  const params = toParams(filters)
  params.set('limit', String(PAGE_SIZE))
  if (beforeId !== undefined) {
    params.set('before', String(beforeId))
  }
  return getJson(`/api/logs?${params.toString()}`)
}

/** End the session and go to the login page, even when the server cannot be reached. */
export async function signOut(): Promise<void> {
  try {
    await fetch('/api/logout', { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    // If the session is still valid, the login page sends the browser back to the dashboard.
  } finally {
    window.location.assign('/login')
  }
}

export type StreamStatus = 'live' | 'reconnecting'

export interface StreamHandlers {
  onLines(lines: LogLine[]): void
  onOverview(overview: Overview): void
  /** The browser fell too far behind; start over. */
  onReset(): void
  onStatus(status: StreamStatus): void
}

const RESTART_MS = 5000

/**
 * The live stream. EventSource reconnects by itself and sends Last-Event-ID,
 * so the server fills any gap. When the browser gives up (for example after a
 * restart that returned an error), this checks the session and opens a new one.
 */
export class LiveStream {
  private source: EventSource | null = null
  private lastId: number
  private readonly handlers: StreamHandlers
  private restartTimer = 0

  constructor(afterId: number, handlers: StreamHandlers) {
    this.lastId = afterId
    this.handlers = handlers
    this.open()
  }

  close(): void {
    window.clearTimeout(this.restartTimer)
    this.source?.close()
    this.source = null
  }

  private open(): void {
    const source = new EventSource(`/api/stream?after=${this.lastId}`)
    this.source = source
    source.addEventListener('open', () => this.handlers.onStatus('live'))
    source.addEventListener('logs', (event) => {
      const lines = JSON.parse((event as MessageEvent<string>).data) as LogLine[]
      this.lastId = lines.at(-1)?.id ?? this.lastId
      this.handlers.onLines(lines)
    })
    source.addEventListener('overview', (event) => {
      this.handlers.onOverview(JSON.parse((event as MessageEvent<string>).data) as Overview)
    })
    source.addEventListener('reset', () => this.handlers.onReset())
    source.addEventListener('error', () => {
      this.handlers.onStatus('reconnecting')
      if (source.readyState === EventSource.CLOSED) {
        this.restartTimer = window.setTimeout(() => void this.restart(), RESTART_MS)
      }
    })
  }

  private async restart(): Promise<void> {
    this.close()
    try {
      await fetchOverview()
    } catch {
      this.restartTimer = window.setTimeout(() => void this.restart(), RESTART_MS)
      return
    }
    this.open()
  }
}
