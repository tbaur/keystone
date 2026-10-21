import type { LogLevel } from '../../shared/types.ts'
import { readStamp, type StampContext } from './timestamp.ts'

export interface ParsedLine {
  /** The line as Homebridge wrote it, ANSI codes included. */
  raw: string
  /** The line without ANSI codes. */
  plain: string
  /** Epoch ms from Homebridge's timestamp, or null when the line has none. */
  ts: number | null
  plugin: string | null
  level: LogLevel
  /** Where the message starts in `raw`, after the timestamp and plugin prefix. */
  messageOffset: number
}

export interface LineContext {
  plugin: string | null
  level: LogLevel
}

// CSI sequences (colours, cursor moves), OSC sequences (titles, links) and two-byte escapes.
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
// eslint-disable-next-line no-control-regex
const SGR = /^\x1b\[([0-9;]*)m$/
// eslint-disable-next-line no-control-regex
const CUT_ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*)?$/
const PLUGIN = /^\[([^\]]{1,80})\] ?/
export const MAX_LINE = 64 * 1024
export const TRUNCATED = ' … (truncated)'

const ERROR_CODES = new Set([31, 91])
const WARN_CODES = new Set([33, 93])
const DEBUG_CODES = new Set([2, 90])

/**
 * Splits a terminal stream into lines. Homebridge UI sends `\n\r` line breaks
 * and may cut a chunk anywhere, so a partial line waits for the next chunk. A
 * line longer than MAX_LINE is cut there and the rest of it is dropped, so it
 * never turns into extra lines.
 */
export class LineSplitter {
  private carry = ''
  private dropping = false

  push(chunk: string): string[] {
    const pieces = chunk.replaceAll('\r', '').split('\n')
    const lines: string[] = []
    pieces.forEach((piece, index) => {
      if (!this.dropping) {
        this.carry += piece
        if (this.carry.length > MAX_LINE) {
          lines.push(this.carry.slice(0, MAX_LINE).replace(CUT_ESCAPE, '') + TRUNCATED)
          this.carry = ''
          this.dropping = true
        }
      }
      if (index < pieces.length - 1) {
        if (!this.dropping) {
          lines.push(this.carry)
        }
        this.carry = ''
        this.dropping = false
      }
    })
    return lines
  }
}

/**
 * Parse a Homebridge log line: `[time] [Plugin] message`. Homebridge colours the
 * message by level (red error, yellow warning, grey debug), so the level comes
 * from that colour. A line with no timestamp continues the line before it, such
 * as a stack trace, so it takes that line's plugin and level from `previous`.
 */
export function parseLine(raw: string, previous: LineContext | null, stamp: StampContext): ParsedLine {
  const { plain, rawEnd } = stripAnsi(raw)
  const time = readStamp(plain, stamp)
  if (!time) {
    return { raw, plain, ts: null, plugin: previous?.plugin ?? null, level: previous?.level ?? 'info', messageOffset: 0 }
  }
  let prefixLength = time.length
  const plugin = PLUGIN.exec(plain.slice(prefixLength))
  if (plugin) {
    prefixLength += plugin[0].length
  }
  const messageOffset = prefixLength > 0 ? rawEnd(prefixLength - 1) : 0
  return {
    raw,
    plain,
    ts: time.ts,
    plugin: plugin?.[1] ?? null,
    level: levelAt(raw, messageOffset),
    messageOffset,
  }
}

export function stripAnsiText(raw: string): string {
  return raw.replace(ESCAPES, '')
}

/** The plain text, and a way to find where a plain character ends in the raw text. */
function stripAnsi(raw: string): { plain: string, rawEnd: (plainIndex: number) => number } {
  const starts: Array<{ plain: number, raw: number }> = []
  let plain = ''
  let cursor = 0
  for (const match of raw.matchAll(ESCAPES)) {
    if (match.index > cursor) {
      starts.push({ plain: plain.length, raw: cursor })
      plain += raw.slice(cursor, match.index)
    }
    cursor = match.index + match[0].length
  }
  if (cursor < raw.length) {
    starts.push({ plain: plain.length, raw: cursor })
    plain += raw.slice(cursor)
  }
  const rawEnd = (plainIndex: number): number => {
    let segment = starts[0] ?? { plain: 0, raw: 0 }
    for (const start of starts) {
      if (start.plain > plainIndex) {
        break
      }
      segment = start
    }
    return segment.raw + (plainIndex - segment.plain) + 1
  }
  return { plain, rawEnd }
}

/** The level from the colour codes that come just before the first visible character of the message. */
function levelAt(raw: string, offset: number): LogLevel {
  let level: LogLevel = 'info'
  let cursor = 0
  const message = raw.slice(offset)
  for (const match of message.matchAll(ESCAPES)) {
    if (match.index !== cursor) {
      break
    }
    cursor += match[0].length
    const codes = (SGR.exec(match[0])?.[1] ?? '').split(';').map(Number)
    level = codes.reduce(levelAfterCode, level)
  }
  return level
}

function levelAfterCode(level: LogLevel, code: number): LogLevel {
  if (ERROR_CODES.has(code)) {
    return 'error'
  }
  if (WARN_CODES.has(code)) {
    return 'warn'
  }
  if (DEBUG_CODES.has(code)) {
    return 'debug'
  }
  return code === 0 || code === 39 ? 'info' : level
}
