import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Dashboard, type SnapshotSource } from '../src/server/dashboard.ts'
import { openDatabase } from '../src/server/store/database.ts'
import { LogStore } from '../src/server/store/log-store.ts'
import type { ConnectionState, InstanceSnapshot } from '../src/shared/types.ts'

function source(name: string, api: ConnectionState, logs: ConnectionState): SnapshotSource {
  const snapshot: InstanceSnapshot = {
    name, uiUrl: 'https://host.test', api: { state: api, since: 0, error: null }, logs: { state: logs, since: 0, error: null },
    homebridge: null, childBridges: [], plugins: [], pluginsError: null, accessories: null, accessoriesError: null, host: null, updatedAt: null,
  }
  return { snapshot: () => snapshot }
}

describe('Dashboard health', () => {
  const store = new LogStore(openDatabase(':memory:'))

  it('is ok only when every instance is connected and the store is writing', () => {
    const monitors = [source('example-1', 'connected', 'connected'), source('example-2', 'connected', 'connected')]
    assert.deepEqual(new Dashboard({ monitors, store, isStoreFailing: () => false }).health(), {
      status: 'ok', store: 'ok',
      instances: { 'example-1': { api: 'connected', logs: 'connected' }, 'example-2': { api: 'connected', logs: 'connected' } },
    })
  })

  it('is degraded when one instance is down, or when the store is failing', () => {
    const down = [source('example-1', 'connected', 'connected'), source('example-2', 'connected', 'unreachable')]
    assert.equal(new Dashboard({ monitors: down, store, isStoreFailing: () => false }).health().status, 'degraded')
    const failing = new Dashboard({ monitors: [source('example-1', 'connected', 'connected')], store, isStoreFailing: () => true }).health()
    assert.equal(failing.status, 'degraded')
    assert.equal(failing.store, 'failing')
  })

  it('caches the 24-hour counts for a minute', () => {
    const dashboard = new Dashboard({ monitors: [], store, isStoreFailing: () => false })
    const first = dashboard.overview(1_000_000)
    store.append([{ instance: 'example-1', ts: 1_000_000, receivedAt: 1_000_000, plugin: null, level: 'error', system: false, raw: 'x', messageOffset: 0 }])
    assert.equal(dashboard.overview(1_030_000).logCounts, first.logCounts)
    assert.equal(dashboard.overview(1_061_000).logCounts[0]?.count, 1)
  })
})
