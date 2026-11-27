/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import type { LogLine, LogPage, Overview } from '../shared/types.ts'
import { toParams, type Filters } from './filters.ts'
import { readLogLines, readLogPage, readOverview } from './validate.ts'

const PAGE_SIZE = 400
const TIMEOUT_MS = 15_000

/** A request the server answered with an error. `status` tells a bad request (400) from a server that is struggling (5xx). */
export class ApiError extends Error {
  override name = 'ApiError'
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** The message of a thrown value, which need not be an Error. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** GET JSON from the dashboard and check its shape. A 401 means the session ended, so the browser goes to the login page. */
async function getJson<T>(path: string, read: (value: unknown) => T): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (response.status === 401) {
    window.location.assign('/login')
    throw new ApiError('signed out', 401)
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const message = typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string' ? body.message : null
    throw new ApiError(message ?? `${path} answered ${response.status}`, response.status)
  }
  return read(await response.json())
}

export function fetchOverview(): Promise<Overview> {
  return getJson('/api/overview', readOverview)
}

export function fetchLogs(filters: Filters, beforeId?: number): Promise<LogPage> {
  const params = toParams(filters)
  params.set('limit', String(PAGE_SIZE))
  if (beforeId !== undefined) {
    params.set('before', String(beforeId))
  }
  return getJson(`/api/logs?${params.toString()}`, readLogPage)
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
  /** An event that this page cannot read, such as one from a newer server. */
  onBadEvent(error: unknown): void
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
      const lines = this.read(event, readLogLines)
      if (lines) {
        this.lastId = lines.at(-1)?.id ?? this.lastId
        this.handlers.onLines(lines)
      } else {
        // Lines that cannot be read leave a gap, so the page starts over from a fresh page.
        this.handlers.onReset()
      }
    })
    source.addEventListener('overview', (event) => {
      const overview = this.read(event, readOverview)
      if (overview) {
        this.handlers.onOverview(overview)
      }
    })
    source.addEventListener('reset', () => this.handlers.onReset())
    source.addEventListener('error', () => {
      this.handlers.onStatus('reconnecting')
      if (source.readyState === EventSource.CLOSED) {
        this.restartTimer = window.setTimeout(() => void this.restart(), RESTART_MS)
      }
    })
  }

  /** An event's data read with `read`, or null after telling the handlers that it could not be read. */
  private read<T>(event: Event, read: (value: unknown) => T): T | null {
    try {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string') {
        throw new TypeError(`the ${event.type} event has no text`)
      }
      return read(JSON.parse(event.data))
    } catch (error) {
      this.handlers.onBadEvent(error)
      return null
    }
  }

  private async restart(): Promise<void> {
    this.close()
    try {
      await fetchOverview()
    } catch {
      // Not reachable yet, or signed out (then the page is already going to the login page). Try again later.
      this.restartTimer = window.setTimeout(() => void this.restart(), RESTART_MS)
      return
    }
    this.open()
  }
}
