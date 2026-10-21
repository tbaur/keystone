/**
 * Map Homebridge UI responses to the dashboard's own types, field by field.
 * Nothing passes through whole, so the PINs and setup codes in these responses
 * stay on the server.
 */
import type {
  AccessorySummary, ChildBridgeSummary, HomebridgeSummary, HostStats, LowBattery, PluginSummary, RunState,
} from '../../shared/types.ts'
import { asArray, asBoolean, asNumber, asRecord, asString } from '../json.ts'

const LOW_BATTERY_PERCENT = 20
const RUN_STATES: readonly RunState[] = ['ok', 'pending', 'down']

export type HomebridgeStatus = Pick<HomebridgeSummary, 'status' | 'bridgeName'>
export type HomebridgeVersion = Pick<HomebridgeSummary, 'version' | 'latestVersion' | 'updateAvailable'>

export const UNKNOWN_VERSION: HomebridgeVersion = { version: null, latestVersion: null, updateAvailable: false }

/** From GET /api/status/homebridge. */
export function mapHomebridgeStatus(value: unknown): HomebridgeStatus {
  const status = asRecord(value) ?? {}
  return {
    status: runState(status.status),
    bridgeName: asString(status.name),
  }
}

/** From GET /api/status/homebridge-version. */
export function mapHomebridgeVersion(value: unknown): HomebridgeVersion {
  const version = asRecord(value) ?? {}
  return {
    version: asString(version.installedVersion),
    latestVersion: asString(version.latestVersion),
    updateAvailable: asBoolean(version.updateAvailable) ?? false,
  }
}

/** From GET /api/status/homebridge/child-bridges. */
export function mapChildBridges(value: unknown): ChildBridgeSummary[] {
  return asArray(value).flatMap((item) => {
    const bridge = asRecord(item)
    const name = asString(bridge?.name)
    if (!bridge || !name) {
      return []
    }
    return [{
      name,
      plugin: asString(bridge.plugin),
      status: runState(bridge.status),
      manuallyStopped: asBoolean(bridge.manuallyStopped) ?? false,
    }]
  }).sort((a, b) => a.name.localeCompare(b.name))
}

/** From GET /api/plugins. Homebridge UI lists itself there too, which is useful: it has updates as well. */
export function mapPlugins(value: unknown): PluginSummary[] {
  return asArray(value).flatMap((item) => {
    const plugin = asRecord(item)
    const name = asString(plugin?.name)
    if (!plugin || !name) {
      return []
    }
    return [{
      name,
      displayName: asString(plugin.displayName) ?? name,
      version: asString(plugin.installedVersion),
      latestVersion: asString(plugin.latestVersion),
      updateAvailable: asBoolean(plugin.updateAvailable) ?? false,
      disabled: asBoolean(plugin.disabled) ?? false,
    }]
  }).sort((a, b) => a.displayName.localeCompare(b.displayName))
}

/**
 * From GET /api/accessories, which lists services, several per accessory. An
 * accessory is one `aid` on one bridge, so that pair counts accessories and
 * keys the low battery list. Two accessories with the same name stay apart.
 */
export function mapAccessories(value: unknown): AccessorySummary {
  const accessories = new Set<string>()
  const low = new Map<string, LowBattery>()
  for (const item of asArray(value)) {
    const service = asRecord(item)
    if (!service) {
      continue
    }
    const info = asRecord(service.accessoryInformation)
    const name = asString(info?.Name) ?? asString(service.serviceName) ?? 'Unnamed accessory'
    const key = accessoryKey(service) ?? name
    accessories.add(key)
    const battery = lowBattery(asRecord(service.values))
    if (battery) {
      low.set(key, { name, level: battery.level ?? low.get(key)?.level ?? null })
    }
  }
  return { total: accessories.size, lowBattery: [...low.values()].sort((a, b) => (a.level ?? 0) - (b.level ?? 0)) }
}

/** The bridge's HAP username and the accessory id. Both stay on the server. */
function accessoryKey(service: Record<string, unknown>): string | null {
  const aid = asNumber(service.aid)
  const bridge = asString(asRecord(service.instance)?.username) ?? ''
  return aid === null ? asString(service.uniqueId) : `${bridge}|${aid}`
}

/** Raw responses from GET /api/status/cpu, /ram, /uptime and /network. */
export interface HostResponses {
  cpu: unknown
  ram: unknown
  uptime: unknown
  network: unknown
}

export function mapHost(responses: HostResponses): HostStats {
  const memory = asRecord(asRecord(responses.ram)?.mem)
  const load = asNumber(asRecord(responses.cpu)?.currentLoad)
  const net = asRecord(asRecord(responses.network)?.net)
  return {
    cpuLoad: load === null ? null : Math.round(load * 10) / 10,
    memoryTotal: asNumber(memory?.total),
    memoryAvailable: asNumber(memory?.available),
    uptime: asNumber(asRecord(asRecord(responses.uptime)?.time)?.uptime),
    networkReceive: byteRate(net?.rx_sec),
    networkTransmit: byteRate(net?.tx_sec),
  }
}

/** Homebridge UI reports null or -1 until it has two samples to compare. */
function byteRate(value: unknown): number | null {
  const rate = asNumber(value)
  return rate !== null && rate >= 0 ? rate : null
}

function lowBattery(values: Record<string, unknown> | null): { level: number | null } | null {
  if (!values) {
    return null
  }
  const level = asNumber(values.BatteryLevel)
  const status = asNumber(values.StatusLowBattery)
  const isLow = status === null ? level !== null && level <= LOW_BATTERY_PERCENT : status === 1
  return isLow ? { level } : null
}

function runState(value: unknown): RunState {
  const state = asString(value)
  return RUN_STATES.find((known) => known === state) ?? 'unknown'
}
