/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LogLine, LogPage } from '../../src/shared/types.ts'
import { CORE_PLUGIN, NO_FILTERS, type Filters } from '../../src/web/filters.ts'
import { LogView } from '../../src/web/log-view.ts'
import { FakeBrowser, ROW_PX, steps } from './fake-dom.ts'

const NOON = new Date(2026, 0, 15, 12).getTime()
const DAY_MS = 86_400_000
const MAX_ROWS = 5000

function line(id: number, overrides: Partial<LogLine> = {}): LogLine {
  return { id, instance: 'example-1', ts: NOON + id * 1000, plugin: 'Example', level: 'info', message: `line ${id}`, system: false, ...overrides }
}

function lines(from: number, to: number): LogLine[] {
  return Array.from({ length: to - from + 1 }, (_, index) => line(from + index))
}

function page(pageLines: LogLine[], hasMore = false): LogPage {
  return { lines: pageLines, hasMore, latestId: pageLines.at(-1)?.id ?? 0 }
}

interface Setup {
  browser: FakeBrowser
  view: LogView
  picks: Array<{ instance?: string, plugin?: string }>
  reloads: number[]
  olderRequests: number[]
}

function setup(first: LogPage, options: { filters?: Filters, loadOlder?: (beforeId: number) => Promise<LogPage> } = {}): Setup {
  const browser = new FakeBrowser()
  const picks: Setup['picks'] = []
  const reloads: number[] = []
  const olderRequests: number[] = []
  const view = new LogView({
    elements: browser.elements(),
    colourOf: () => 0,
    loadOlder: (beforeId) => {
      olderRequests.push(beforeId)
      return options.loadOlder?.(beforeId) ?? Promise.resolve(page([]))
    },
    onPick: (pick) => picks.push(pick),
    onReload: () => reloads.push(1),
  }, options.filters ?? NO_FILTERS)
  view.reset(first, options.filters ?? NO_FILTERS)
  browser.settle()
  return { browser, view, picks, reloads, olderRequests }
}

function rowIds(browser: FakeBrowser): number[] {
  return browser.list.findAll('row').map((row) => Number(row.dataset.id))
}

function dividerCount(browser: FakeBrowser): number {
  return browser.list.findAll('divider').length
}

