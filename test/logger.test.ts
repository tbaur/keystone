import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { HomebridgeApiError } from '../src/server/homebridge/api-client.ts'
import { createLogger } from '../src/server/logger.ts'

function capture(level: 'debug' | 'info' = 'info'): { lines: Array<Record<string, unknown>>, logger: ReturnType<typeof createLogger> } {
  const lines: Array<Record<string, unknown>> = []
  return { lines, logger: createLogger({ level, write: (text) => lines.push(JSON.parse(text) as Record<string, unknown>) }) }
}

describe('createLogger', () => {
  it('writes the time, level and message first, and fields cannot replace them', () => {
    const { lines, logger } = capture()
    logger.child({ instance: 'example-1', level: 'fake' }).warn('hello', { msg: 'other', time: 'never', extra: 1 })
    const record = lines[0] ?? {}
    assert.deepEqual(Object.keys(record).slice(0, 3), ['time', 'level', 'msg'])
    assert.equal(record.level, 'warn')
    assert.equal(record.msg, 'hello')
    assert.notEqual(record.time, 'never')
    assert.equal(record.instance, 'example-1')
    assert.equal(record.extra, 1)
  })

  it('leaves out levels below the minimum', () => {
    const { lines, logger } = capture()
    logger.debug('quiet')
    logger.info('loud')
    assert.deepEqual(lines.map((line) => line.msg), ['loud'])
  })

  it('logs an expected error without a stack, with its kind, status and cause', () => {
    const { lines, logger } = capture()
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    logger.warn('down', { error: new HomebridgeApiError('unreachable', 'connection failed', { cause, status: 502 }) })
    assert.deepEqual(lines[0]?.error, {
      name: 'HomebridgeApiError', message: 'connection failed', kind: 'unreachable', status: 502,
      cause: { name: 'Error', message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' },
    })
  })

  it('logs an unexpected error with its stack, and stops following causes after three', () => {
    const { lines, logger } = capture()
    let error = new Error('level 5')
    for (let level = 4; level >= 1; level--) {
      error = new Error(`level ${level}`, { cause: error })
    }
    logger.error('broken', { error })
    const logged = (lines[0] ?? {}).error as Record<string, unknown>
    assert.equal(typeof logged.stack, 'string')
    let depth = 0
    let current = logged
    while (current.cause) {
      current = current.cause as Record<string, unknown>
      assert.equal(current.stack, undefined)
      depth++
    }
    assert.equal(depth, 3)
  })
})
