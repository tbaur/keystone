import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { LogPipeline } from '../src/server/logs/pipeline.ts'
import type { LogStore, NewLogLine } from '../src/server/store/log-store.ts'
import type { LogLine } from '../src/shared/types.ts'
import { memoryLogger } from './helpers/util.ts'

function line(raw: string): NewLogLine {
  return { instance: 'example-1', ts: 0, receivedAt: 0, plugin: null, level: 'info', system: false, raw, messageOffset: 0 }
}

/** A store whose writes fail while `failing` is set. */
function fakeStore(): { store: LogStore, written: string[], failing: { on: boolean } } {
  const written: string[] = []
  const failing = { on: false }
  let id = 0
  const store = {
    append(lines: readonly NewLogLine[]): LogLine[] {
      if (failing.on) {
        throw new Error('disk I/O error')
      }
      written.push(...lines.map((l) => l.raw))
      return lines.map((l) => ({ id: ++id, instance: l.instance, ts: l.ts, plugin: l.plugin, level: l.level, message: l.raw, system: l.system }))
    },
  }
  return { store: store as unknown as LogStore, written, failing }
}

describe('LogPipeline', () => {
  it('writes a burst in one batch and hands on the stored lines', () => {
    const { store, written } = fakeStore()
    const stored: LogLine[][] = []
    const pipeline = new LogPipeline({ store, logger: memoryLogger(), onStored: (lines) => stored.push(lines), flushMs: 10_000 })
    pipeline.push([line('a'), line('b')])
    pipeline.push([line('c')])
    pipeline.flush()
    assert.deepEqual(written, ['a', 'b', 'c'])
    assert.equal(stored.length, 1)
    assert.deepEqual(stored[0]?.map((l) => l.id), [1, 2, 3])
  })

  it('drops lines past maxPending and says how many', () => {
    const { store, written } = fakeStore()
    const logger = memoryLogger()
    const pipeline = new LogPipeline({ store, logger, onStored: () => undefined, flushMs: 10_000, maxPending: 2 })
    pipeline.push([line('a'), line('b'), line('c')])
    pipeline.push([line('d')])
    pipeline.flush()
    assert.deepEqual(written, ['a', 'b'])
    assert.equal(logger.records.find((record) => record.level === 'warn')?.dropped, 2)
  })

  it('reports a failing store once a minute with the lines lost, then its recovery', () => {
    const { store, failing } = fakeStore()
    const logger = memoryLogger()
    let now = 0
    const pipeline = new LogPipeline({ store, logger, onStored: () => undefined, flushMs: 10_000, now: () => now })
    failing.on = true
    for (let i = 0; i < 5; i++) {
      now = i * 20_000
      pipeline.push([line(`lost ${i}`)])
      pipeline.flush()
    }
    assert.equal(pipeline.isFailing, true)
    const errors = logger.records.filter((record) => record.msg === 'could not store log lines')
    assert.deepEqual(errors.map((record) => record.lost), [1, 4])
    failing.on = false
    pipeline.push([line('kept')])
    pipeline.flush()
    assert.equal(pipeline.isFailing, false)
    assert.equal(logger.records.find((record) => record.msg === 'log lines stored again')?.lost, 5)
  })
})
