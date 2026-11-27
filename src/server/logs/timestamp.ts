/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Homebridge stamps each line with `new Date().toLocaleString()`, so the format
 * follows the host's locale and the time follows the host's time zone:
 * `10/21/2026, 8:05:09 PM` (en-US), `21.10.2026, 20:05:09` (de),
 * `21.10.2026 klo 20.05.09` (fi), `2026/10/21 오후 8:05:09` (ko) and so on.
 * Node knows thousands of locales but only a few dozen shapes of this stamp:
 * a date of three numbers with the year first or last, a time of hour, minute
 * and second, and sometimes a word for the half of the day or other short
 * words around them. Some locales write other digits, such as Arabic-Indic,
 * and some count years in the Buddhist (th) or Persian (fa, ps) calendar.
 * Plugins that write their own lines may use ISO 8601 instead, or JavaScript's
 * `toUTCString()` and `toString()`, sometimes with a zone or an offset.
 */

/** The order of year, month and day in a date. */
export type DateOrder = 'ymd' | 'ydm' | 'mdy' | 'dmy'

export interface StampContext {
  /** Epoch ms that the line arrived. When a reading is ambiguous and no order is known, the one closer to this wins. */
  reference: number
  /** The IANA time zone of the Homebridge host, or null to read times in Keystone's own zone. */
  timeZone: string | null
  /** The date order that an earlier line of the same log proved, used when a date reads both ways. */
  order?: DateOrder | null
}

export interface Stamp {
  /** Characters of the `[...] ` prefix. */
  length: number
  /** Epoch ms, or null when the prefix is a timestamp but its date cannot be placed, such as a year in no known calendar. */
  ts: number | null
  /** The date order, when this stamp could only be read one way. Pass it back in the context for the next lines. */
  order: DateOrder | null
}

const BRACKETED = /^\[([^\]]{6,80})\] /
const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/
/** The zone name that `toString()` adds in brackets, such as `(Central European Summer Time)`. It has no digits, unlike eu's `(20:05:09)`. */
const ZONE_NAME = /\s+\([^)\d]+\)$/u
/** A zone at the end: `GMT`, `UTC` or `Z`, maybe with an offset, or an offset alone such as `+0200` or `-06:00`. */
const ZONE = /\s+(?:(?:GMT|UTC|Z)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?|([+-])(\d{2}):?(\d{2}))$/
/** `Wed, 21 Oct 2026 18:05:09` from `toUTCString()`, the zone already taken off. */
const DAY_MONTH_YEAR = /^(?:[A-Z][a-z]{2},? )?(\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2})$/
/** `Wed Oct 21 2026 20:05:09` from `toString()`, the zone already taken off. */
const MONTH_DAY_YEAR = /^(?:[A-Z][a-z]{2} )?([A-Z][a-z]{2}) (\d{1,2}) (\d{4}) (\d{2}):(\d{2}):(\d{2})$/
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const NUMBER = /\d+/g
/** Between the parts of a date: `.`, `/`, `-`, a space, CJK date characters, or two punctuation marks at most. */
const DATE_SEPARATOR = /^(?:[\p{P}\p{S}]{0,2}|[年月])$/u
/** Between hour, minute and second: `:` or `.`, a space, or `h` and `min` as in fr-CA and oc. */
const TIME_SEPARATOR = /^(?:[:.]?|h|min)$/
/** Words around the date and time, such as `klo`, `г.,` or a day-period word, are short. */
const MAX_WORDS = 24
/** A year further than this from when the line arrived is in another calendar. */
const MAX_YEARS_OFF = 5
const DAY_MS = 24 * 60 * 60 * 1000
/** How far back a date in another calendar is looked for. */
const CALENDAR_SEARCH_DAYS = 400
const OTHER_CALENDARS = ['buddhist', 'persian'] as const

/**
 * The words for the second half of the day, and the first, in every locale
 * that Node's ICU writes with a 12-hour clock, in the form that `wordForm`
 * gives: lowercased and without dots, so `p.m.` is `pm`. A word only counts
 * on its own, not inside another word, so the zone `MDT` is not `md` (pm in
 * sq). Longer words are checked first, so `anw` wins over `an`.
 */
