import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import { openDatabase } from '../src/server/store/database.ts'
import { LogStore, type NewLogLine } from '../src/server/store/log-store.ts'

function line(overrides: Partial<NewLogLine> = {}): NewLogLine {
  return {
    instance: 'example-1', ts: 1000, receivedAt: 1000, plugin: 'Example', level: 'info', system: false,
    raw: 'hello', messageOffset: 0, ...overrides,
  }
}

describe('LogStore', () => {
  let store: LogStore

  beforeEach(() => {
    store = new LogStore(openDatabase(':memory:'))
  })

  it('returns stored lines with increasing ids and the message after the prefix', () => {
    const [first, second] = store.append([line({ raw: '[t] [P] one', messageOffset: 8 }), line()])
    assert.ok(first && second && second.id > first.id)
    assert.equal(first.message, 'one')
    assert.equal(store.latestId(), second.id)
  })

  it('pages backwards from the newest line, oldest first in each page', () => {
    store.append(Array.from({ length: 5 }, (_, i) => line({ raw: `n${i}` })))
    const newest = store.page({}, 2)
    assert.deepEqual(newest.lines.map((l) => l.message), ['n3', 'n4'])
    assert.equal(newest.hasMore, true)
    const older = store.page({}, 10, newest.lines[0]?.id)
    assert.deepEqual(older.lines.map((l) => l.message), ['n0', 'n1', 'n2'])
    assert.equal(older.hasMore, false)
  })

  it('orders the instances by log time, not by when their lines were stored', () => {
    store.append([2000, 4000, 6000].map((ts) => line({ instance: 'example-2', ts, raw: `two ${ts}` })))
    store.append([1000, 3000, 5000].map((ts) => line({ instance: 'example-1', ts, raw: `one ${ts}` })))
    const newest = store.page({}, 4)
    assert.deepEqual(newest.lines.map((l) => l.message), ['one 3000', 'two 4000', 'one 5000', 'two 6000'])
    const older = store.page({}, 10, newest.lines[0]?.id)
    assert.deepEqual(older.lines.map((l) => l.message), ['one 1000', 'two 2000'])
    assert.equal(older.hasMore, false)
  })

  it('filters by instance, level and plugin', () => {
    store.append([
      line({ instance: 'example-1', level: 'error', raw: 'disk full' }),
      line({ instance: 'example-2', level: 'warn', raw: 'slow' }),
      line({ instance: 'example-2', level: 'info', plugin: 'Other', raw: '100% done' }),
      line({ instance: 'example-3', level: 'debug', raw: 'detail' }),
    ])
    const messages = (filter: Parameters<LogStore['page']>[0]): string[] => store.page(filter, 10).lines.map((l) => l.message)
    assert.deepEqual(messages({ instances: ['example-2'] }), ['slow', '100% done'])
    assert.deepEqual(messages({ instances: ['example-2', 'example-2'] }), ['slow', '100% done'])
    assert.deepEqual(messages({ instances: ['example-1', 'example-3'] }), ['disk full', 'detail'])
    assert.deepEqual(messages({ minLevel: 'warn' }), ['disk full', 'slow'])
    assert.deepEqual(messages({ minLevel: 'error' }), ['disk full'])
    assert.deepEqual(messages({ plugin: 'Other' }), ['100% done'])
  })

  it('searches the plugin name and the visible message, ignoring case, colour codes and the prefix', () => {
    store.append([
      line({ raw: '[10/20/2026, 8:00:00 PM] [Example] \u001b[31mDisk Full\u001b[39m', messageOffset: 35 }),
      line({ plugin: 'Other', raw: 'all good' }),
      line({ plugin: null, raw: '2026 is not in this message' }),
    ])
    const messages = (search: string): string[] => store.page({ search }, 10).lines.map((l) => l.message)
    assert.deepEqual(messages('disk full'), ['\u001b[31mDisk Full\u001b[39m'])
    assert.deepEqual(messages('  DISK  '), ['\u001b[31mDisk Full\u001b[39m'])
    assert.deepEqual(messages('31m'), [], 'colour codes are not text')
    assert.deepEqual(messages('8:00'), [], 'the timestamp is not part of the message')
    assert.deepEqual(messages('other all'), ['all good'], 'the plugin name comes first')
    assert.deepEqual(messages('ot'), ['all good', '2026 is not in this message'], 'short queries scan')
  })

  it('treats wildcard characters as plain text, with or without the index', () => {
    const texts = ['100% done', '100 done', 'a_b', 'axb', 'what?', 'what!', 'x*y', 'xzy', '[ok]', 'ok', 'a%b*c', 'aXbYc']
    store.append(texts.map((raw) => line({ raw })))
    const messages = (search: string): string[] => store.page({ search }, 50).lines.map((l) => l.message)
    assert.deepEqual(messages('%'), ['100% done', 'a%b*c'])
    assert.deepEqual(messages('0% d'), ['100% done'])
    assert.deepEqual(messages('a_b'), ['a_b'])
    assert.deepEqual(messages('at?'), ['what?'])
    assert.deepEqual(messages('x*y'), ['x*y'])
    assert.deepEqual(messages('[ok'), ['[ok]'])
    assert.deepEqual(messages('a%b*c'), ['a%b*c'])
  })

  it('finds only lines that hold the whole query, not just its trigrams', () => {
    store.append([line({ raw: 'abcxbcd' }), line({ raw: 'abcd' })])
    assert.deepEqual(store.page({ search: 'abcd' }, 10).lines.map((l) => l.message), ['abcd'])
  })

  it('scans in page order when a search matches too many lines for the index list', () => {
    store.append(Array.from({ length: 2100 }, (_, i) => line({ ts: i, raw: `common ${i}` })))
    const page = store.page({ search: 'common' }, 3)
    assert.deepEqual(page.lines.map((l) => l.message), ['common 2097', 'common 2098', 'common 2099'])
    assert.equal(page.hasMore, true)
  })

  it('returns the lines after an id, for a stream that reconnects', () => {
    const stored = store.append([line(), line(), line()])
    assert.deepEqual(store.after(stored[0]!.id, 10).map((l) => l.id), [stored[1]!.id, stored[2]!.id])
  })

  it('leaves its own system lines and blank lines out of the replay comparison', () => {
    store.append([line({ raw: '\u001b[37ma' }), line({ raw: 'lost', system: true }), line({ raw: '\u001b[39m ' }), line({ raw: 'b' })])
    assert.deepEqual(store.recentPlain('example-1', 10), ['a', 'b'])
  })

  it('counts errors and warnings per plugin by log time', () => {
    store.append([
      line({ level: 'error', ts: 50, receivedAt: 5000 }),
      line({ level: 'error', ts: 2000 }),
      line({ level: 'error', ts: 2000 }),
      line({ level: 'warn', ts: 2000, plugin: null }),
      line({ level: 'info', ts: 2000 }),
      line({ level: 'error', ts: 2000, system: true }),
    ])
    assert.deepEqual(store.counts(1000), [
      { instance: 'example-1', plugin: 'Example', level: 'error', count: 2 },
      { instance: 'example-1', plugin: null, level: 'warn', count: 1 },
    ])
  })

  it('prunes by arrival time, then by count, a batch at a time', () => {
    store.append([line({ receivedAt: 1 }), line({ receivedAt: 2 }), line({ receivedAt: 5000 }), line({ receivedAt: 6000 }), line({ receivedAt: 7000 })])
    assert.equal(store.pruneBatch(1000, 2, 1), 1)
    assert.equal(store.pruneBatch(1000, 2, 10), 2)
    assert.equal(store.pruneBatch(1000, 2, 10), 0)
    assert.equal(store.page({}, 10).lines.length, 2)
    assert.deepEqual(store.page({ search: 'hello' }, 10).lines.length, 2, 'the search index follows deletes')
    store.optimize()
  })
})
