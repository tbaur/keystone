import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ConnectionState } from '../src/shared/types.ts'
import { HomebridgeApi } from '../src/server/homebridge/api-client.ts'
import { LogStream } from '../src/server/homebridge/log-stream.ts'
import { stripAnsiText } from '../src/server/logs/line-parser.ts'
import { openDatabase } from '../src/server/store/database.ts'
import { LogStore } from '../src/server/store/log-store.ts'
import { FakeHomebridge, homebridgeLine, type FakeHomebridgeOptions } from './helpers/fake-homebridge.ts'
import { memoryLogger, waitFor } from './helpers/util.ts'

const TIMING = { replayQuietMs: 50, replayMaxMs: 1000, connectTimeoutMs: 1000 }
/** A whole second a little before the test runs, so stamped times are close to arrival. */
const BASE = Math.floor(Date.now() / 1000) * 1000 - 60_000

/** How Homebridge on a US-English host in `timeZone` stamps a line written `second` seconds after BASE. */
function at(second: number, timeZone = 'UTC'): string {
  return new Date(BASE + second * 1000).toLocaleString('en-US', { timeZone })
}

async function setup(t: { after: (fn: () => Promise<void> | void) => void }, log: string[], options: FakeHomebridgeOptions = {}) {
  const homebridge = await new FakeHomebridge({ log, ...options }).start()
  const store = new LogStore(openDatabase(':memory:'))
  const states: ConnectionState[] = []
  const errors: string[] = []
  const api = new HomebridgeApi({ baseUrl: homebridge.url, username: homebridge.username, password: homebridge.password })
  const stream = new LogStream({
    instance: 'example-1', api, logger: memoryLogger(), timing: TIMING, random: () => 0,
    recentLines: () => store.recentPlain('example-1', 2000),
    onLines: (lines) => store.append(lines),
    onState: (state, error) => {
      states.push(state)
      if (error) errors.push(error)
    },
  })
  t.after(async () => {
    stream.stop()
    await homebridge.stop()
  })
  const messages = (): string[] => store.after(0, 1000).map((line) => stripAnsiText(line.message))
  return { homebridge, store, stream, states, errors, messages }
}

describe('LogStream', () => {
  it('stores the replay without the UI banner or blank lines, then live lines', async (t) => {
    const { homebridge, stream, states, messages } = await setup(t, [
      homebridgeLine(at(1), null, 'Homebridge is running'),
      '',
      '\u001b[39m  ',
      homebridgeLine(at(2), 'Example', 'Device offline', 'error'),
    ])
    stream.start()
    await waitFor(() => messages().length === 2)
    homebridge.append(homebridgeLine(at(3), 'Example', 'Device online'))
    await waitFor(() => messages().length === 3)
    assert.deepEqual(messages(), ['Homebridge is running', 'Device offline', 'Device online'])
    assert.ok(states.includes('connected'))
  })

  it('reads log times in the time zone that Homebridge UI reports', async (t) => {
    const zone = 'Asia/Kolkata'
    const { stream, store } = await setup(t, [homebridgeLine(at(1, zone), 'Example', 'hello')], { timeZone: zone })
    stream.start()
    const [line] = await waitFor(() => store.after(0, 10).length === 1 && store.after(0, 10))
    assert.equal(line?.ts, BASE + 1000)
  })

  it('drops the cut-off line that a first replay starts with', async (t) => {
    const cut = homebridgeLine(at(1), 'Example', 'cut off').slice(12)
    const { stream, messages } = await setup(t, [cut, homebridgeLine(at(2), 'Example', 'whole')])
    stream.start()
    await waitFor(() => messages().length > 0)
    assert.deepEqual(messages(), ['whole'])
  })

  it('stores only the missed lines after a reconnect, between system lines', async (t) => {
    const { homebridge, stream, store, messages } = await setup(t, [1, 2, 3, 4].map((s) => homebridgeLine(at(s), 'Example', `line ${s}`)))
    stream.start()
    await waitFor(() => messages().length === 4)
    homebridge.dropLogSockets()
    homebridge.append(homebridgeLine(at(5), 'Example', 'line 5'))
    await waitFor(() => messages().includes('Log stream reconnected'), 8000)
    assert.deepEqual(messages(), ['line 1', 'line 2', 'line 3', 'line 4', 'Log stream lost (io server disconnect); reconnecting', 'line 5', 'Log stream reconnected'])
    const system = store.page({}, 100).lines.filter((line) => line.system)
    assert.deepEqual(system.map((line) => line.level), ['warn', 'info'])
  })

  it('says it reconnected even when the log is empty', async (t) => {
    const { homebridge, stream, states, messages } = await setup(t, [])
    stream.start()
    await waitFor(() => states.includes('connected'))
    homebridge.dropLogSockets()
    await waitFor(() => messages().includes('Log stream reconnected'), 8000)
  })

  it('logs in again when Homebridge forgets its tokens', async (t) => {
    const { homebridge, stream, messages } = await setup(t, [homebridgeLine(at(1), null, 'start')])
    stream.start()
    await waitFor(() => messages().length === 1)
    const logins = homebridge.logins
    homebridge.revokeTokens()
    homebridge.dropLogSockets()
    await waitFor(() => homebridge.logins > logins, 8000)
    homebridge.append(homebridgeLine(at(2), null, 'after'))
    await waitFor(() => messages().includes('after'), 8000)
  })

  it('names the likely setting when the log is refused twice in a row', async (t) => {
    const { homebridge, stream, states, errors } = await setup(t, [homebridgeLine(at(1), null, 'start')])
    homebridge.logsRestricted = true
    stream.start()
    await waitFor(() => states.includes('unauthorized'), 8000)
    assert.equal(states.filter((state) => state === 'unreachable').length, 1)
    assert.match(errors.at(-1) ?? '', /restrictLogsToAdmins/)
  })

  it('gives up on a socket that connects but never sends anything', async (t) => {
    const { homebridge, stream, states, errors } = await setup(t, [])
    homebridge.logsSilent = true
    stream.start()
    await waitFor(() => states.includes('unreachable'), 5000)
    assert.ok(!states.includes('connected'))
    assert.equal(errors[0], 'no log data')
  })

  it('reports a wrong password as unauthorized', async (t) => {
    const homebridge = await new FakeHomebridge().start()
    const states: ConnectionState[] = []
    const api = new HomebridgeApi({ baseUrl: homebridge.url, username: 'example', password: 'wrong' })
    const stream = new LogStream({
      instance: 'example-1', api, logger: memoryLogger(), timing: TIMING, random: () => 0,
      recentLines: () => [], onLines: () => undefined, onState: (state) => states.push(state),
    })
    t.after(async () => {
      stream.stop()
      await homebridge.stop()
    })
    stream.start()
    await waitFor(() => states.includes('unauthorized'))
  })
})
