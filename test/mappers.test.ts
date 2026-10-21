import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  mapAccessories, mapChildBridges, mapHomebridgeStatus, mapHost, mapPlugins,
} from '../src/server/homebridge/mappers.ts'
import { FAKE_PIN, FAKE_SETUP_URI } from './helpers/fake-homebridge.ts'

describe('mappers', () => {
  it('keep PINs, setup codes and bridge usernames out of the status', () => {
    const status = mapHomebridgeStatus({ status: 'ok', name: 'Example Bridge', pin: FAKE_PIN, setupUri: FAKE_SETUP_URI, packageVersion: '5.29.0', paired: true })
    const bridges = mapChildBridges([{ name: 'Sensor Bridge', status: 'down', pin: FAKE_PIN, setupUri: FAKE_SETUP_URI, username: '02:00:00:00:00:01' }])
    const text = JSON.stringify([status, bridges])
    assert.ok(!text.includes(FAKE_PIN))
    assert.ok(!text.includes(FAKE_SETUP_URI))
    assert.ok(!text.includes('02:00:00:00:00:01'))
    assert.deepEqual(status, { status: 'ok', bridgeName: 'Example Bridge' })
  })

  it('counts accessories, not services, and keeps two accessories with the same name apart', () => {
    const bridge = { username: '02:00:00:00:00:10' }
    const other = { username: '02:00:00:00:00:11' }
    const summary = mapAccessories([
      { uniqueId: 's1', aid: 2, instance: bridge, accessoryInformation: { Name: 'Sensor' }, serviceName: 'Motion', values: { StatusLowBattery: 1 } },
      { uniqueId: 's2', aid: 2, instance: bridge, accessoryInformation: { Name: 'Sensor' }, serviceName: 'Battery', values: { BatteryLevel: 9, StatusLowBattery: 1 } },
      { uniqueId: 's3', aid: 2, instance: bridge, accessoryInformation: { Name: 'Sensor' }, serviceName: 'Temperature', values: { StatusLowBattery: 1 } },
      { uniqueId: 's4', aid: 2, instance: other, accessoryInformation: { Name: 'Sensor' }, serviceName: 'Battery', values: { BatteryLevel: 14 } },
      { uniqueId: 's5', aid: 3, instance: bridge, serviceName: 'Zone One Light', values: { On: true } },
    ])
    assert.equal(summary.total, 3)
    assert.deepEqual(summary.lowBattery, [{ name: 'Sensor', level: 9 }, { name: 'Sensor', level: 14 }])
  })

  it('reads an unknown run state as unknown and skips bridges without a name', () => {
    const bridges = mapChildBridges([{ name: 'B', status: 'exploded' }, { status: 'ok' }, 'junk', { name: 'A', status: 'ok' }])
    assert.deepEqual(bridges.map((b) => [b.name, b.status]), [['A', 'ok'], ['B', 'unknown']])
  })

  it('reports a low battery from StatusLowBattery, or from the level when there is no status', () => {
    const summary = mapAccessories([
      { uniqueId: '1', serviceName: 'Flagged', values: { StatusLowBattery: 1, BatteryLevel: 40 } },
      { uniqueId: '2', serviceName: 'Fine but low number', values: { StatusLowBattery: 0, BatteryLevel: 5 } },
      { uniqueId: '3', serviceName: 'Level only', values: { BatteryLevel: 15 } },
      { uniqueId: '3', serviceName: 'Level only', values: {} },
      { uniqueId: '4', serviceName: 'No battery', values: { On: true } },
    ])
    assert.equal(summary.total, 4)
    assert.deepEqual(summary.lowBattery, [{ name: 'Level only', level: 15 }, { name: 'Flagged', level: 40 }])
  })

  it('sorts plugins by display name and survives missing fields', () => {
    const plugins = mapPlugins([{ name: 'z-plugin', displayName: 'Zed' }, { name: 'a-plugin' }, null])
    assert.deepEqual(plugins.map((p) => p.displayName), ['a-plugin', 'Zed'])
    assert.equal(plugins[0]?.updateAvailable, false)
    assert.equal(plugins[0].version, null)
  })

  it('keeps the installed and the latest version of a plugin', () => {
    const [plugin] = mapPlugins([{ name: 'homebridge-example', installedVersion: '2.0.0', latestVersion: '2.1.0', updateAvailable: true }])
    assert.deepEqual([plugin?.version, plugin?.latestVersion, plugin?.updateAvailable], ['2.0.0', '2.1.0', true])
  })

  it('rounds CPU load and reads memory, uptime and network rates', () => {
    assert.deepEqual(mapHost({
      cpu: { currentLoad: 7.25 },
      ram: { mem: { total: 10, available: 4 } },
      uptime: { time: { uptime: 99 } },
      network: { net: { rx_sec: 1000, tx_sec: 0 } },
    }), { cpuLoad: 7.3, memoryTotal: 10, memoryAvailable: 4, uptime: 99, networkReceive: 1000, networkTransmit: 0 })
    assert.deepEqual(mapHost({ cpu: null, ram: null, uptime: null, network: null }), {
      cpuLoad: null, memoryTotal: null, memoryAvailable: null, uptime: null, networkReceive: null, networkTransmit: null,
    })
  })

  it('treats a network rate without two samples yet as unknown', () => {
    const host = mapHost({ cpu: null, ram: null, uptime: null, network: { net: { rx_sec: -1, tx_sec: null } } })
    assert.equal(host.networkReceive, null)
    assert.equal(host.networkTransmit, null)
  })
})
