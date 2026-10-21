import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'

import type { Config } from '../src/server/config.ts'
import { hashPassword } from '../src/server/auth/password.ts'
import { startDashboard } from '../src/server/dashboard-server.ts'
import type { Overview } from '../src/shared/types.ts'
import { FAKE_PIN, FAKE_SETUP_URI, FakeHomebridge, homebridgeLine } from './helpers/fake-homebridge.ts'
import { fakeWebRoot, memoryLogger, tempDir, waitFor } from './helpers/util.ts'

const USER = 'example'
const PASSWORD = 'test-password-long'
const STAMP = '10/20/2026, 8:00:01 PM'

async function setup(t: { after: (fn: () => Promise<void> | void) => void }, overrides: Partial<Config> = {}) {
  const dir = tempDir(t)
  const homebridge = await new FakeHomebridge({ log: [homebridgeLine(STAMP, 'Example', 'Device offline', 'error')] }).start()
  const config: Config = {
    listen: { host: '127.0.0.1', port: 0 },
    dataDir: dir,
    retentionDays: 7,
    users: { [USER]: await hashPassword(PASSWORD) },
    cookieSecure: false,
    trustProxy: false,
    logLevel: 'debug',
    instances: [{ name: 'example-1', apiUrl: homebridge.url, uiUrl: 'https://example-1.example.com', username: homebridge.username, password: homebridge.password }],
    ...overrides,
  }
  const logger = memoryLogger()
  const running = await startDashboard(config, logger, {
    webRoot: fakeWebRoot(dir),
    intervals: { statusMs: 100, accessoriesMs: 100, pluginsMs: 100 },
    streamTiming: { replayQuietMs: 50 },
  })
  let isClosed = false
  const close = async (): Promise<void> => {
    if (!isClosed) {
      isClosed = true
      await running.close()
    }
  }
  t.after(async () => {
    await close()
    await homebridge.stop()
  })
  const base = `http://127.0.0.1:${running.port}`
  const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init })
  const login = async (password = PASSWORD, headers: Record<string, string> = {}, username = USER) => request('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ username, password }),
  })
  const signIn = async (username = USER): Promise<string> => {
    const cookie = (await login(PASSWORD, {}, username)).headers.get('set-cookie') ?? ''
    return cookie.split(';')[0] ?? ''
  }
  return { base, request, login, signIn, logger, homebridge, config, dir, close }
}

