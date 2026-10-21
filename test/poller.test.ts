import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { AUTH_RETRY_MS, HomebridgeApiError } from '../src/server/homebridge/api-client.ts'
import { Backoff } from '../src/server/homebridge/backoff.ts'
import { Poller } from '../src/server/homebridge/poller.ts'

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('Backoff', () => {
  it('doubles its cap up to the maximum and starts again after a reset', () => {
    const backoff = new Backoff({ baseMs: 1000, maxMs: 5000, random: () => 1 })
    assert.deepEqual([backoff.next(), backoff.next(), backoff.next(), backoff.next()], [1000, 2000, 4000, 5000])
    backoff.reset()
    assert.equal(backoff.next(), 1000)
  })

  it('never waits less than half the base by default, or than minMs', () => {
    assert.equal(new Backoff({ baseMs: 1000, random: () => 0 }).next(), 500)
    assert.equal(new Backoff({ baseMs: 1000, minMs: 1000, random: () => 0 }).next(), 1000)
    assert.equal(new Backoff({ baseMs: 1000, random: () => 0.75 }).next(), 750)
  })
})

describe('Poller', () => {
  it('waits the interval after a success, longer after each failure, and resets on success', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let calls = 0
    let failure: Error | null = null
    const errors: unknown[] = []
    const poller = new Poller({
      intervalMs: 1000,
      task: () => {
        calls++
        return failure ? Promise.reject(failure) : Promise.resolve()
      },
      onError: (error) => errors.push(error),
      random: () => 1,
    })
    t.after(() => poller.stop())
    const callsAfter = async (ms: number): Promise<number> => {
      t.mock.timers.tick(ms)
      await settle()
      return calls
    }
    poller.start()
    await settle()
    assert.equal(calls, 1)
    assert.equal(await callsAfter(999), 1)
    assert.equal(await callsAfter(1), 2)

    failure = new HomebridgeApiError('unreachable', 'connection failed')
    assert.equal(await callsAfter(1000), 3, 'first failure')
    assert.equal(await callsAfter(1000), 4, 'waited 1 s')
    assert.equal(await callsAfter(1999), 4)
    assert.equal(await callsAfter(1), 5, 'waited 2 s')
    assert.equal(await callsAfter(4000), 6, 'waited 4 s')
    assert.equal(await callsAfter(5999), 6, 'capped at six intervals')
    assert.equal(await callsAfter(1), 7)

    failure = null
    assert.equal(await callsAfter(6000), 8, 'succeeds')
    assert.equal(await callsAfter(1000), 9, 'back to the interval')
    assert.equal(errors.length, 5)
  })

  it('waits AUTH_RETRY_MS after a rejected login, and stops for good', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let calls = 0
    const poller = new Poller({
      intervalMs: 1000,
      task: () => {
        calls++
        return Promise.reject(new HomebridgeApiError('unauthorized', 'login rejected'))
      },
      onError: () => undefined,
    })
    poller.start()
    await settle()
    t.mock.timers.tick(AUTH_RETRY_MS - 1)
    await settle()
    assert.equal(calls, 1)
    t.mock.timers.tick(1)
    await settle()
    assert.equal(calls, 2)
    poller.stop()
    t.mock.timers.tick(AUTH_RETRY_MS * 2)
    await settle()
    assert.equal(calls, 2)
  })
})