async function settlePromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('LogView following the tail', () => {
  it('stays at the bottom as lines arrive', () => {
    const { browser, view } = setup(page(lines(1, 30)))
    assert.ok(browser.scroller.isAtBottom)
    view.receive(lines(31, 35))
    browser.settle()
    assert.deepEqual(rowIds(browser).slice(-2), [34, 35])
    assert.ok(browser.scroller.isAtBottom)
    assert.equal(browser.jump.hidden, true)
  })

  it('lets go on a small scroll up, even while lines keep arriving', () => {
    const { browser, view } = setup(page(lines(1, 30)))
    browser.scroller.scrollBy(-5)
    view.receive([line(31)])
    browser.settle()
    const top = browser.scroller.scrollTop
    browser.scroller.scrollBy(-5)
    view.receive([line(32)])
    browser.settle()
    assert.equal(browser.scroller.scrollTop, top - 5)
    assert.equal(rowIds(browser).at(-1), 30)
    assert.equal(browser.jump.hidden, false)
    assert.equal(browser.jump.textContent, '2 new lines below')
  })

  it('lets go on a wheel up before its scroll event arrives, so new lines do not pull the view back down', () => {
    const { browser, view } = setup(page(lines(1, 30)))
    browser.scroller.fire({ type: 'wheel', target: browser.scroller, deltaY: -5 })
    view.receive([line(31)])
    browser.settle()
    assert.equal(rowIds(browser).at(-1), 30)
    assert.equal(browser.jump.hidden, false)
    assert.equal(browser.jump.textContent, '1 new line below')
  })

  it('lets go on a swipe down the screen and on keys that scroll up', () => {
    const swipe = setup(page(lines(1, 30)))
    swipe.browser.scroller.fire({ type: 'touchstart', target: swipe.browser.scroller, touches: [{ clientY: 100 }] })
    swipe.browser.scroller.fire({ type: 'touchmove', target: swipe.browser.scroller, touches: [{ clientY: 110 }] })
    swipe.view.receive([line(31)])
    swipe.browser.settle()
    assert.equal(rowIds(swipe.browser).at(-1), 30)

    for (const key of [{ key: 'ArrowUp' }, { key: 'PageUp' }, { key: 'Home' }, { key: ' ', shiftKey: true }]) {
      const { browser, view } = setup(page(lines(1, 30)))
      browser.scroller.fire({ type: 'keydown', target: browser.scroller, shiftKey: false, ...key })
      view.receive([line(31)])
      browser.settle()
      assert.equal(rowIds(browser).at(-1), 30, key.key)
    }
  })

  it('keeps following on a wheel down, a swipe up the screen, or when nothing is above', () => {
    const { browser, view } = setup(page(lines(1, 30)))
    browser.scroller.fire({ type: 'wheel', target: browser.scroller, deltaY: 5 })
    browser.scroller.fire({ type: 'touchstart', target: browser.scroller, touches: [{ clientY: 100 }] })
    browser.scroller.fire({ type: 'touchmove', target: browser.scroller, touches: [{ clientY: 90 }] })
    view.receive([line(31)])
    browser.settle()
    assert.equal(rowIds(browser).at(-1), 31)
    assert.ok(browser.scroller.isAtBottom)

    const short = setup(page(lines(1, 5)))
    short.browser.scroller.fire({ type: 'wheel', target: short.browser.scroller, deltaY: -5 })
    short.view.receive([line(6)])
    short.browser.settle()
    assert.equal(rowIds(short.browser).at(-1), 6)
    assert.equal(short.browser.jump.hidden, true)
  })

  it('lets go while the scrollbar is held, and follows again when it is let go at the bottom', () => {
    const { browser, view } = setup(page(lines(1, 30)))
    browser.scroller.fire({ type: 'pointerdown', target: browser.scroller })
    view.receive([line(31)])
    browser.settle()
    assert.equal(rowIds(browser).at(-1), 30)
    browser.window.fire({ type: 'pointerup', target: browser.window })
    browser.settle()
    assert.equal(rowIds(browser).at(-1), 31)
    assert.ok(browser.scroller.isAtBottom)
    assert.equal(browser.jump.hidden, true)
  })

  it('keeps following on a press on a row', () => {
    const { browser, view } = setup(page(lines(1, 30)))
    const row = browser.list.findAll('row')[0]
    assert.ok(row)
    browser.scroller.fire({ type: 'pointerdown', target: row })
    view.receive([line(31)])
    browser.settle()
    assert.equal(rowIds(browser).at(-1), 31)
  })

  it('follows again back at the bottom, with the lines that arrived meanwhile', () => {
    const { browser, view } = setup(page(lines(1, 30)))
    browser.scroller.scrollBy(-100)
    browser.settle()
    view.receive(lines(31, 32))
    browser.settle()
    browser.scroller.scrollBy(100)
    browser.settle()
    assert.deepEqual(rowIds(browser).slice(-2), [31, 32])
    assert.ok(browser.scroller.isAtBottom)
    assert.equal(browser.jump.hidden, true)
  })

  it('jumps to the latest from the button', () => {
    const { browser, view } = setup(page(lines(1, 30)))
    browser.scroller.scrollBy(-200)
    browser.settle()
    view.receive([line(31)])
    browser.settle()
    browser.jump.click()
    browser.settle()
    assert.equal(rowIds(browser).at(-1), 31)
    assert.ok(browser.scroller.isAtBottom)
    assert.equal(browser.jump.hidden, true)
  })

  it('reloads instead when more lines arrived than it can hold', () => {
    const { browser, view, reloads } = setup(page(lines(1, 30)))
    browser.scroller.scrollBy(-200)
    browser.settle()
    view.receive(lines(31, 3030))
    browser.settle()
    view.receive(lines(3031, 6030))
    browser.settle()
    browser.jump.click()
    assert.equal(reloads.length, 1)
    assert.equal(rowIds(browser).at(-1), 30)
  })
})

