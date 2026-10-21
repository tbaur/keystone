import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { HiddenLine } from '../src/server/cli/hidden-line.ts'

describe('HiddenLine', () => {
  it('collects an answer across chunks and keeps what was typed after Enter', () => {
    const line = new HiddenLine()
    assert.equal(line.feed('sec'), null)
    assert.deepEqual(line.feed('ret\r\nnext'), { value: 'secret', rest: 'next' })
  })

  it('handles backspace, including across multi-byte characters', () => {
    assert.deepEqual(new HiddenLine().feed('abx\u007fc😀\b\n'), { value: 'abc', rest: '' })
  })

  it('skips arrow keys, other escape sequences and control characters', () => {
    assert.deepEqual(new HiddenLine().feed('a\u001b[Ab\u001b[1;5Cc\u001bOPd\u0001e\u001bxf\n'), { value: 'abcdef', rest: '' })
  })

  it('skips an escape sequence split across chunks', () => {
    const line = new HiddenLine()
    assert.equal(line.feed('a\u001b'), null)
    assert.equal(line.feed('[1;'), null)
    assert.deepEqual(line.feed('5Db\n'), { value: 'ab', rest: '' })
  })

  it('cancels on Ctrl-C and Ctrl-D', () => {
    assert.equal(new HiddenLine().feed('abc\u0003'), 'cancel')
    assert.equal(new HiddenLine().feed('\u0004'), 'cancel')
  })
})
