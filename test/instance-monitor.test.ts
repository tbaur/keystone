import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { HomebridgeApiError, type HomebridgeApi } from '../src/server/homebridge/api-client.ts'
import { InstanceMonitor } from '../src/server/homebridge/instance-monitor.ts'
import { memoryLogger, waitFor } from './helpers/util.ts'

const RESPONSES: Record<string, unknown> = {
  '/status/homebridge': { status: 'ok', name: 'Example Bridge' },
  '/status/homebridge/child-bridges': [],
  '/status/cpu': { currentLoad: 5 },
  '/status/ram': { mem: { total: 10, available: 5 } },
  '/status/uptime': { time: { uptime: 60 } },
  '/status/network': { net: { rx_sec: 1, tx_sec: 2 } },
  '/status/homebridge-version': { installedVersion: '1.11.0' },
  '/plugins': [{ name: 'homebridge-example', displayName: 'Example' }],
  '/accessories': [{ uniqueId: 'a1', aid: 2, serviceName: 'Sensor', values: {} }],
}

/** An API whose paths answer from RESPONSES unless a failure is set for them. */
function fakeApi(): { api: HomebridgeApi, failures: Map<string, Error> } {
  const failures = new Map<string, Error>()
  const api = {
    get: (path: string): Promise<unknown> => {
      const failure = failures.get(path)
      return failure ? Promise.reject(failure) : Promise.resolve(RESPONSES[path])
    },
  }
  return { api: api as unknown as HomebridgeApi, failures }
}

function setup(t: { after: (fn: () => void) => void }) {
  const { api, failures } = fakeApi()
  const logger = memoryLogger()
  const monitor = new InstanceMonitor({
    config: { name: 'example-1', apiUrl: 'http://127.0.0.1:8581', uiUrl: 'https://host.test', username: 'example', password: 'test-password' },
    api, logger, onChange: () => undefined, intervals: { statusMs: 10, pluginsMs: 10, accessoriesMs: 10 }, random: () => 0,
  })
  t.after(() => monitor.stop())
  monitor.start()
  const count = (msg: string): number => logger.records.filter((record) => record.msg === msg).length
  return { monitor, failures, count }
}

describe('InstanceMonitor', () => {
  it('keeps the last plugins with the error beside them, warns once, and says when it recovers', async (t) => {
    const { monitor, failures, count } = setup(t)
    await waitFor(() => monitor.snapshot().plugins.length === 1)
    failures.set('/plugins', new HomebridgeApiError('http', '/plugins answered 500', { status: 500 }))
    await waitFor(() => monitor.snapshot().pluginsError === '/plugins answered 500')
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(monitor.snapshot().plugins.length, 1)
    assert.equal(count('plugins poll failed'), 1)
    failures.delete('/plugins')
    await waitFor(() => monitor.snapshot().pluginsError === null)
    assert.equal(count('plugins poll recovered'), 1)
  })

  it('treats a 400 from the accessories as "not shared", says so once, and shows no error', async (t) => {
    const { monitor, failures, count } = setup(t)
    await waitFor(() => monitor.snapshot().accessories?.total === 1)
    failures.set('/accessories', new HomebridgeApiError('http', '/accessories answered 400', { status: 400 }))
    await waitFor(() => monitor.snapshot().accessories === null)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(monitor.snapshot().accessoriesError, null)
    assert.equal(count('accessories unavailable; is Homebridge running with -I?'), 1)
  })

  it('keeps the last status but hides host stats while Homebridge UI is unreachable', async (t) => {
    const { monitor, failures } = setup(t)
    await waitFor(() => monitor.snapshot().host !== null)
    failures.set('/status/homebridge', new HomebridgeApiError('unreachable', 'connection failed'))
    await waitFor(() => monitor.snapshot().api.state === 'unreachable')
    const { updatedAt } = monitor.snapshot()
    await new Promise((resolve) => setTimeout(resolve, 60))
    const snapshot = monitor.snapshot()
    assert.equal(snapshot.host, null)
    assert.equal(snapshot.homebridge?.bridgeName, 'Example Bridge')
    assert.ok(updatedAt !== null)
    assert.equal(snapshot.updatedAt, updatedAt, 'the time of the last good poll')
    assert.equal(snapshot.api.error, 'connection failed')
  })

  it('stays connected when only the network stats fail', async (t) => {
    const { monitor, failures } = setup(t)
    failures.set('/status/network', new HomebridgeApiError('http', '/status/network answered 500', { status: 500 }))
    await waitFor(() => monitor.snapshot().api.state === 'connected' && monitor.snapshot().host?.networkReceive === null)
    assert.equal(monitor.snapshot().host?.cpuLoad, 5)
  })
})
