/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

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

/** An API whose paths answer from RESPONSES unless a failure is set for them, and that counts the calls to each path. */
function fakeApi(): { api: HomebridgeApi, failures: Map<string, Error>, calls: Map<string, number> } {
  const failures = new Map<string, Error>()
  const calls = new Map<string, number>()
  const api = {
    get: (path: string): Promise<unknown> => {
      calls.set(path, (calls.get(path) ?? 0) + 1)
      const failure = failures.get(path)
      return failure ? Promise.reject(failure) : Promise.resolve(RESPONSES[path])
    },
  }
  // The monitor only calls get(); the rest of HomebridgeApi is never reached here.
  return { api: api as unknown as HomebridgeApi, failures, calls }
}

function setup(t: { after: (fn: () => void) => void }) {
  const { api, failures, calls } = fakeApi()
  const logger = memoryLogger()
  const monitor = new InstanceMonitor({
    config: { name: 'example-1', apiUrl: 'http://127.0.0.1:8581', uiUrl: 'https://host.test', username: 'example', password: 'test-password' },
    api, logger, onChange: () => undefined, intervals: { statusMs: 10, pluginsMs: 10, accessoriesMs: 10 }, random: () => 0,
  })
  t.after(() => monitor.stop())
  monitor.start()
  const count = (msg: string): number => logger.records.filter((record) => record.msg === msg).length
  /** Wait until `path` has been polled three more times, so a repeated warning would have shown up. */
  const morePolls = async (path: string): Promise<void> => {
    const seen = calls.get(path) ?? 0
    await waitFor(() => (calls.get(path) ?? 0) >= seen + 3)
  }
  return { monitor, failures, count, morePolls }
}

describe('InstanceMonitor', () => {
  it('keeps the last plugins with the error beside them, warns once, and says when it recovers', async (t) => {
    const { monitor, failures, count, morePolls } = setup(t)
    await waitFor(() => monitor.snapshot().plugins.length === 1)
    failures.set('/plugins', new HomebridgeApiError('http', '/plugins answered 500', { status: 500 }))
    await waitFor(() => monitor.snapshot().pluginsError === '/plugins answered 500')
    await morePolls('/plugins')
    assert.equal(monitor.snapshot().plugins.length, 1)
    assert.equal(count('plugins poll failed'), 1)
    failures.delete('/plugins')
    await waitFor(() => monitor.snapshot().pluginsError === null)
    assert.equal(count('plugins poll recovered'), 1)
  })

  it('treats a 400 from the accessories as "not shared", says so once, and shows no error', async (t) => {
    const { monitor, failures, count, morePolls } = setup(t)
    await waitFor(() => monitor.snapshot().accessories?.total === 1)
    failures.set('/accessories', new HomebridgeApiError('http', '/accessories answered 400', { status: 400 }))
    await waitFor(() => monitor.snapshot().accessories === null)
    await morePolls('/accessories')
    assert.equal(monitor.snapshot().accessoriesError, null)
    assert.equal(count('accessories unavailable; is Homebridge running with -I?'), 1)
  })

  it('keeps the last status but hides host stats while Homebridge UI is unreachable', async (t) => {
    const { monitor, failures, morePolls } = setup(t)
    await waitFor(() => monitor.snapshot().host !== null)
    failures.set('/status/homebridge', new HomebridgeApiError('unreachable', 'connection failed'))
    await waitFor(() => monitor.snapshot().api.state === 'unreachable')
    const { updatedAt, api } = monitor.snapshot()
    failures.set('/status/homebridge', new HomebridgeApiError('unreachable', 'no answer within 10000 ms'))
    await morePolls('/status/homebridge')
    const snapshot = monitor.snapshot()
    assert.equal(snapshot.host, null)
    assert.equal(snapshot.homebridge?.bridgeName, 'Example Bridge')
    assert.ok(updatedAt !== null)
    assert.equal(snapshot.updatedAt, updatedAt, 'the time of the last good poll')
    assert.equal(snapshot.api.error, 'no answer within 10000 ms')
    assert.equal(snapshot.api.since, api.since, 'a new error while still unreachable keeps when the outage began')
  })

  it('logs a network stats failure at debug level instead of dropping it', async (t) => {
    const { monitor, failures, count } = setup(t)
    failures.set('/status/network', new HomebridgeApiError('unreachable', 'no answer within 10000 ms'))
    await waitFor(() => count('network stats unavailable') > 0)
    assert.equal(monitor.snapshot().api.state, 'connected')
  })

  it('stays connected when only the network stats fail', async (t) => {
    const { monitor, failures } = setup(t)
    failures.set('/status/network', new HomebridgeApiError('http', '/status/network answered 500', { status: 500 }))
    await waitFor(() => monitor.snapshot().api.state === 'connected' && monitor.snapshot().host?.networkReceive === null)
    assert.equal(monitor.snapshot().host?.cpuLoad, 5)
  })
})