describe('LogView order and size', () => {
  it('puts a late line in its place, with a divider for its day', () => {
    const { browser, view } = setup(page([line(1), line(2, { ts: NOON + 2 * DAY_MS })]))
    view.receive([line(3, { ts: NOON + DAY_MS })])
    browser.settle()
    assert.deepEqual(rowIds(browser), [1, 3, 2])
    assert.equal(dividerCount(browser), 3)
  })

  it('leaves a late line older than every row to the older pages', () => {
    const { browser, view } = setup(page(lines(10, 20), true))
    view.receive([line(21, { ts: NOON })])
    browser.settle()
    assert.deepEqual(rowIds(browser), lines(10, 20).map((each) => each.id))
  })

  it('keeps at most 5000 rows while following, and the oldest stay one scroll away', () => {
    const { browser, view } = setup(page(lines(1, MAX_ROWS)))
    view.receive(lines(MAX_ROWS + 1, MAX_ROWS + 10))
    browser.settle()
    const ids = rowIds(browser)
    assert.equal(ids.length, MAX_ROWS)
    assert.equal(ids[0], 11)
    assert.ok(browser.list.firstElementChild?.classList.contains('divider'))
    assert.equal(browser.status.textContent, '')
  })

  it('puts several late lines from a reconnect each in its place, between days', () => {
    const day = (id: number, days: number): LogLine => line(id, { ts: NOON + days * DAY_MS + id * 1000 })
    const { browser, view } = setup(page([day(1, 0), day(2, 0), day(3, 1), day(4, 1), day(5, 2)]))
    view.receive([day(10, 2), day(6, 0), day(7, 1), day(8, 1), day(9, 2)])
    browser.settle()
    assert.deepEqual(rowIds(browser), [1, 2, 6, 3, 4, 7, 8, 5, 9, 10])
    assert.equal(dividerCount(browser), 3)
  })

  it('finds the place of late lines without walking back through the list', () => {
    const { browser, view } = setup(page(lines(100, 2100)))
    const late = Array.from({ length: 50 }, (_, i) => line(3000 + i, { ts: NOON + (101 + i) * 1000 + 500 }))
    steps.previous = 0
    view.receive(late)
    browser.settle()
    assert.ok(steps.previous < 50 * 40, `${steps.previous} steps back for 50 lines`)
    assert.deepEqual(rowIds(browser).slice(1, 5), [101, 3000, 102, 3001])
  })

  it('shows a line once when the stream sends one that the new page already has', () => {
    const { browser, view } = setup(page(lines(1, 3)))
    view.pause()
    view.reset(page(lines(1, 10)), NO_FILTERS)
    view.receive([line(9), line(10), line(11)])
    browser.settle()
    assert.deepEqual(rowIds(browser), lines(1, 11).map((each) => each.id))
    assert.equal(view.latestId, 11)
  })

  it('starts over when more lines arrived during a reload than it holds, leaving a gap', () => {
    const { browser, view } = setup(page(lines(1, 3)))
    view.pause()
    view.receive(lines(4, MAX_ROWS + 10))
    view.reset(page(lines(1, 3)), NO_FILTERS)
    browser.settle()
    const ids = rowIds(browser)
    assert.equal(ids[0], 11, 'the oldest lines held during the reload were dropped, so the view starts after the gap')
    assert.equal(ids.at(-1), MAX_ROWS + 10)
  })

  it('starts over at the newest lines when a background tab queued too many', () => {
    const { browser, view } = setup(page(lines(1, 5)))
    view.receive(lines(6, MAX_ROWS + 6))
    browser.settle()
    const ids = rowIds(browser)
    assert.equal(ids.length, MAX_ROWS)
    assert.equal(ids[0], 7)
    assert.ok(browser.scroller.isAtBottom)
  })
})

