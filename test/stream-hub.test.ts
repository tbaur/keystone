import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { describe, it } from 'node:test'

import { StreamHub } from '../src/server/http/stream-hub.ts'
import { openDatabase } from '../src/server/store/database.ts'
import { LogStore, type NewLogLine } from '../src/server/store/log-store.ts'
import type { Overview } from '../src/shared/types.ts'
import { memoryLogger, waitFor } from './helpers/util.ts'

/** Enough of a ServerResponse for the hub. */
class FakeResponse extends EventEmitter {
  status = 0
  writableLength = 0
  isEnded = false
  isDestroyed = false
  private readonly chunks: string[] = []

  get text(): string {
    return this.chunks.join('')
  }

  writeHead(status: number): this {
    this.status = status
    return this
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }

  end(): void {
    this.isEnded = true
    this.emit('close')
  }

  destroy(): void {
    this.isDestroyed = true
    this.emit('close')
  }

  events(name: string): number {
    return this.text.split('\n').filter((textLine) => textLine === `event: ${name}`).length
  }
}

const EMPTY: Overview = { instances: [], logCounts: [] }

function setup(t: { after: (fn: () => void) => void }, overview: () => Overview = () => EMPTY, heartbeatMs = 60_000) {
  const store = new LogStore(openDatabase(':memory:'))
  const logger = memoryLogger()
  const hub = new StreamHub({ store, logger, overview, heartbeatMs, overviewDebounceMs: 10 })
  t.after(() => hub.close())
  const open = (afterId: number | null = null, isAllowed = (): boolean => true): FakeResponse => {
    const res = new FakeResponse()
    hub.open(res as unknown as ServerResponse, afterId, isAllowed)
    return res
  }
  return { store, logger, hub, open }
}

function lines(count: number): NewLogLine[] {
  return Array.from({ length: count }, (_, i) => ({
    instance: 'example-1', ts: i, receivedAt: i, plugin: null, level: 'info' as const, system: false, raw: `line ${i}`, messageOffset: 0,
  }))
}

describe('StreamHub', () => {
  it('opens with the retry time and the overview, then sends new lines with their id', (t) => {
    const { hub, open, store } = setup(t)
    const res = open()
    assert.equal(res.status, 200)
    assert.match(res.text, /^retry: 3000\n\nevent: overview\n/)
    const stored = store.append(lines(2))
    hub.publishLines(stored)
    assert.match(res.text, new RegExp(`id: ${stored[1]?.id}\nevent: logs\n`))
  })

  it('sends the lines that a returning client missed, or a reset when it is too far behind', (t) => {
    const { open, store } = setup(t)
    const stored = store.append(lines(1200))
    const resumed = open(stored[0]!.id)
    assert.equal(resumed.events('logs'), 3, '1199 lines in chunks of 500')
    assert.ok(!resumed.text.includes('"line 0"'))
    store.append(lines(5000))
    const behind = open(stored[0]!.id)
    assert.equal(behind.events('reset'), 1)
    assert.equal(behind.events('logs'), 0)
  })

  it('drops a client that has stopped reading', (t) => {
    const { hub, open, store, logger } = setup(t)
    const slow = open()
    const fine = open()
    slow.writableLength = 5 * 1024 * 1024
    hub.publishLines(store.append(lines(1)))
    assert.equal(slow.isDestroyed, true)
    assert.equal(fine.events('logs'), 1)
    assert.ok(logger.records.some((record) => record.msg === 'dropping a stream client that is not reading'))
  })

  it('ends the streams of sessions that have ended, on request and on the heartbeat', async (t) => {
    let isAllowed = true
    const { hub, open } = setup(t, () => EMPTY, 20)
    const ended = open(null, () => false)
    const kept = open(null, () => isAllowed)
    hub.closeEndedSessions()
    assert.equal(ended.isEnded, true)
    assert.equal(kept.isEnded, false)
    isAllowed = false
    await waitFor(() => kept.isEnded)
  })

  it('sends one overview for a burst of changes, and survives an overview that throws', async (t) => {
    let shouldThrow = false
    const { hub, open, logger } = setup(t, () => {
      if (shouldThrow) throw new Error('boom')
      return EMPTY
    })
    const res = open()
    hub.overviewChanged()
    hub.overviewChanged()
    hub.overviewChanged()
    await waitFor(() => res.events('overview') === 2)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(res.events('overview'), 2)
    shouldThrow = true
    hub.overviewChanged()
    await waitFor(() => logger.records.some((record) => record.msg === 'could not send the overview'))
  })
})
