import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { dayNumber, HeldLines, inLogOrder, isBefore } from '../src/web/log-order.ts'

describe('log order', () => {
  it('orders by time, then by id', () => {
    assert.equal(isBefore({ ts: 1, id: 9 }, { ts: 2, id: 1 }), true)
    assert.equal(isBefore({ ts: 2, id: 1 }, { ts: 2, id: 2 }), true)
    assert.equal(isBefore({ ts: 2, id: 2 }, { ts: 2, id: 2 }), false)
    const sorted = inLogOrder([{ ts: 3, id: 1 }, { ts: 1, id: 3 }, { ts: 1, id: 2 }])
    assert.deepEqual(sorted.map((line) => line.id), [2, 3, 1])
  })

  it('numbers local days so they sort', () => {
    assert.equal(dayNumber(new Date(2026, 9, 20, 23, 59).getTime()), 20261020)
    assert.ok(dayNumber(new Date(2026, 11, 31).getTime()) < dayNumber(new Date(2027, 0, 1).getTime()))
  })
})

describe('HeldLines', () => {
  it('gives back what it held, once', () => {
    const held = new HeldLines<number>(5)
    held.add([1, 2])
    held.add([3])
    assert.deepEqual(held.take(), [1, 2, 3])
    assert.deepEqual(held.take(), [])
  })

  it('keeps nothing once it passes its limit, until it is taken or cleared', () => {
    const held = new HeldLines<number>(3)
    held.add([1, 2, 3, 4])
    assert.equal(held.overflowed, true)
    held.add([5])
    assert.deepEqual(held.take(), [])
    assert.equal(held.overflowed, false)
    held.add([6])
    held.clear()
    assert.deepEqual(held.take(), [])
  })
})
