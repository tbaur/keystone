import { io, type Socket } from 'socket.io-client'

import type { ConnectionState } from '../../shared/types.ts'
import { asRecord, asString } from '../json.ts'
import type { Logger } from '../logger.ts'
import { LineSplitter, parseLine, stripAnsiText, type LineContext } from '../logs/line-parser.ts'
import { isUiBanner, replayStart } from '../logs/replay.ts'
import { knownTimeZone, type StampContext } from '../logs/timestamp.ts'
import type { NewLogLine } from '../store/log-store.ts'
import { AUTH_RETRY_MS, HomebridgeApiError, type HomebridgeApi } from './api-client.ts'
import { Backoff } from './backoff.ts'

export interface LogStreamOptions {
  instance: string
  api: HomebridgeApi
  logger: Logger
  /** The newest stored Homebridge lines of this instance as plain text, oldest first. */
  recentLines: () => string[]
  onLines: (lines: NewLogLine[]) => void
  onState: (state: ConnectionState, error: string | null) => void
  timing?: Partial<StreamTiming>
  /** For the reconnect backoff jitter. */
  random?: () => number
}

export interface StreamTiming {
  /** The replay is over once the stream is quiet this long. */
  replayQuietMs: number
  /** Or once this long has passed, however busy the log is. */
  replayMaxMs: number
  /** How long the socket may take to connect, and then to send its first data. */
  connectTimeoutMs: number
}

const DEFAULT_TIMING: StreamTiming = { replayQuietMs: 1000, replayMaxMs: 10_000, connectTimeoutMs: 10_000 }
const TERMINAL_SIZE = { cols: 200, rows: 50 }
/** A live line stamped further from its arrival than this has a time that cannot be right, so it gets the arrival time. */
const MAX_LIVE_SKEW_MS = 36 * 60 * 60_000
/** No line, live or replayed, can be written later than it arrives, beyond a little clock drift. */
const MAX_FUTURE_MS = 15 * 60_000

/**
 * Follows one instance's log over Homebridge UI's `log` socket. Reconnects
 * with backoff on its own loop, so each attempt can bring a fresh token.
 */
export class LogStream {
  private readonly options: LogStreamOptions
  private readonly timing: StreamTiming
  private readonly backoff: Backoff
  private socket: Socket | null = null
  private token: string | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private silenceTimer: NodeJS.Timeout | null = null
  private replay: ReplayBuffer | null = null
  private splitter = new LineSplitter()
  private context: (LineContext & { ts: number }) | null = null
  /** The Homebridge host's time zone, which its log times are written in. */
  private timeZone: string | null = null
  private wasConnected = false
  /** Times in a row that Homebridge UI closed the socket before sending anything. */
  private refusals = 0
  /** Set after a lost stream, so the next replay ends with a "reconnected" line. */
  private isRecovering = false
  private stopped = false

  constructor(options: LogStreamOptions) {
    this.options = options
    this.timing = { ...DEFAULT_TIMING, ...options.timing }
    this.backoff = new Backoff({ random: options.random })
  }

