/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { LineSplitter, MAX_LINE, parseLine, stripAnsiText, TRUNCATED } from '../src/server/logs/line-parser.ts'
import { knownTimeZone, readStamp, type StampContext } from '../src/server/logs/timestamp.ts'
import { homebridgeLine } from './helpers/fake-homebridge.ts'

const LOCAL: StampContext = { reference: new Date(2026, 9, 20, 20, 0, 0).getTime(), timeZone: null }

describe('LineSplitter', () => {
  it('joins a line that arrives in pieces and drops the \\r of \\n\\r breaks', () => {
    const splitter = new LineSplitter()
    assert.deepEqual(splitter.push('first\n\rsec'), ['first'])
    assert.deepEqual(splitter.push('ond\n\r'), ['second'])
  })

  it('keeps a partial line until the rest arrives', () => {
    const splitter = new LineSplitter()
    assert.deepEqual(splitter.push('no newline yet'), [])
    assert.deepEqual(splitter.push(' and now\n'), ['no newline yet and now'])
  })

  it('cuts a line longer than MAX_LINE once and drops the rest of it', () => {
    const splitter = new LineSplitter()
    const long = 'x'.repeat(MAX_LINE + 10)
    assert.deepEqual(splitter.push(long.slice(0, 1000)), [])
    const lines = splitter.push(`${long.slice(1000)}\nnext\n`)
    assert.deepEqual(lines.map((line) => line.length), [MAX_LINE + TRUNCATED.length, 4])
    assert.ok(lines[0]?.endsWith(TRUNCATED))
    assert.deepEqual(splitter.push('y'.repeat(MAX_LINE * 2)).length, 1)
    assert.deepEqual(splitter.push('still the same line\nafter\n'), ['after'])
  })

  it('does not leave half an escape code at the cut', () => {
    const splitter = new LineSplitter()
    const [line] = splitter.push(`${'x'.repeat(MAX_LINE - 3)}\u001b[31mred\n`)
    assert.ok(line?.endsWith(`${'x'.repeat(MAX_LINE - 3)}${TRUNCATED}`))
  })
})

describe('parseLine', () => {
  it('reads the time, plugin and level of a Homebridge line', () => {
    const raw = homebridgeLine('10/20/2026, 8:05:09 PM', 'Example', 'Device offline', 'error')
    const line = parseLine(raw, null, LOCAL)
    assert.equal(line.plugin, 'Example')
    assert.equal(line.level, 'error')
    assert.equal(line.ts, new Date(2026, 9, 20, 20, 5, 9).getTime())
    assert.equal(line.plain, '[10/20/2026, 8:05:09 PM] [Example] Device offline')
    assert.equal(stripAnsiText(raw.slice(line.messageOffset)), 'Device offline')
  })

  it('keeps the message colour codes in the message', () => {
    const raw = homebridgeLine('10/20/2026, 8:05:09 AM', 'Example', 'Careful', 'warn')
    const line = parseLine(raw, null, LOCAL)
    assert.equal(line.level, 'warn')
    assert.ok(raw.slice(line.messageOffset).includes('\u001b[33mCareful'))
  })

  it('treats 12 AM as midnight and 12 PM as noon', () => {
    const context = { ...LOCAL, reference: new Date(2026, 0, 2, 12).getTime() }
    assert.equal(parseLine('[1/2/2026, 12:00:00 AM] x', null, context).ts, new Date(2026, 0, 2, 0, 0, 0).getTime())
    assert.equal(parseLine('[1/2/2026, 12:00:00 PM] x', null, context).ts, new Date(2026, 0, 2, 12, 0, 0).getTime())
  })

  it('reads a line from Homebridge core, which has no plugin prefix', () => {
    const line = parseLine(homebridgeLine('10/20/2026, 8:05:09 PM', null, 'Loaded config.json'), null, LOCAL)
    assert.equal(line.plugin, null)
    assert.equal(line.level, 'info')
  })

  it('gives a line with no timestamp the plugin and level of the line before it', () => {
    const line = parseLine('    at Socket.emit (node:events:1:1)', { plugin: 'Example', level: 'error' }, LOCAL)
    assert.equal(line.ts, null)
    assert.equal(line.plugin, 'Example')
    assert.equal(line.level, 'error')
    assert.equal(line.messageOffset, 0)
  })

  it('reads an ISO timestamp', () => {
    const line = parseLine('[2026-10-20T20:05:09.000Z] [Example] hello', null, LOCAL)
    assert.equal(line.ts, Date.parse('2026-10-20T20:05:09.000Z'))
    assert.equal(line.plugin, 'Example')
  })

  it('does not mistake a bracketed word for a timestamp', () => {
    const line = parseLine('[Example] not a time', null, LOCAL)
    assert.equal(line.ts, null)
  })

  it('keeps a bracketed name with a number in the message, instead of reading it as a date', () => {
    for (const text of ['[Camera 2] stream started', '[Thermostat 1] set 21', '[Room 101] temp 21', '[Port 51826] up']) {
      const line = parseLine(text, { plugin: 'Example', level: 'warn' }, LOCAL)
      assert.equal(line.isEntry, false, text)
      assert.equal(line.ts, null, text)
      assert.equal(line.messageOffset, 0, text)
      assert.equal(line.plugin, 'Example', text)
    }
  })

  it('gives a continuation line its own level when it starts with a colour, else the level before it', () => {
    const previous = { plugin: 'Example', level: 'info' as const }
    assert.equal(parseLine('\u001b[31m    at Socket.emit (node:events:1:1)', previous, LOCAL).level, 'error')
    assert.equal(parseLine('    at Socket.emit (node:events:1:1)', { ...previous, level: 'error' }, LOCAL).level, 'error')
  })

  it('marks a timestamp whose year no calendar can place as an entry with no time', () => {
    const line = parseLine('[1/2/1900, 10:00:00] [Example] old', null, LOCAL)
    assert.equal(line.isEntry, true)
    assert.equal(line.ts, null)
    assert.equal(line.plugin, 'Example')
  })
})