const PM_WORDS = byLength([
  'pm', 'anw', 'ከሰዓት', 'م', 'অপৰাহ্ন', 'ཕྱི་ཆ་', 'ɣetrɔ', 'μμ', '오후', 'ptg', 'wb', 'شام', 'gd', 'md', 'ድቀ', 'ea', 'बेलासे', 'ᏒᎯᏱᎢ',
  'دن', '܏ܒܛ', 'ᐲᒼ', 'स’ञ', 'n tmeddit', 'सांझ', 'ǃuias', 'tŋ', 'दपेहरा/संजा', '下晝', 'ཕྱི་དྲོ་', 'अपराह्न', 'غو', '下午', '午後',
])
const AM_WORDS = byLength([
  'am', 'an', 'ጥዋት', 'ص', 'পূৰ্বাহ্ন', 'སྔ་ཆ་', 'ŋdi', 'πμ', '오전', 'pg', 'wd', 'صبح', 'gh', 'pd', 'ቅቀ', 'hh', 'फुं', 'ᏌᎾᎴ',
  'بن', '܏ܩܛ', 'ᐊᒼ', 'सवेर', 'n tufat', 'भोर', 'নুমাং', 'ǁgoagas', 'rw', 'भ्यागा', '上晝', 'སྔ་དྲོ་', 'पूर्वाह्न', 'غم', '上午', '午前',
])
/** A letter or a mark that belongs to one, which may not touch a day-period word. */
const LETTER = /[\p{L}\p{M}]/u

interface Fields {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  millisecond?: number
}

/** The timestamp at the start of a plain line, or null when there is none or it is not a real time. */
export function readStamp(plain: string, context: StampContext): Stamp | null {
  const bracketed = BRACKETED.exec(plain)
  const text = bracketed?.[1]
  if (!bracketed || text === undefined) {
    return null
  }
  const iso = readIso(text, context)
  if (iso !== undefined) {
    return { length: bracketed[0].length, ts: iso, order: null }
  }
  const { rest, offset } = splitZone(text.replace(ZONE_NAME, ''))
  const english = readEnglish(rest, context, offset)
  if (english !== undefined) {
    return { length: bracketed[0].length, ts: english, order: null }
  }
  const local = readLocale(rest, context, offset)
  return local === undefined ? null : { length: bracketed[0].length, ...local }
}

/** The text without a zone at its end, and that zone's offset in ms ahead of UTC, or null when it names none. */
function splitZone(text: string): { rest: string, offset: number | null } {
  const match = ZONE.exec(text)
  if (!match) {
    return { rest: text, offset: null }
  }
  const [, sign, hours, minutes, bareSign, bareHours, bareMinutes] = match
  const direction = (sign ?? bareSign) === '-' ? -1 : 1
  const offset = direction * (Number(hours ?? bareHours ?? '0') * 60 + Number(minutes ?? bareMinutes ?? '0')) * 60_000
  return { rest: text.slice(0, match.index), offset }
}

/** A `toUTCString()` or `toString()` time with an English month name. Undefined when the text is not one. */
function readEnglish(text: string, context: StampContext, offset: number | null): number | null | undefined {
  const dayFirst = DAY_MONTH_YEAR.exec(text)
  const monthFirst = dayFirst ? null : MONTH_DAY_YEAR.exec(text)
  const match = dayFirst ?? monthFirst
  if (!match) {
    return undefined
  }
  const [, first = '', second = '', year = '', hour = '', minute = '', secondText = ''] = match
  const [dayText, monthName] = dayFirst ? [first, second] : [second, first]
  const month = MONTHS.indexOf(monthName.toLowerCase()) + 1
  const fields: Fields = { year: Number(year), month, day: Number(dayText), hour: Number(hour), minute: Number(minute), second: Number(secondText) }
  if (month === 0 || fields.hour > 23 || fields.minute > 59 || fields.second > 59) {
    return undefined
  }
  const ts = atOffset(fields, context, offset)
  return ts ?? undefined
}

