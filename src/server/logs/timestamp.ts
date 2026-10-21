/**
 * Homebridge stamps each line with `new Date().toLocaleString()`, so the format
 * follows the host's locale and the time follows the host's time zone:
 * `10/21/2026, 8:05:09 PM` (en-US), `21/10/2026, 20:05:09` (en-GB),
 * `21.10.2026, 20:05:09` (de), `2026-10-21 20:05:09` (sv) and so on.
 */

export interface StampContext {
  /** Epoch ms that the line arrived. When the day and month could be either way round, the reading closer to this wins. */
  reference: number
  /** The IANA time zone of the Homebridge host, or null to read times in Keystone's own zone. */
  timeZone: string | null
}

export interface Stamp {
  /** Characters of the `[...] ` prefix. */
  length: number
  ts: number
}

const NUMERIC = /^\[(\d{1,4})[./-] ?(\d{1,2})[./-] ?(\d{1,4})\.?,? (\d{1,2}):(\d{2}):(\d{2})(?:[\s\u202f]?([AaPp])\.?[Mm]\.?)?\] /
const OTHER = /^\[([^\]]{8,40})\] /

interface Fields {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** The timestamp at the start of a plain line, or null when there is none or it is not a real time. */
export function readStamp(plain: string, context: StampContext): Stamp | null {
  const numeric = NUMERIC.exec(plain)
  if (numeric) {
    const ts = readNumeric(numeric, context)
    return ts === null ? null : { length: numeric[0].length, ts }
  }
  const other = OTHER.exec(plain)
  if (other?.[1] && /\d/.test(other[1])) {
    const ts = Date.parse(other[1])
    return Number.isNaN(ts) ? null : { length: other[0].length, ts }
  }
  return null
}

function readNumeric(match: RegExpExecArray, context: StampContext): number | null {
  const [, first = '', second = '', third = '', hourText = '', minuteText = '', secondText = '', meridiem] = match
  const hour = toHour(Number(hourText), meridiem)
  const minute = Number(minuteText)
  const seconds = Number(secondText)
  if (hour === null || minute > 59 || seconds > 59) {
    return null
  }
  const dates = first.length === 4
    ? [[first, second, third]]
    : third.length === 4 ? [[third, first, second], [third, second, first]] : []
  let best: number | null = null
  for (const [year, month, day] of dates) {
    const ts = toEpoch({ year: Number(year), month: Number(month), day: Number(day), hour, minute, second: seconds }, context.timeZone)
    if (ts !== null && (best === null || Math.abs(ts - context.reference) < Math.abs(best - context.reference))) {
      best = ts
    }
  }
  return best
}

function toHour(hour: number, meridiem: string | undefined): number | null {
  if (!meridiem) {
    return hour <= 23 ? hour : null
  }
  if (hour < 1 || hour > 12) {
    return null
  }
  return (hour % 12) + (meridiem.toUpperCase() === 'P' ? 12 : 0)
}

/** Epoch ms of a wall-clock time in `timeZone`, or null when the date does not exist. */
function toEpoch(fields: Fields, timeZone: string | null): number | null {
  const { year, month, day, hour, minute, second } = fields
  const wall = Date.UTC(year, month - 1, day, hour, minute, second)
  const check = new Date(wall)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null
  }
  if (timeZone === null) {
    return new Date(year, month - 1, day, hour, minute, second).getTime()
  }
  // The offset depends on the instant, so correct once more for a DST change in between.
  const guess = wall - zoneOffset(wall, timeZone)
  return wall - zoneOffset(guess, timeZone)
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** How far `timeZone` is ahead of UTC at `epoch`, in ms. */
function zoneOffset(epoch: number, timeZone: string): number {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    })
    formatters.set(timeZone, formatter)
  }
  const parts: Record<string, number> = {}
  for (const part of formatter.formatToParts(epoch)) {
    parts[part.type] = Number(part.value)
  }
  const asUtc = Date.UTC(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day ?? 1, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0)
  return asUtc - Math.floor(epoch / 1000) * 1000
}

/** The zone name when this runtime knows it, else null. */
export function knownTimeZone(value: string | null): string | null {
  if (!value) {
    return null
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return value
  } catch {
    return null
  }
}