describe('readStamp', () => {
  const local = (...parts: [number, number, number, number, number, number]): number => new Date(...parts).getTime()
  const at = (text: string, context: StampContext = LOCAL): number | null => readStamp(`[${text}] x`, context)?.ts ?? null

  it('reads the formats of common locales', () => {
    const expected = local(2026, 9, 20, 20, 5, 9)
    assert.equal(at('10/20/2026, 8:05:09 PM'), expected, 'en-US')
    assert.equal(at('20/10/2026, 20:05:09'), expected, 'en-GB')
    assert.equal(at('20.10.2026, 20:05:09'), expected, 'de')
    assert.equal(at('20.10.2026 20:05:09'), expected, 'ru')
    assert.equal(at('2026-10-20 20:05:09'), expected, 'sv')
    assert.equal(at('2026/10/20 20:05:09'), expected, 'ja')
    assert.equal(at('20/10/2026 20:05:09'), expected, 'fr')
    assert.equal(at('10/20/2026, 8:05:09\u202fPM'), expected, 'en-US with a narrow space')
    assert.equal(at('20/10/2026, 8:05:09 pm'), expected, 'en-AU')
  })

  it('picks the reading of an ambiguous day and month closest to when the line arrived', () => {
    const march = { ...LOCAL, reference: local(2026, 2, 4, 12, 0, 0) }
    const april = { ...LOCAL, reference: local(2026, 3, 3, 12, 0, 0) }
    assert.equal(at('03/04/2026, 10:00:00', march), local(2026, 2, 4, 10, 0, 0))
    assert.equal(at('03/04/2026, 10:00:00', april), local(2026, 3, 3, 10, 0, 0))
  })

  it('refuses dates and times that do not exist', () => {
    assert.equal(at('13/45/2026, 08:00:00'), null)
    assert.equal(at('2/30/2026, 08:00:00'), null)
    assert.equal(at('10/20/2026, 25:00:00'), null)
    assert.equal(at('10/20/2026, 13:00:00 PM'), null)
    assert.equal(at('10/20/2026, 10:61:00'), null)
  })

  it('reads the time in the Homebridge host time zone, across a DST change', () => {
    const utc = { ...LOCAL, timeZone: 'UTC' }
    assert.equal(at('10/20/2026, 8:05:09 PM', utc), Date.UTC(2026, 9, 20, 20, 5, 9))
    const berlin = { reference: Date.UTC(2026, 2, 29, 12), timeZone: 'Europe/Berlin' }
    assert.equal(at('29.03.2026, 01:30:00', berlin), Date.UTC(2026, 2, 29, 0, 30), 'before the change, UTC+1')
    assert.equal(at('29.03.2026, 03:30:00', berlin), Date.UTC(2026, 2, 29, 1, 30), 'after the change, UTC+2')
    const kolkata = { reference: Date.UTC(2026, 9, 20), timeZone: 'Asia/Kolkata' }
    assert.equal(at('2026-10-20 05:30:00', kolkata), Date.UTC(2026, 9, 20, 0, 0))
  })

  it('reads the stamp of every kind of locale exactly, in the host time zone', () => {
    // One locale for each shape: other digits, other calendars, day-period words before or after the time, time first, and words between.
    const locales = [
      'en-US', 'en-GB', 'de-DE', 'sv-SE', 'da-DK', 'fi-FI', 'ko-KR', 'zh-TW', 'zh-SG', 'ja-JP', 'bg-BG', 'ar-EG', 'fa-IR', 'ps-PK',
      'th-TH', 'fr-CA', 'id-ID', 'vi-VN', 'el-GR', 'ms-MY', 'hu-HU', 'eu-ES', 'oc-FR', 'ee-GH', 'kok-IN', 'nds-DE', 'sq-AL', 'am-ET',
    ]
    const zones = ['UTC', 'America/New_York', 'Asia/Kolkata']
    for (const zone of zones) {
      for (const locale of locales) {
        for (const instant of [Date.UTC(2026, 9, 21, 20, 5, 9), Date.UTC(2026, 9, 21, 8, 5, 9), Date.UTC(2026, 0, 1, 0, 0, 1)]) {
          const text = new Date(instant).toLocaleString(locale, { timeZone: zone })
          assert.equal(at(text, { reference: instant + 30_000, timeZone: zone }), instant, `${locale} ${zone} ${text}`)
        }
      }
    }
  })

  it('reads year-day-month dates once a line has shown that order', () => {
    const utc = { reference: Date.UTC(2026, 3, 3, 12), timeZone: 'UTC' }
    const proof = readStamp(`[${new Date(Date.UTC(2026, 9, 21, 20)).toLocaleString('ug', { timeZone: 'UTC' })}] x`, utc)
    assert.equal(proof?.order, 'ydm')
    const ambiguous = new Date(Date.UTC(2026, 3, 3, 8)).toLocaleString('ug', { timeZone: 'UTC' })
    assert.equal(at(ambiguous, { ...utc, order: 'ydm' }), Date.UTC(2026, 3, 3, 8))
    assert.equal(at(ambiguous, utc), Date.UTC(2026, 2, 4, 8), 'year-month-day until the log shows otherwise')
  })

  it('reads ISO times, with an offset as given and without one in the host time zone', () => {
    const newYork = { reference: Date.UTC(2026, 9, 21, 12), timeZone: 'America/New_York' }
    assert.equal(at('2026-10-21T20:05:09.123Z', newYork), Date.UTC(2026, 9, 21, 20, 5, 9, 123))
    assert.equal(at('2026-10-21T20:05:09+02:00', newYork), Date.UTC(2026, 9, 21, 18, 5, 9))
    assert.equal(at('2026-10-21 20:05:09.123', newYork), Date.UTC(2026, 9, 22, 0, 5, 9, 123))
  })

  it('reads the hour that happens twice when clocks go back as the one nearer the arrival', () => {
    const first = { reference: Date.UTC(2026, 10, 1, 5, 30), timeZone: 'America/New_York' }
    const second = { reference: Date.UTC(2026, 10, 1, 6, 30), timeZone: 'America/New_York' }
    assert.equal(at('11/1/2026, 1:30:00 AM', first), Date.UTC(2026, 10, 1, 5, 30), 'daylight time, UTC-4')
    assert.equal(at('11/1/2026, 1:30:00 AM', second), Date.UTC(2026, 10, 1, 6, 30), 'standard time, UTC-5')
  })

  it('knows a real zone name and nothing else', () => {
    assert.equal(knownTimeZone('America/New_York'), 'America/New_York')
    assert.equal(knownTimeZone('Not/AZone'), null)
    assert.equal(knownTimeZone(''), null)
    assert.equal(knownTimeZone(null), null)
  })
})
