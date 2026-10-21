import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { AUTH_RETRY_MS, HomebridgeApi, HomebridgeApiError } from '../src/server/homebridge/api-client.ts'

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

function fakeFetch(handler: Handler): { fetch: typeof fetch, calls: string[] } {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
    return handler(url, init ?? {})
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status })
const loginOk = (token: string): Response => json(201, { access_token: token, expires_in: 28800 })

describe('HomebridgeApi', () => {
  it('logs in once and reuses the token', async () => {
    const { fetch, calls } = fakeFetch((url) => (url.endsWith('/auth/login') ? loginOk('t1') : json(200, { ok: true })))
    const api = new HomebridgeApi({ baseUrl: 'http://127.0.0.1:8581', username: 'example', password: 'test-password', fetch })
    await api.get('/status/cpu')
    await api.get('/status/ram')
    assert.deepEqual(calls, ['POST /api/auth/login', 'GET /api/status/cpu', 'GET /api/status/ram'])
  })

  it('logs in again once after a 401, then succeeds', async () => {
    let tokens = 0
    const { fetch, calls } = fakeFetch((url, init) => {
      if (url.endsWith('/auth/login')) {
        return loginOk(`t${++tokens}`)
      }
      const auth = new Headers(init.headers).get('authorization')
      return auth === 'Bearer t2' ? json(200, { ok: true }) : json(401, {})
    })
    const api = new HomebridgeApi({ baseUrl: 'http://127.0.0.1:8581', username: 'example', password: 'test-password', fetch })
    assert.deepEqual(await api.get('/status/cpu'), { ok: true })
    assert.deepEqual(calls, ['POST /api/auth/login', 'GET /api/status/cpu', 'POST /api/auth/login', 'GET /api/status/cpu'])
  })

  it('reports a rejected login as unauthorized', async () => {
    const { fetch } = fakeFetch(() => json(401, {}))
    const api = new HomebridgeApi({ baseUrl: 'http://127.0.0.1:8581', username: 'example', password: 'wrong', fetch })
    await assert.rejects(api.get('/status/cpu'), (error: unknown) => error instanceof HomebridgeApiError && error.kind === 'unauthorized')
  })

  it('reports a timeout as unreachable', async () => {
    const { fetch } = fakeFetch((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })))
    }))
    const api = new HomebridgeApi({ baseUrl: 'http://127.0.0.1:8581', username: 'example', password: 'test-password', fetch, timeoutMs: 20 })
    await assert.rejects(api.get('/status/cpu'), (error: unknown) => {
      return error instanceof HomebridgeApiError && error.kind === 'unreachable' && error.message === 'no answer within 20 ms'
    })
  })

  it('shares one login between calls that start together', async () => {
    const { fetch, calls } = fakeFetch((url) => (url.endsWith('/auth/login') ? loginOk('t1') : json(200, {})))
    const api = new HomebridgeApi({ baseUrl: 'http://127.0.0.1:8581', username: 'example', password: 'test-password', fetch })
    await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')])
    assert.equal(calls.filter((call) => call.includes('login')).length, 1)
  })

  it('does not try a rejected login again until AUTH_RETRY_MS has passed', async () => {
    let now = 0
    const { fetch, calls } = fakeFetch(() => json(429, {}))
    const api = new HomebridgeApi({ baseUrl: 'http://127.0.0.1:8581', username: 'example', password: 'wrong', fetch, now: () => now })
    await assert.rejects(api.get('/a'), /refusing logins after too many failures/)
    now = AUTH_RETRY_MS - 1
    await assert.rejects(api.get('/a'), (error: unknown) => error instanceof HomebridgeApiError && error.kind === 'unauthorized')
    assert.equal(calls.length, 1)
    now = AUTH_RETRY_MS
    await assert.rejects(api.get('/a'))
    assert.equal(calls.length, 2)
  })

  it('renews the token before it expires', async () => {
    let now = 0
    let tokens = 0
    const { fetch, calls } = fakeFetch((url) => (url.endsWith('/auth/login') ? json(201, { access_token: `t${++tokens}`, expires_in: 600 }) : json(200, {})))
    const api = new HomebridgeApi({ baseUrl: 'http://127.0.0.1:8581', username: 'example', password: 'test-password', fetch, now: () => now })
    assert.equal(await api.accessToken(), 't1')
    now = 299_000
    assert.equal(await api.accessToken(), 't1')
    now = 300_000
    assert.equal(await api.accessToken(), 't2', 'halfway through a 10-minute token')
    assert.equal(calls.length, 2)
  })

  it('forgets only the token that was rejected', async () => {
    let tokens = 0
    const { fetch } = fakeFetch(() => loginOk(`t${++tokens}`))
    const api = new HomebridgeApi({ baseUrl: 'http://127.0.0.1:8581', username: 'example', password: 'test-password', fetch })
    assert.equal(await api.accessToken(), 't1')
    api.invalidate('t1')
    assert.equal(await api.accessToken(), 't2')
    api.invalidate('t1')
    assert.equal(await api.accessToken(), 't2')
  })

  it('refuses to follow a redirect, so the password never goes elsewhere', async () => {
    const { fetch } = fakeFetch((_url, init) => {
      assert.equal(init.redirect, 'manual')
      return new Response(null, { status: 302, headers: { location: 'https://example.net/' } })
    })
    const api = new HomebridgeApi({ baseUrl: 'http://127.0.0.1:8581', username: 'example', password: 'test-password', fetch })
    await assert.rejects(api.get('/a'), (error: unknown) => error instanceof HomebridgeApiError && error.kind === 'http' && error.status === 302)
  })

  it('keeps the network error as the cause, and reports a body that is not JSON', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const down = new HomebridgeApi({
      baseUrl: 'http://127.0.0.1:8581', username: 'example', password: 'test-password',
      fetch: fakeFetch(() => Promise.reject(new TypeError('fetch failed', { cause: refused }))).fetch,
    })
    await assert.rejects(down.get('/a'), (error: unknown) => error instanceof HomebridgeApiError && error.message === 'connection failed' && error.cause instanceof TypeError)
    const { fetch } = fakeFetch((url) => (url.endsWith('/auth/login') ? loginOk('t1') : new Response('<html>', { status: 200 })))
    const api = new HomebridgeApi({ baseUrl: 'http://127.0.0.1:8581', username: 'example', password: 'test-password', fetch })
    await assert.rejects(api.get('/a'), (error: unknown) => error instanceof HomebridgeApiError && error.kind === 'invalid')
  })
})
