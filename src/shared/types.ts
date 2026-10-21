/**
 * The JSON shapes that the dashboard server sends to the browser.
 *
 * Every field here is chosen on purpose. The server maps Homebridge responses
 * into these types field by field, so a PIN, setup code or token that
 * Homebridge adds to a response can never reach the browser by accident.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

export interface LogLine {
  /** Increases with every stored line, across all instances. */
  id: number
  instance: string
  /** Epoch ms. Homebridge's own timestamp when the line has one, otherwise when the dashboard received it. */
  ts: number
  plugin: string | null
  level: LogLevel
  /** The message after the timestamp and plugin prefix, with ANSI colour codes kept. */
  message: string
  /** True for lines that the dashboard writes itself, such as "log stream connected". */
  system: boolean
}

export interface LogPage {
  lines: LogLine[]
  /** True when older lines that match the same filter exist. */
  hasMore: boolean
  /** The newest stored line of any instance. A live stream starts after it. */
  latestId: number
}

export type ConnectionState = 'connecting' | 'connected' | 'unreachable' | 'unauthorized'

export interface Connection {
  state: ConnectionState
  /** Epoch ms of the last state change. */
  since: number
  /** A short, safe description of the last failure. */
  error: string | null
}

export type RunState = 'ok' | 'pending' | 'down' | 'unknown'

export interface HomebridgeSummary {
  status: RunState
  bridgeName: string | null
  version: string | null
  latestVersion: string | null
  updateAvailable: boolean
}

export interface ChildBridgeSummary {
  name: string
  plugin: string | null
  status: RunState
  manuallyStopped: boolean
}

export interface PluginSummary {
  name: string
  displayName: string
  latestVersion: string | null
  updateAvailable: boolean
  disabled: boolean
}

export interface LowBattery {
  name: string
  /** Percent, when the accessory reports one. */
  level: number | null
}

export interface AccessorySummary {
  total: number
  lowBattery: LowBattery[]
}

export interface InstanceSnapshot {
  name: string
  /** Where the instance's own Homebridge UI is, for links. */
  uiUrl: string
  api: Connection
  logs: Connection
  homebridge: HomebridgeSummary | null
  childBridges: ChildBridgeSummary[]
  plugins: PluginSummary[]
  /** Why the last plugin and version poll failed, or null when it worked. */
  pluginsError: string | null
  /** Null when Homebridge does not share its accessories (it runs without -I) or they are not loaded yet. */
  accessories: AccessorySummary | null
  /** Why the last accessory poll failed, or null when it worked. */
  accessoriesError: string | null
  /** The machine that this instance runs on, while its Homebridge UI is connected. */
  host: HostStats | null
  /** Epoch ms of the last successful status poll, which also brings the child bridges. */
  updatedAt: number | null
}

export interface HostStats {
  /** Percent, 0 to 100. */
  cpuLoad: number | null
  memoryTotal: number | null
  memoryAvailable: number | null
  /** Seconds since the host booted. */
  uptime: number | null
  /** Bytes per second on the host's default network interface. */
  networkReceive: number | null
  networkTransmit: number | null
}

export interface LogCount {
  instance: string
  plugin: string | null
  level: 'error' | 'warn'
  count: number
}

export interface Overview {
  instances: InstanceSnapshot[]
  /** Errors and warnings per instance and plugin over the last 24 hours. */
  logCounts: LogCount[]
}

export interface Health {
  status: 'ok' | 'degraded'
  /** 'failing' while lines cannot be written to the database. */
  store: 'ok' | 'failing'
  instances: Record<string, { api: ConnectionState, logs: ConnectionState }>
}
