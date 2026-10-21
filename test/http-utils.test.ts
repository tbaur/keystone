import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'

import { BadRequest, clientAddress, isSameOrigin, parseCookies, readJson } from '../src/server/http/http-utils.ts'

function request(headers: Record<string, string>, remoteAddress = '127.0.0.1', body: string[] = []): IncomingMessage {
  const req = Readable.from(body.map((chunk) => Buffer.from(chunk))) as unknown as IncomingMessage
  return Object.assign(req, { headers, socket: { remoteAddress } })
}

describe('clientAddress', () => {
  it('uses X-Real-IP only from loopback, with trustProxy on, when it is an address', () => {
    assert.equal(clientAddress(request({ 'x-real-ip': '192.0.2.1' }), true), '192.0.2.1')
    assert.equal(clientAddress(request({ 'x-real-ip': ' 2001:db8::1 ' }, '::1'), true), '2001:db8::1')
    assert.equal(clientAddress(request({ 'x-real-ip': '192.0.2.1' }), false), '127.0.0.1')
    assert.equal(clientAddress(request({ 'x-real-ip': '192.0.2.1' }, '198.51.100.7'), true), '198.51.100.7')
    assert.equal(clientAddress(request({ 'x-real-ip': 'anything-at-all' }), true), '127.0.0.1')
    assert.equal(clientAddress(request({ 'x-real-ip': '192.0.2.1, 192.0.2.2' }), true), '127.0.0.1')
  })
})

describe('isSameOrigin', () => {
  it('allows same-origin and direct requests and refuses the rest', () => {
    assert.equal(isSameOrigin(request({})), true)
    assert.equal(isSameOrigin(request({ 'sec-fetch-site': 'same-origin' })), true)
    assert.equal(isSameOrigin(request({ 'sec-fetch-site': 'none' })), true)
    assert.equal(isSameOrigin(request({ 'sec-fetch-site': 'same-site' })), false)
    assert.equal(isSameOrigin(request({ 'sec-fetch-site': 'cross-site' })), false)
  })
})

describe('parseCookies', () => {
  it('reads name=value pairs and skips anything else', () => {
    const cookies = parseCookies(' a=1; b = two ;junk; =x; c=with=equals')
    assert.deepEqual([...cookies], [['a', '1'], ['b', 'two'], ['c', 'with=equals']])
    assert.equal(parseCookies(undefined).size, 0)
  })
})

describe('readJson', () => {
  it('reads a small JSON body', async () => {
    assert.deepEqual(await readJson(request({ 'content-type': 'application/json; charset=utf-8' }, '127.0.0.1', ['{"a":', '1}'])), { a: 1 })
  })

  it('refuses another type, a large body and bad JSON', async () => {
    await assert.rejects(readJson(request({ 'content-type': 'text/plain' }, '127.0.0.1', ['{}'])), BadRequest)
    await assert.rejects(readJson(request({ 'content-type': 'application/json' }, '127.0.0.1', ['x'.repeat(5000)])), /body too large/)
    await assert.rejects(readJson(request({ 'content-type': 'application/json' }, '127.0.0.1', ['{nope'])), /not JSON/)
  })
})
