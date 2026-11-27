/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { Dashboard, type SnapshotSource } from '../../src/server/dashboard.ts'
import { openDatabase } from '../../src/server/store/database.ts'
import { LogStore } from '../../src/server/store/log-store.ts'
import type { InstanceSnapshot, LogLine, Overview } from '../../src/shared/types.ts'
import { LiveStream, type StreamHandlers } from '../../src/web/api.ts'
import { readLogPage, readOverview, ShapeError } from '../../src/web/validate.ts'

const SNAPSHOT: InstanceSnapshot = {
  name: 'example-1', uiUrl: 'https://example-1.example.com',
  api: { state: 'connected', since: 1, error: null }, logs: { state: 'unreachable', since: 2, error: 'no log data' },
  homebridge: { status: 'ok', bridgeName: 'Example Bridge', version: '1.11.0', latestVersion: null, updateAvailable: false },
  childBridges: [{ name: 'Sensor Bridge', plugin: 'homebridge-example', status: 'down', manuallyStopped: false }],
  plugins: [{ name: 'homebridge-example', displayName: 'Example', version: '1.0.0', latestVersion: '1.1.0', updateAvailable: true, disabled: false }],
  pluginsError: null, accessories: { total: 2, lowBattery: [{ name: 'Sensor', level: 9 }] }, accessoriesError: null,
  host: { cpuLoad: 5, memoryTotal: 10, memoryAvailable: 5, uptime: 60, networkReceive: null, networkTransmit: null },
  updatedAt: 3,
}

describe('reading the server\'s JSON', () => {
  it('reads an overview and a page exactly as the server builds them', () => {
    const store = new LogStore(openDatabase(':memory:'))
    store.append([{ instance: 'example-1', ts: 1, receivedAt: 1, plugin: null, level: 'error', system: false, raw: 'x', messageOffset: 0 }])
    const source: SnapshotSource = { snapshot: () => SNAPSHOT }
    const overview = new Dashboard({ monitors: [source], store, isStoreFailing: () => false }).overview()
    assert.deepEqual(readOverview(JSON.parse(JSON.stringify(overview))), overview)
    const page = store.page({}, 10)
    assert.deepEqual(readLogPage(JSON.parse(JSON.stringify(page))), page)
    const cut = { ...page, nextBefore: 5 }
    assert.deepEqual(readLogPage(JSON.parse(JSON.stringify(cut))), cut)
  })

  it('names the field that has the wrong shape', () => {
    assert.throws(() => readOverview({ instances: 'none', logCounts: [], store: 'ok' }), new ShapeError('overview.instances is not a list'))
    const wrongState = { instances: [{ ...SNAPSHOT, api: { ...SNAPSHOT.api, state: 'asleep' } }], logCounts: [], store: 'ok' }
    assert.throws(() => readOverview(wrongState), /overview\.instances\[0\]\.api\.state is not one of/)
    assert.throws(() => readLogPage({ lines: [{ id: '1' }], hasMore: false, latestId: 1 }), new ShapeError('page.lines[0].id is not a number'))
  })
})

/** Enough of EventSource for LiveStream: listeners, readyState and close. */
class FakeEventSource extends EventTarget {
  static readonly CLOSED = 2
  static opened: FakeEventSource[] = []
  readonly url: string
  readyState = 1

  constructor(url: string) {
    super()
    this.url = url
    FakeEventSource.opened.push(this)
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED
  }

  send(type: string, data: string): void {
    this.dispatchEvent(new MessageEvent(type, { data }))
  }
}

const EMPTY: Overview = { instances: [], logCounts: [], store: 'ok' }
const LINE: LogLine = { id: 7, instance: 'example-1', ts: 1, plugin: null, level: 'info', message: 'x', system: false }

describe('LiveStream', () => {
  const timers: Array<() => void> = []
  const saved = { window: globalThis.window, EventSource: globalThis.EventSource, fetch: globalThis.fetch }
  let isServerUp = true
  let calls: string[] = []

  beforeEach(() => {
    FakeEventSource.opened = []
    timers.length = 0
    isServerUp = true
    calls = []
    Object.assign(globalThis, {
      EventSource: FakeEventSource,
      window: {
        setTimeout: (callback: () => void) => timers.push(callback),
        clearTimeout: () => undefined,
        location: { assign: () => undefined },
      },
      fetch: (): Promise<Response> => (isServerUp ? Promise.resolve(Response.json(EMPTY)) : Promise.reject(new TypeError('fetch failed'))),
    })
  })

  afterEach(() => {
    Object.assign(globalThis, saved)
  })

  function handlers(): StreamHandlers {
    return {
      onLines: (lines) => calls.push(`lines ${lines.map((line) => line.id).join(',')}`),
      onOverview: () => calls.push('overview'),
      onReset: () => calls.push('reset'),
      onStatus: (status) => calls.push(status),
      onBadEvent: (error) => calls.push(`bad ${error instanceof Error ? error.name : 'value'}`),
    }
  }

  async function runTimers(): Promise<void> {
    const due = timers.splice(0)
    due.forEach((callback) => callback())
    await new Promise((resolve) => setImmediate(resolve))
  }

  it('opens a new stream after the newest line it had, once the browser gives up and the server answers', async () => {
    new LiveStream(5, handlers())
    const first = FakeEventSource.opened[0]!
    assert.equal(first.url, '/api/stream?after=5')
    first.send('logs', JSON.stringify([LINE]))
    first.readyState = FakeEventSource.CLOSED
    first.dispatchEvent(new Event('error'))
    isServerUp = false
    await runTimers()
    assert.equal(FakeEventSource.opened.length, 1, 'not while the server is away')
    isServerUp = true
    await runTimers()
    assert.equal(FakeEventSource.opened[1]?.url, '/api/stream?after=7')
    assert.deepEqual(calls, ['lines 7', 'reconnecting'])
  })

  it('starts over after lines it cannot read, and reports an overview it cannot read', () => {
    new LiveStream(5, handlers())
    const source = FakeEventSource.opened[0]!
    source.send('logs', '{not json')
    source.send('overview', JSON.stringify({ instances: 'none' }))
    source.send('overview', JSON.stringify(EMPTY))
    assert.deepEqual(calls, ['bad SyntaxError', 'reset', 'bad ShapeError', 'overview'])
  })
})