/** Epoch ms of a wall time at a known offset, or in the host's zone when the offset is null. Null when the date does not exist. */
function atOffset(fields: Fields, context: StampContext, offset: number | null): number | null {
  if (offset === null) {
    return toEpoch(fields, context)
  }
  const wall = utcWall(fields)
  return wall === null ? null : wall - offset
}

/** An ISO 8601 time, read in the host's zone when it has no offset. Undefined when the text is not one. */
function readIso(text: string, context: StampContext): number | null | undefined {
  const match = ISO.exec(text)
  if (!match) {
    return undefined
  }
  const [, year = '', month = '', day = '', hour = '', minute = '', second = '', fraction = '', offset] = match
  const fields: Fields = {
    year: Number(year), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute), second: Number(second),
    millisecond: Number(fraction.padEnd(3, '0').slice(0, 3)),
  }
  if (fields.hour > 23 || fields.minute > 59 || fields.second > 59) {
    return undefined
  }
  if (offset === undefined) {
    return toEpoch(fields, context) ?? undefined
  }
  const wall = utcWall(fields)
  return wall === null ? undefined : wall - offsetMs(offset)
}

/**
 * A `toLocaleString()` stamp: six numbers, three for the date with a
 * four-digit year first or last and three for the time, in either order,
 * with short words around them. Undefined when the text is not one, or the
 * date or time does not exist.
 */
function readLocale(text: string, context: StampContext, offset: number | null): { ts: number | null, order: DateOrder | null } | undefined {
  const normal = normalize(text)
  const numbers = [...normal.matchAll(NUMBER)]
  if (numbers.length !== 6) {
    return undefined
  }
  const gaps = numbers.map((match, index) => normal.slice(index === 0 ? 0 : end(numbers[index - 1]), match.index))
  gaps.push(normal.slice(end(numbers[5])))
  const words = gaps.join(' ')
  if (words.replace(/\s/g, '').length > MAX_WORDS) {
    return undefined
  }
  const values = numbers.map((match) => match[0])
  const meridiem = dayPeriod(words)
  const readings: Array<{ order: DateOrder, ts: number | null }> = []
  for (const dateFirst of [true, false]) {
    const date = dateFirst ? values.slice(0, 3) : values.slice(3)
    const time = dateFirst ? values.slice(3) : values.slice(0, 3)
    const dateGaps = dateFirst ? gaps.slice(1, 3) : gaps.slice(4, 6)
    const timeGaps = dateFirst ? gaps.slice(4, 6) : gaps.slice(1, 3)
    if (!dateGaps.every((gap) => DATE_SEPARATOR.test(gap.trim())) || !timeGaps.every((gap) => TIME_SEPARATOR.test(gap.trim()))) {
      continue
    }
    const clock = readClock(time, meridiem)
    if (!clock) {
      continue
    }
    for (const { order, ...day } of dateReadings(date)) {
      const placed = placeDate(day, context)
      if (placed !== undefined) {
        readings.push({ order, ts: placed === null ? null : atOffset({ ...placed, ...clock }, context, offset) })
      }
    }
  }
  const [only] = readings
  if (!only) {
    return undefined
  }
  if (readings.length === 1) {
    return { ts: only.ts, order: only.order }
  }
  return { ts: pickReading(readings, context), order: null }
}

/**
 * The time of a date that reads two ways: in the order the log has shown
 * before, else year-month-day over year-day-month, else the reading closer to
 * when the line arrived.
 */
function pickReading(readings: ReadonlyArray<{ order: DateOrder, ts: number | null }>, context: StampContext): number | null {
  const known = readings.find((reading) => reading.order === context.order)
  if (known) {
    return known.ts
  }
  const yearFirst = readings.find((reading) => reading.order === 'ymd')
  if (yearFirst) {
    return yearFirst.ts
  }
  let best: number | null = null
  for (const { ts } of readings) {
    if (ts !== null && (best === null || Math.abs(ts - context.reference) < Math.abs(best - context.reference))) {
      best = ts
    }
  }
  return best
}