describe('LogView older lines', () => {
  it('goes on from where a search stopped reading, without waiting for a scroll, until it finds lines', async () => {
    const searched: LogPage[] = [
      { lines: [], hasMore: true, latestId: 200, nextBefore: 150 },
      { lines: [line(40)], hasMore: false, latestId: 200 },
    ]
    const { browser, olderRequests } = setup({ lines: [], hasMore: true, latestId: 200, nextBefore: 180 }, {
      filters: { ...NO_FILTERS, search: 'rare' },
      loadOlder: () => Promise.resolve(searched.shift() ?? page([])),
    })
    await settlePromises()
    await settlePromises()
    assert.deepEqual(olderRequests, [180, 150])
    assert.deepEqual(rowIds(browser), [40])
    assert.equal(browser.status.textContent, 'Start of the stored log')
  })

  it('tries a failed load again from a click on the message, when there is nothing to scroll', async () => {
    let fails = true
    const { browser, olderRequests } = setup({ lines: [], hasMore: true, latestId: 200, nextBefore: 180 }, {
      filters: { ...NO_FILTERS, search: 'rare' },
      loadOlder: () => (fails ? Promise.reject(new Error('offline')) : Promise.resolve(page([line(40)]))),
    })
    await settlePromises()
    assert.equal(browser.status.textContent, 'Could not load older lines. Scroll up or click here to try again.')
    assert.ok(browser.status.classList.contains('retry'))
    fails = false
    browser.status.click()
    await settlePromises()
    assert.deepEqual(olderRequests, [180, 180])
    assert.deepEqual(rowIds(browser), [40])
  })

  it('loads them near the top, once at a time, and keeps the view in place', async () => {
    const older = Promise.withResolvers<LogPage>()
    const { browser, olderRequests } = setup(page(lines(100, 129), true), { loadOlder: () => older.promise })
    browser.scroller.scrollTop = 0
    browser.settle()
    browser.scroller.scrollBy(10)
    browser.settle()
    assert.deepEqual(olderRequests, [100])
    assert.equal(browser.status.textContent, 'Loading older lines…')
    older.resolve(page(lines(80, 99)))
    await settlePromises()
    assert.deepEqual(rowIds(browser), lines(80, 129).map((each) => each.id))
    assert.equal(browser.scroller.scrollTop, 10 + 20 * ROW_PX)
    assert.equal(browser.status.textContent, 'Start of the stored log')
  })

  it('keeps the same line in view when they load a little below the top, where browsers anchor the scroll', async () => {
    const older = Promise.withResolvers<LogPage>()
    const { browser, olderRequests } = setup(page(lines(100, 129), true), { loadOlder: () => older.promise })
    browser.scroller.scrollTop = 150
    browser.settle()
    assert.deepEqual(olderRequests, [100])
    const top = browser.scroller.scrollTop
    older.resolve(page(lines(80, 99)))
    await settlePromises()
    browser.settle()
    assert.equal(browser.scroller.scrollTop, top + 20 * ROW_PX)
  })

  it('keeps the same line in view when they load where the browser does not anchor the scroll', async () => {
    const older = Promise.withResolvers<LogPage>()
    const { browser } = setup(page(lines(100, 129), true), { loadOlder: () => older.promise })
    browser.scroller.style.overflowAnchor = 'none'
    browser.scroller.scrollTop = 150
    browser.settle()
    const top = browser.scroller.scrollTop
    older.resolve(page(lines(80, 99)))
    await settlePromises()
    browser.settle()
    assert.equal(browser.scroller.scrollTop, top + 20 * ROW_PX)
  })

  it('keeps the reader in place when rows above change height, as on a wrap toggle', () => {
    const { browser } = setup(page(lines(1, 100)))
    browser.scroller.scrollTop = 50 * ROW_PX
    browser.settle()
    const atTop = browser.list.children[50]
    assert.ok(atTop)
    assert.equal(atTop.getBoundingClientRect().top, 0)
    for (const child of browser.list.children) {
      child.heightPx = 2 * ROW_PX
    }
    browser.settle()
    assert.equal(atTop.getBoundingClientRect().top, 0)
  })

  it('drops a page that was loading when a background tab started over at the newest lines', async () => {
    const older = Promise.withResolvers<LogPage>()
    const { browser, view } = setup(page(lines(100, 129), true), { loadOlder: () => older.promise })
    browser.scroller.scrollTop = 0
    browser.settle()
    assert.equal(browser.status.textContent, 'Loading older lines…')
    view.receive(lines(130, MAX_ROWS + 130))
    browser.settle()
    older.resolve(page(lines(80, 99)))
    await settlePromises()
    const ids = rowIds(browser)
    assert.equal(ids.length, MAX_ROWS)
    assert.equal(ids[0], 131)
    assert.equal(browser.status.textContent, '')
  })

  it('says so when they fail to load', async () => {
    const { browser } = setup(page(lines(100, 129), true), { loadOlder: () => Promise.reject(new Error('offline')) })
    browser.scroller.scrollTop = 0
    browser.settle()
    await settlePromises()
    assert.equal(browser.status.textContent, 'Could not load older lines. Scroll up or click here to try again.')
  })
})

