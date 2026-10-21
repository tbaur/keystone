import type { ServerResponse } from 'node:http'

import type { LogLine, Overview } from '../../shared/types.ts'
import type { Logger } from '../logger.ts'
import type { LogStore } from '../store/log-store.ts'

export interface HubOptions {
  store: LogStore
  logger: Logger
  overview: () => Overview
  heartbeatMs?: number
  overviewDebounceMs?: number
}

/** A client that reconnects further behind than this reloads instead of replaying. */
const MAX_RESUME = 5000
const RESUME_CHUNK = 500
/** A client whose unsent data passes this is too slow; it is dropped and reconnects. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024
const RETRY_MS = 3000

/** False once the session that opened the stream has ended: signed out, expired, or the user was removed. */
export type StillAllowed = () => boolean

/**
 * Sends live data to browsers as server-sent events:
 * `logs` (a batch of new lines, with the last id as the event id),
 * `overview` (the whole overview, after it changes) and
 * `reset` (the client fell too far behind and should reload).
 * A browser that reconnects sends Last-Event-ID and gets the lines it missed.
 * Every heartbeat checks each stream's session again and ends the stream when
 * the session has ended, so the browser reconnects and is sent to sign in.
 */
export class StreamHub {
  private readonly options: HubOptions
  private readonly clients = new Map<ServerResponse, StillAllowed>()
  private readonly heartbeat: NodeJS.Timeout
  private overviewTimer: NodeJS.Timeout | null = null

  constructor(options: HubOptions) {
    this.options = options
    this.heartbeat = setInterval(() => {
      this.closeEndedSessions()
      this.broadcast(': keep-alive\n\n')
    }, options.heartbeatMs ?? 25_000)
  }

  /** Start a stream. `afterId` is the last line the client has. */
  open(res: ServerResponse, afterId: number | null, isAllowed: StillAllowed): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    })
    res.write(`retry: ${RETRY_MS}\n\n`)
    res.write(event('overview', this.options.overview()))
    if (afterId !== null) {
      this.resume(res, afterId)
    }
    this.clients.set(res, isAllowed)
    res.on('close', () => this.clients.delete(res))
  }

  publishLines(lines: readonly LogLine[]): void {
    const last = lines.at(-1)
    if (last) {
      this.broadcast(event('logs', lines, last.id))
    }
  }

  /** Overviews change in bursts (one per instance poll), so they go out at most once per debounce. */
  overviewChanged(): void {
    this.overviewTimer ??= setTimeout(() => {
      this.overviewTimer = null
      if (this.clients.size === 0) {
        return
      }
      try {
        this.broadcast(event('overview', this.options.overview()))
      } catch (error) {
        this.options.logger.error('could not send the overview', { error })
      }
    }, this.options.overviewDebounceMs ?? 500)
  }

  /** End every stream whose session has ended. Call after a sign-out. */
  closeEndedSessions(): void {
    for (const [client, isAllowed] of this.clients) {
      let allowed: boolean
      try {
        allowed = isAllowed()
      } catch (error) {
        this.options.logger.error('could not check a stream session', { error })
        continue
      }
      if (!allowed) {
        client.end()
        this.clients.delete(client)
      }
    }
  }

  close(): void {
    clearInterval(this.heartbeat)
    if (this.overviewTimer) {
      clearTimeout(this.overviewTimer)
    }
    for (const client of this.clients.keys()) {
      client.end()
    }
    this.clients.clear()
  }

  private resume(res: ServerResponse, afterId: number): void {
    const missed = this.options.store.after(afterId, MAX_RESUME + 1)
    if (missed.length > MAX_RESUME) {
      res.write(event('reset', { reason: 'too far behind' }))
      return
    }
    for (let start = 0; start < missed.length; start += RESUME_CHUNK) {
      const chunk = missed.slice(start, start + RESUME_CHUNK)
      res.write(event('logs', chunk, chunk.at(-1)?.id))
    }
  }

  private broadcast(message: string): void {
    for (const client of this.clients.keys()) {
      if (client.writableLength > MAX_BUFFERED_BYTES) {
        this.options.logger.warn('dropping a stream client that is not reading', { buffered: client.writableLength })
        client.destroy()
        this.clients.delete(client)
        continue
      }
      client.write(message)
    }
  }
}

function event(name: string, data: unknown, id?: number): string {
  const idLine = id === undefined ? '' : `id: ${id}\n`
  return `${idLine}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}
