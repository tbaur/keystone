import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isUiBanner, replayStart } from '../src/server/logs/replay.ts'

const lines = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`)

describe('replayStart', () => {
  it('stores the whole replay when nothing is stored yet', () => {
    assert.equal(replayStart([], lines(1, 5)), 0)
  })

  it('skips the lines already stored', () => {
    assert.equal(replayStart(lines(1, 10), lines(4, 13)), 7)
  })

  it('skips everything when nothing is new', () => {
    assert.equal(replayStart(lines(1, 10), lines(6, 10)), 5)
  })

  it('stores the whole replay when it does not overlap', () => {
    assert.equal(replayStart(lines(1, 10), lines(20, 30)), 0)
  })

  it('finds the overlap after a partial first line', () => {
    const replay = ['ne 7 (cut off)', ...lines(8, 12)]
    assert.equal(replayStart(lines(1, 10), replay), 4)
  })

  it('picks the place that matches furthest back when lines repeat', () => {
    const stored = ['a', 'b', 'tick', 'tick', 'tick']
    const replay = ['a', 'b', 'tick', 'tick', 'tick', 'tick', 'tick']
    assert.equal(replayStart(stored, replay), 5)
  })

  it('on a tie, prefers the match that used every stored line it could compare', () => {
    assert.equal(replayStart(['y', 'a', 'b', 'c'], ['a', 'b', 'c', 'x', 'a', 'b', 'c']), 3)
  })

  it('on a tie of two whole matches, takes the later one', () => {
    assert.equal(replayStart(['a', 'b', 'c'], ['a', 'b', 'c', 'a', 'b', 'c', 'new']), 6)
  })

  it('needs three matching lines before it trusts an overlap', () => {
    assert.equal(replayStart(['x', 'y', 'same'], ['q', 'same', 'new']), 0)
  })
})

describe('isUiBanner', () => {
  it('knows the lines that Homebridge UI prints before the log', () => {
    assert.ok(isUiBanner('Loading logs using native method...'))
    assert.ok(isUiBanner('File: /home/user/.homebridge/homebridge.log'))
    assert.ok(isUiBanner('CMD: tail -n 500 -f /home/user/.homebridge/homebridge.log'))
    assert.ok(isUiBanner(''))
    assert.ok(!isUiBanner('[10/20/2026, 8:05:09 PM] Homebridge is running'))
  })
})