describe('LogView lines and filters', () => {
  it('skips live lines that do not match, and says why the list is empty', () => {
    const filters = { ...NO_FILTERS, level: 'error' as const }
    const { browser, view } = setup(page([]), { filters })
    assert.equal(browser.status.textContent, 'No lines match these filters.')
    view.receive([line(1, { plugin: 'Other' })])
    browser.settle()
    assert.deepEqual(rowIds(browser), [])
    assert.ok(view.plugins.has('Other'))
    view.reset(page([]), NO_FILTERS)
    assert.equal(browser.status.textContent, 'Waiting for log lines…')
  })

  it('keeps lines from a reload gap that are newer than the new page', () => {
    const { browser, view } = setup(page(lines(1, 3)))
    view.pause()
    view.receive(lines(5, 7))
    view.reset(page(lines(1, 6)), NO_FILTERS)
    browser.settle()
    assert.deepEqual(rowIds(browser), [1, 2, 3, 4, 5, 6, 7])
  })

  it('says no lines match when only the instance filter is set', () => {
    const { browser } = setup(page([]), { filters: { ...NO_FILTERS, instances: ['example-2'] } })
    assert.equal(browser.status.textContent, 'No lines match these filters.')
  })

  it('marks the right letters when lowercasing changes the length of the text', () => {
    const { browser } = setup(page([line(1, { message: 'İstanbul door' })]), { filters: { ...NO_FILTERS, search: 'door' } })
    const row = browser.list.findAll('row')[0]!
    assert.deepEqual(row.findAll('msg').flatMap((msg) => msg.children.map((mark) => mark.textContent)), ['door'])
    assert.equal(row.findAll('msg')[0]?.textContent, 'İstanbul door')
  })

  it('narrows to Homebridge itself on a click on a core line\'s label', () => {
    const { browser, picks } = setup(page([line(1, { plugin: null })]))
    browser.list.findAll('plg')[0]!.click()
    assert.deepEqual(picks, [{ plugin: CORE_PLUGIN }])
  })

  it('marks search matches and narrows the filters on a click', () => {
    const filters = { ...NO_FILTERS, search: 'door' }
    const { browser, picks } = setup(page([line(1, { message: 'Front Door opened' })]), { filters })
    const row = browser.list.findAll('row')[0]!
    assert.deepEqual(row.findAll('msg').flatMap((msg) => msg.children.map((mark) => mark.textContent)), ['Door'])
    row.findAll('inst')[0]!.click()
    row.findAll('plg')[0]!.click()
    browser.selection = 'copied text'
    row.findAll('inst')[0]!.click()
    assert.deepEqual(picks, [{ instance: 'example-1' }, { plugin: 'Example' }])
  })
})