describe('dashboard HTTP', () => {
  it('sends a signed-out browser to the login page, and an API client gets a 401', async (t) => {
    const { request } = await setup(t)
    const page = await request('/')
    assert.equal(page.status, 303)
    assert.equal(page.headers.get('location'), '/login')
    assert.equal((await request('/login')).status, 200)
    const api = await request('/api/overview')
    assert.equal(api.status, 401)
    assert.deepEqual(await api.json(), { error: 'unauthenticated', message: 'Sign in again.' })
  })

  it('signs in with an HttpOnly, SameSite=Strict cookie and sets security headers', async (t) => {
    const { login, request, signIn } = await setup(t)
    const response = await login()
    assert.equal(response.status, 204)
    const cookie = response.headers.get('set-cookie') ?? ''
    assert.match(cookie, /^keystone_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/)
    const page = await request('/', { headers: { cookie: await signIn() } })
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'; script-src 'self'/)
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
  })

  it('adds Secure and HSTS when cookieSecure is on', async (t) => {
    const { login } = await setup(t, { cookieSecure: true })
    const response = await login()
    assert.match(response.headers.get('set-cookie') ?? '', /; Secure$/)
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000')
  })

  it('refuses a wrong password, a cross-site login, and too many tries', async (t) => {
    const { login, logger } = await setup(t)
    assert.equal((await login('wrong')).status, 401)
    assert.equal((await login(PASSWORD, { 'sec-fetch-site': 'cross-site' })).status, 403)
    for (let i = 0; i < 4; i++) {
      await login('wrong')
    }
    const locked = await login(PASSWORD)
    assert.equal(locked.status, 429)
    assert.ok(Number(locked.headers.get('retry-after')) > 0)
    assert.ok(logger.records.some((record) => record.msg === 'login failed'))
    assert.ok(!JSON.stringify(logger.records).includes(PASSWORD))
  })

  it('ignores X-Real-IP unless trustProxy is on, and then only when it is an address', async (t) => {
    const closed = await setup(t)
    for (let i = 0; i < 5; i++) {
      await closed.login('wrong', { 'x-real-ip': `192.0.2.${i + 1}` })
    }
    assert.equal((await closed.login(PASSWORD, { 'x-real-ip': '192.0.2.99' })).status, 429, 'the header did not spread the tries')

    const trusting = await setup(t, { trustProxy: true })
    for (let i = 0; i < 5; i++) {
      await trusting.login('wrong', { 'x-real-ip': '192.0.2.1' })
    }
    assert.equal((await trusting.login('wrong', { 'x-real-ip': '192.0.2.1' })).status, 429)
    assert.equal((await trusting.login(PASSWORD, { 'x-real-ip': '198.51.100.1' })).status, 204)
    assert.equal((await trusting.login(PASSWORD, { 'x-real-ip': 'not an address' })).status, 204)
  })

  it('refuses a login body that is too long or missing a field', async (t) => {
    const { login, request } = await setup(t)
    assert.equal((await login(PASSWORD, {}, 'a'.repeat(65))).status, 400)
    assert.equal((await login('p'.repeat(1025))).status, 400)
    assert.equal((await login('')).status, 400)
    const text = await request('/api/login', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })
    assert.equal(text.status, 400)
  })

  it('answers a wrong user name like a wrong password, and ignores the case of the name', async (t) => {
    const { login, logger } = await setup(t)
    const unknown = await login(PASSWORD, {}, 'someone-else')
    assert.equal(unknown.status, 401)
    assert.deepEqual(await unknown.json(), { error: 'invalid_login', message: 'That user name or password is not right.' })
    assert.ok(!JSON.stringify(logger.records).includes('someone-else'))
    assert.equal((await login(PASSWORD, {}, ' Example ')).status, 204)
    assert.ok(logger.records.some((record) => record.msg === 'login' && record.user === USER))
  })

  it('ends the sessions of a user who is no longer in the secrets file', async (t) => {
    const { request, signIn, config } = await setup(t)
    const cookie = await signIn()
    assert.equal((await request('/api/overview', { headers: { cookie } })).status, 200)
    config.users = {}
    assert.equal((await request('/api/overview', { headers: { cookie } })).status, 401)
  })

  it('ends the sessions of a user whose password changed', async (t) => {
    const { request, signIn, config } = await setup(t)
    const cookie = await signIn()
    config.users = { [USER]: await hashPassword('a-new-password-here') }
    assert.equal((await request('/api/overview', { headers: { cookie } })).status, 401)
  })

  it('sends a fresh cookie once a session has been renewed', async (t) => {
    const { request, signIn, dir } = await setup(t)
    const cookie = await signIn()
    const db = new DatabaseSync(join(dir, 'dashboard.sqlite'))
    db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() + 24 * 60 * 60_000)
    db.close()
    const renewed = await request('/api/overview', { headers: { cookie } })
    assert.equal(renewed.status, 200)
    const maxAge = Number(/Max-Age=(\d+)/.exec(renewed.headers.get('set-cookie') ?? '')?.[1])
    assert.ok(maxAge > 29 * 24 * 60 * 60, `Max-Age ${maxAge}`)
    assert.equal((await request('/api/overview', { headers: { cookie } })).headers.get('set-cookie'), null)
  })

  it('serves an overview with no PINs or setup codes in it', async (t) => {
    const { request, signIn } = await setup(t)
    const cookie = await signIn()
    const overview = await waitForOverview(request, cookie, (o) => o.instances[0]?.accessories !== null && o.instances[0]?.plugins.length !== 0)
    const text = JSON.stringify(overview)
    assert.ok(!text.includes(FAKE_PIN) && !text.includes(FAKE_SETUP_URI) && !text.includes('02:00:00:00:00:01'))
    const instance = overview.instances[0]!
    assert.equal(instance.api.state, 'connected')
    assert.equal(instance.homebridge?.version, '1.11.0')
    assert.deepEqual(instance.childBridges.map((b) => [b.name, b.status]), [['Camera Bridge', 'down'], ['Sensor Bridge', 'ok']])
    assert.equal(instance.accessories?.total, 3)
    assert.deepEqual(instance.accessories.lowBattery, [{ name: 'Front Door Sensor', level: 12 }])
    assert.equal(instance.accessoriesError, null)
    const { cpuLoad, networkReceive, networkTransmit } = instance.host ?? {}
    assert.deepEqual([cpuLoad, networkReceive, networkTransmit], [7.3, 1850000, 240000])
  })

  it('answers /healthz with only the status unless signed in, and 503 when degraded', async (t) => {
    const { request, signIn, homebridge } = await setup(t)
    const cookie = await signIn()
    await waitFor(async () => (await request('/healthz')).status === 200)
    assert.deepEqual(await (await request('/healthz')).json(), { status: 'ok' })
    assert.deepEqual(await (await request('/healthz', { headers: { cookie } })).json(), {
      status: 'ok', store: 'ok', instances: { 'example-1': { api: 'connected', logs: 'connected' } },
    })
    await homebridge.stop()
    const degraded = await waitFor(async () => {
      const response = await request('/healthz')
      return response.status === 503 && response
    }, 8000)
    assert.deepEqual(await degraded.json(), { status: 'degraded' })
  })

  it('answers HEAD like GET without a body, and 405 with Allow for a wrong method', async (t) => {
    const { request, signIn } = await setup(t)
    const cookie = await signIn()
    const head = await request('/', { method: 'HEAD', headers: { cookie } })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
    assert.equal((await request('/healthz', { method: 'HEAD' })).status, 200)
    const wrong = await request('/api/logs', { method: 'DELETE', headers: { cookie } })
    assert.equal(wrong.status, 405)
    assert.equal(wrong.headers.get('allow'), 'GET, HEAD')
    const streamHead = await request('/api/stream', { method: 'HEAD', headers: { cookie } })
    assert.equal(streamHead.status, 405)
    assert.equal(streamHead.headers.get('allow'), 'GET')
    assert.equal((await request('/api/login', { method: 'GET' })).headers.get('allow'), 'POST')
    assert.equal((await request('/main.js', { method: 'PUT' })).status, 405)
  })

  it('pages logs with filters and refuses a bad query', async (t) => {
    const { request, signIn } = await setup(t)
    const cookie = await signIn()
    const page = await waitFor(async () => {
      const body = await (await request('/api/logs?level=error', { headers: { cookie } })).json() as { lines: Array<{ plugin: string }> }
      return body.lines.length > 0 && body
    })
    assert.equal(page.lines[0]?.plugin, 'Example')
    assert.equal((await request('/api/logs?instance=nope', { headers: { cookie } })).status, 400)
    assert.equal((await request('/api/logs?limit=99999', { headers: { cookie } })).status, 400)
    assert.equal((await request(`/api/logs?q=${'x'.repeat(201)}`, { headers: { cookie } })).status, 400)
    assert.equal((await request('/api/logs?search=device', { headers: { cookie } })).status, 400)
    assert.equal((await request('/api/logs?level=warn&before=abc', { headers: { cookie } })).status, 400)
    const found = await (await request('/api/logs?q=DEVICE%20off', { headers: { cookie } })).json() as { lines: unknown[] }
    assert.equal(found.lines.length, 1)
    const missing = await (await request('/api/logs?q=no%20such%20text', { headers: { cookie } })).json() as { lines: unknown[] }
    assert.equal(missing.lines.length, 0)
  })

  it('streams new lines and resumes from Last-Event-ID', async (t) => {
    const { request, signIn, homebridge } = await setup(t)
    const cookie = await signIn()
    const events = await readStream(request, cookie, null, () => homebridge.append(homebridgeLine(STAMP, null, 'fresh line')), 'fresh line')
    assert.ok(events.includes('event: overview'))
    const lastId = /id: (\d+)/.exec(events)?.[1]
    assert.ok(lastId)
    homebridge.append(homebridgeLine(STAMP, null, 'while away'))
    await waitFor(async () => {
      const body = await (await request('/api/logs?q=while%20away', { headers: { cookie } })).json() as { lines: unknown[] }
      return body.lines.length > 0
    })
    const resumed = await readStream(request, cookie, lastId, () => undefined, 'while away')
    assert.ok(!resumed.includes('fresh line'))
  })

  it('signs out by revoking the session and ending its streams', async (t) => {
    const { request, signIn } = await setup(t)
    const cookie = await signIn()
    const stream = await request('/api/stream', { headers: { cookie } })
    const reader = stream.body!.getReader()
    assert.equal((await request('/api/logout', { method: 'POST', headers: { cookie } })).status, 204)
    assert.equal((await request('/api/overview', { headers: { cookie } })).status, 401)
    for (;;) {
      const { done } = await reader.read()
      if (done) {
        break
      }
    }
  })

  it('serves built assets by ETag and nothing outside them', async (t) => {
    const { request } = await setup(t)
    const asset = await request('/main.js')
    assert.equal(asset.status, 200)
    const etag = asset.headers.get('etag') ?? ''
    assert.equal((await request('/main.js', { headers: { 'if-none-match': etag } })).status, 304)
    assert.equal((await request('/../package.json')).status, 404)
    assert.equal((await request('/index.html')).status, 404)
  })

  it('stops cleanly and refuses new connections afterwards', async (t) => {
    const { request, close } = await setup(t)
    await close()
    await assert.rejects(request('/healthz'))
  })
})

type Request = (path: string, init?: RequestInit) => Promise<Response>

async function waitForOverview(request: Request, cookie: string, ready: (overview: Overview) => boolean): Promise<Overview> {
  return waitFor(async () => {
    const overview = await (await request('/api/overview', { headers: { cookie } })).json() as Overview
    return ready(overview) && overview
  })
}

/** Read the event stream until `until` shows up, calling `act` once the stream is open. */
async function readStream(request: Request, cookie: string, lastId: string | null, act: () => void, until: string): Promise<string> {
  const controller = new AbortController()
  const headers: Record<string, string> = { cookie }
  if (lastId) {
    headers['last-event-id'] = lastId
  }
  const response = await request('/api/stream', { headers, signal: controller.signal })
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  const reader = response.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const decoder = new TextDecoder()
  let text = ''
  act()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    while (!text.includes(until)) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      text += decoder.decode(value)
    }
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
  return text
}