  start(): void {
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
    }
    this.replay?.cancel()
    this.closeSocket()
  }

  private async connect(): Promise<void> {
    this.options.onState('connecting', null)
    let token: string
    try {
      token = await this.options.api.accessToken()
      await this.readTimeZone()
    } catch (error) {
      this.fail(error)
      return
    }
    if (this.stopped) {
      return
    }
    const socket = io(`${this.options.api.baseUrl}/log`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      timeout: this.timing.connectTimeoutMs,
    })
    this.socket = socket
    this.token = token
    socket.on('connect', () => this.onConnect(socket))
    socket.on('stdout', (data: unknown) => {
      if (typeof data === 'string') {
        this.onData(data)
      }
    })
    socket.on('connect_error', (error) => this.onDisconnect(socket, `connection failed: ${error.message}`))
    socket.on('disconnect', (reason) => this.onDisconnect(socket, reason))
  }

  /** Homebridge stamps its log in its own time zone, which Homebridge UI reports with the uptime. */
  private async readTimeZone(): Promise<void> {
    try {
      const uptime = asRecord(await this.options.api.get('/status/uptime'))
      const zone = knownTimeZone(asString(asRecord(uptime?.time)?.timezoneName))
      if (zone !== this.timeZone) {
        this.options.logger.info('reading log times in the Homebridge host time zone', { timeZone: zone ?? 'same as Keystone' })
        this.timeZone = zone
      }
    } catch (error) {
      if (error instanceof HomebridgeApiError && error.kind === 'unauthorized') {
        throw error
      }
      this.options.logger.debug('could not read the Homebridge host time zone', { error })
    }
  }

  private onConnect(socket: Socket): void {
    this.splitter = new LineSplitter()
    this.context = null
    this.replay = new ReplayBuffer(this.timing, () => this.endReplay())
    // Homebridge UI always starts with a banner, so a socket that stays silent is stuck.
    this.silenceTimer = setTimeout(() => {
      if (!this.wasConnected) {
        this.onDisconnect(socket, 'no log data')
      }
    }, this.timing.connectTimeoutMs)
    socket.emit('tail-log', TERMINAL_SIZE)
  }

  /** Homebridge UI accepts the token only when the first data arrives, so that is when the stream counts as connected. */
  private markConnected(): void {
    if (this.wasConnected) {
      return
    }
    this.wasConnected = true
    this.refusals = 0
    this.backoff.reset()
    this.clearSilenceTimer()
    this.options.onState('connected', null)
    this.options.logger.info('log stream connected')
  }

  private onData(data: string): void {
    this.markConnected()
    const lines = this.splitter.push(data).filter((line) => stripAnsiText(line).trim() !== '')
    if (this.replay) {
      this.replay.add(lines)
      return
    }
    this.emit(lines, { receivedAt: Date.now(), isLive: true })
  }

  private endReplay(): void {
    const buffered = this.replay?.lines ?? []
    this.replay = null
    try {
      this.storeReplay(buffered)
    } catch (error) {
      // Without the stored lines there is no telling which replayed lines are new, so none are stored.
      this.options.logger.error('log replay failed', { error, lines: buffered.length })
    }
    if (this.isRecovering) {
      this.isRecovering = false
      this.emitSystem('Log stream reconnected', 'info')
    }
  }

  private storeReplay(buffered: readonly string[]): void {
    if (buffered.length === 0) {
      return
    }
    const stored = this.options.recentLines()
    let start = replayStart(stored, buffered.map(stripAnsiText))
    if (start === 0) {
      start = this.firstTimestamped(buffered)
      if (stored.length > 0) {
        this.options.logger.info('log replay did not overlap the stored lines', { lines: buffered.length - start })
      }
    }
    this.emit(buffered.slice(start), { receivedAt: Date.now(), isLive: false })
  }

  private onDisconnect(socket: Socket, reason: string): void {
    if (socket !== this.socket || this.stopped) {
      return
    }
    const token = this.token
    this.closeSocket()
    this.replay?.cancel()
    this.replay = null
    const isRefused = reason === 'io server disconnect' && !this.wasConnected
    if (reason === 'io server disconnect' && token) {
      // Homebridge UI drops the socket when it rejects the token.
      this.options.api.invalidate(token)
    }
    if (this.wasConnected) {
      this.wasConnected = false
      this.isRecovering = true
      this.emitSystem(`Log stream lost (${reason}); reconnecting`, 'warn')
    }
    // One refusal is usually an expired token, and the retry brings a new one.
    // A second in a row means this user may not read the log.
    this.refusals = isRefused ? this.refusals + 1 : 0
    this.fail(this.refusals > 1
      ? new HomebridgeApiError('unauthorized', 'Homebridge UI refused the log; is restrictLogsToAdmins on?')
      : new HomebridgeApiError('unreachable', reason))
  }

  private fail(error: unknown): void {
    const isAuth = error instanceof HomebridgeApiError && error.kind === 'unauthorized'
    const message = error instanceof HomebridgeApiError ? error.message : 'unexpected error'
    this.options.onState(isAuth ? 'unauthorized' : 'unreachable', message)
    const delay = isAuth ? AUTH_RETRY_MS : this.backoff.next()
    this.options.logger.warn('log stream unavailable', { error, retryInMs: delay })
    if (!this.stopped) {
      this.retryTimer = setTimeout(() => void this.connect(), delay)
    }
  }

  private emit(rawLines: readonly string[], arrival: { receivedAt: number, isLive: boolean }): void {
    const { receivedAt, isLive } = arrival
    const stamp: StampContext = { reference: receivedAt, timeZone: this.timeZone }
    const lines: NewLogLine[] = []
    for (const raw of rawLines) {
      const { plugin, level, messageOffset, ts: stamped } = parseLine(raw, this.context, stamp)
      const ts = stamped === null ? this.context?.ts ?? receivedAt : plausible(stamped, receivedAt, isLive)
      this.context = { plugin, level, ts }
      lines.push({ instance: this.options.instance, ts, receivedAt, plugin, level, system: false, raw, messageOffset })
    }
    if (lines.length > 0) {
      this.options.onLines(lines)
    }
  }

  private emitSystem(text: string, level: 'info' | 'warn'): void {
    const now = Date.now()
    this.options.onLines([{
      instance: this.options.instance, ts: now, receivedAt: now, plugin: null, level,
      system: true, raw: text, messageOffset: 0,
    }])
  }

  /** Skip lines before the first timestamp: the replay can start partway through a line or a stack trace. */
  private firstTimestamped(lines: readonly string[]): number {
    const stamp: StampContext = { reference: Date.now(), timeZone: this.timeZone }
    const index = lines.findIndex((line) => parseLine(line, null, stamp).ts !== null)
    return index < 0 ? 0 : index
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    this.token = null
    this.clearSilenceTimer()
    socket?.removeAllListeners()
    socket?.disconnect()
  }
}

