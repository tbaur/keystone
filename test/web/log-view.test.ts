import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LogLine, LogPage } from '../../src/shared/types.ts'
import { NO_FILTERS, type Filters } from '../../src/web/filters.ts'
import { LogView } from '../../src/web/log-view.ts'
import { FakeBrowser, ROW_PX } from './fake-dom.ts'

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

  it('says so when they fail to load', async () => {
    const { browser } = setup(page(lines(100, 129), true), { loadOlder: () => Promise.reject(new Error('offline')) })
    browser.scroller.scrollTop = 0
    browser.settle()
    await settlePromises()
    assert.equal(browser.status.textContent, 'Could not load older lines. Scroll up to try again.')
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