/** ASCII digits for the digits of any other script, spaces for the narrow and no-break spaces, and no direction marks. */
function normalize(text: string): string {
  return text
    .replace(/[^\P{Nd}0-9]/gu, (digit) => String(digitValue(digit)))
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/\p{Cf}/gu, '')
}

/** The value of a decimal digit. Unicode puts each script's digits 0 to 9 in a row. */
function digitValue(digit: string): number {
  let code = digit.codePointAt(0) ?? 48
  let value = 0
  while (value < 9 && /\p{Nd}/u.test(String.fromCodePoint(code - 1))) {
    code -= 1
    value += 1
  }
  return value
}

function end(match: RegExpExecArray | RegExpMatchArray | undefined): number {
  return match?.index === undefined ? 0 : match.index + match[0].length
}

/** 'pm', 'am', or null when the words name no half of the day. The longest word found wins, so `غ.م` (am) beats the `م` (pm) inside it. */
function dayPeriod(words: string): 'pm' | 'am' | null {
  const text = wordForm(words)
  const pm = PM_WORDS.find((word) => standsAlone(text, word))
  const am = AM_WORDS.find((word) => standsAlone(text, word))
  if (pm === undefined || am === undefined) {
    return pm !== undefined ? 'pm' : am !== undefined ? 'am' : null
  }
  return am.length > pm.length ? 'am' : 'pm'
}

/** True when `word` appears in `text` with no letter right before or after it. */
function standsAlone(text: string, word: string): boolean {
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    const before = text.slice(0, at).at(-1) ?? ''
    const after = text.slice(at + word.length).at(0) ?? ''
    if (!LETTER.test(before) && !LETTER.test(after)) {
      return true
    }
  }
  return false
}

function readClock(time: readonly string[], meridiem: 'pm' | 'am' | null): { hour: number, minute: number, second: number } | null {
  const [hourText = '', minuteText = '', secondText = ''] = time
  if (hourText.length > 2 || minuteText.length !== 2 || secondText.length !== 2) {
    return null
  }
  const minute = Number(minuteText)
  const second = Number(secondText)
  let hour = Number(hourText)
  if (meridiem === null ? hour > 23 : hour > 12) {
    return null
  }
  if (meridiem !== null) {
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0)
  }
  return minute > 59 || second > 59 ? null : { hour, minute, second }
}

/** The ways to read a date: with the year first, month-day (most locales) or day-month (ug, nqo); with it last, either. */
function dateReadings(date: readonly string[]): Array<{ order: DateOrder, year: number, month: number, day: number }> {
  const [first = '', second = '', third = ''] = date
  if (second.length > 2) {
    return []
  }
  if (first.length === 4 && third.length <= 2) {
    return [
      { order: 'ymd', year: Number(first), month: Number(second), day: Number(third) },
      { order: 'ydm', year: Number(first), month: Number(third), day: Number(second) },
    ]
  }
  if (third.length === 4 && first.length <= 2) {
    return [
      { order: 'mdy', year: Number(third), month: Number(first), day: Number(second) },
      { order: 'dmy', year: Number(third), month: Number(second), day: Number(first) },
    ]
  }
  return []
}

/**
 * The Gregorian date of a date read from a stamp. Undefined when no calendar
 * has that date; null when it is a real date in a calendar this cannot place,
 * so the stamp still marks a new line but its time is unknown.
 */
function placeDate(date: { year: number, month: number, day: number }, context: StampContext): { year: number, month: number, day: number } | null | undefined {
  const referenceYear = new Date(context.reference).getUTCFullYear()
  if (Math.abs(date.year - referenceYear) <= MAX_YEARS_OFF) {
    return existsInGregorian(date) ? date : undefined
  }
  return otherCalendarsHave(date) ? fromOtherCalendar(date, context.reference) : undefined
}

function existsInGregorian({ year, month, day }: { year: number, month: number, day: number }): boolean {
  const check = new Date(Date.UTC(year, month - 1, day))
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
}

/** A Persian month has up to 31 days in its first half, so a date such as 1405/2/31 is real there although February has no 31st. */
function otherCalendarsHave({ month, day }: { month: number, day: number }): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