/** The stamped time, unless it is impossible for a line that arrived at `receivedAt`. */
function plausible(ts: number, receivedAt: number, isLive: boolean): number {
  if (ts > receivedAt + MAX_FUTURE_MS || (isLive && ts < receivedAt - MAX_LIVE_SKEW_MS)) {
    return receivedAt
  }
  return ts
}

/**
 * Holds the replayed lines until the stream goes quiet. Drops the UI's banner
 * lines before the log starts. Homebridge UI can take a while between its
 * banner and the file, so the quiet wait starts with the first log line, and
 * the overall limit with the first data.
 */
class ReplayBuffer {
  readonly lines: string[] = []
  private readonly timing: StreamTiming
  private readonly done: () => void
  private quietTimer: NodeJS.Timeout | null = null
  private maxTimer: NodeJS.Timeout | null = null
  private finished = false

  constructor(timing: StreamTiming, done: () => void) {
    this.timing = timing
    this.done = done
  }

  add(lines: readonly string[]): void {
    this.maxTimer ??= setTimeout(() => this.finish(), this.timing.replayMaxMs)
    for (const line of lines) {
      if (this.lines.length > 0 || !isUiBanner(stripAnsiText(line))) {
        this.lines.push(line)
      }
    }
    if (this.lines.length > 0) {
      clearTimeout(this.quietTimer ?? undefined)
      this.quietTimer = setTimeout(() => this.finish(), this.timing.replayQuietMs)
    }
  }

  cancel(): void {
    clearTimeout(this.quietTimer ?? undefined)
    clearTimeout(this.maxTimer ?? undefined)
  }

  private finish(): void {
    if (this.finished) {
      return
    }
    this.finished = true
    this.cancel()
    this.done()
  }
}