const calendarFormatters = new Map<string, Intl.DateTimeFormat>()
const calendarDays = new Map<string, { year: number, month: number, day: number } | null>()
const MAX_CACHED_DAYS = 1000

/** The Gregorian date that a Buddhist or Persian date names, found among the days before the line arrived. */
function fromOtherCalendar(date: { year: number, month: number, day: number }, reference: number): { year: number, month: number, day: number } | null {
  const referenceDay = Math.floor(reference / DAY_MS)
  const key = `${referenceDay}:${date.year}-${date.month}-${date.day}`
  const cached = calendarDays.get(key)
  if (cached !== undefined) {
    return cached
  }
  let found: { year: number, month: number, day: number } | null = null
  search: for (const calendar of OTHER_CALENDARS) {
    const formatter = calendarFormatter(calendar)
    for (let offset = 1; offset >= -CALENDAR_SEARCH_DAYS; offset--) {
      const noon = (referenceDay + offset) * DAY_MS + DAY_MS / 2
      const parts = numericParts(formatter, noon)
      if (parts.year === date.year && parts.month === date.month && parts.day === date.day) {
        const gregorian = new Date(noon)
        found = { year: gregorian.getUTCFullYear(), month: gregorian.getUTCMonth() + 1, day: gregorian.getUTCDate() }
        break search
      }
    }
  }
  if (calendarDays.size >= MAX_CACHED_DAYS) {
    calendarDays.clear()
  }
  calendarDays.set(key, found)
  return found
}

function calendarFormatter(calendar: string): Intl.DateTimeFormat {
  let formatter = calendarFormatters.get(calendar)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(`en-u-ca-${calendar}-nu-latn`, { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' })
    calendarFormatters.set(calendar, formatter)
  }
  return formatter
}

function numericParts(formatter: Intl.DateTimeFormat, epoch: number): Record<string, number> {
  const parts: Record<string, number> = {}
  for (const part of formatter.formatToParts(epoch)) {
    parts[part.type] = Number(part.value)
  }
  return parts
}

function utcWall(fields: Fields): number | null {
  const { year, month, day, hour, minute, second, millisecond = 0 } = fields
  if (!existsInGregorian({ year, month, day })) {
    return null
  }
  return Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
}

/** `Z`, `+02`, `+0200` or `+02:00`, in ms ahead of UTC. */
function offsetMs(offset: string): number {
  if (offset === 'Z') {
    return 0
  }
  const sign = offset.startsWith('-') ? -1 : 1
  const digits = offset.slice(1).replace(':', '')
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0')) * 60_000
}

/**
 * Epoch ms of a wall-clock time in the host's zone, or null when the date does
 * not exist. When clocks go back, an hour of wall times happens twice; the
 * reading closer to when the line arrived wins.
 */
function toEpoch(fields: Fields, context: StampContext): number | null {
  const wall = utcWall(fields)
  if (wall === null) {
    return null
  }
  const offsetAt = (epoch: number): number => context.timeZone === null
    ? -new Date(epoch).getTimezoneOffset() * 60_000
    : zoneOffset(epoch, context.timeZone)
  // The offsets a day either side cover the one change of offset that can fall near this wall time.
  const candidates = [...new Set([wall - offsetAt(wall - DAY_MS), wall - offsetAt(wall + DAY_MS)])]
  const real = candidates.filter((epoch) => epoch + offsetAt(epoch) === wall)
  if (real.length === 0) {
    // A wall time that the clocks skipped. Read it with the offset from before the change.
    return candidates[0] ?? null
  }
  return real.reduce((best, epoch) => Math.abs(epoch - context.reference) < Math.abs(best - context.reference) ? epoch : best)
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
  const parts = numericParts(formatter, epoch)
  const asUtc = Date.UTC(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day ?? 1, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0)
  return asUtc - Math.floor(epoch / 1000) * 1000
}

/** Lowercase, without dots or invisible format characters, and with one space between words, so `p.m.` and `pm` compare equal. */
function wordForm(text: string): string {
  return text.toLowerCase().replace(/[.\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim()
}

function byLength(words: string[]): string[] {
  return words.map(wordForm).sort((a, b) => b.length - a.length)
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
