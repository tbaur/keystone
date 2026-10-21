import type {
  AccessorySummary, ChildBridgeSummary, Connection, ConnectionState, HostStats, InstanceSnapshot, PluginSummary,
} from '../../shared/types.ts'
import type { InstanceConfig } from '../config.ts'
import type { Logger } from '../logger.ts'
import { HomebridgeApiError, type HomebridgeApi } from './api-client.ts'
import {
  UNKNOWN_VERSION, mapAccessories, mapChildBridges, mapHomebridgeStatus, mapHomebridgeVersion, mapHost, mapPlugins,
  type HomebridgeStatus, type HomebridgeVersion,
} from './mappers.ts'
import { Poller } from './poller.ts'

export interface PollIntervals {
  statusMs: number
  accessoriesMs: number
  pluginsMs: number
}

export const DEFAULT_INTERVALS: PollIntervals = { statusMs: 10_000, accessoriesMs: 60_000, pluginsMs: 15 * 60_000 }

export interface MonitorOptions {
  config: InstanceConfig
  api: HomebridgeApi
  logger: Logger
  onChange: () => void
  intervals?: Partial<PollIntervals>
  /** For the pollers' backoff jitter. */
  random?: () => number
}

type SidePoll = 'plugins' | 'accessories'

/**
 * Polls one Homebridge UI and keeps the latest snapshot. Each kind of data has
 * its own poller, so a slow accessory scan never holds up the status.
 */
export class InstanceMonitor {
  private readonly options: MonitorOptions
  private readonly pollers: Poller[]
  private api: Connection = connection('connecting')
  private logs: Connection = connection('connecting')
  private status: HomebridgeStatus | null = null
  private version: HomebridgeVersion = UNKNOWN_VERSION
  private childBridges: ChildBridgeSummary[] = []
  private plugins: PluginSummary[] = []
  private accessories: AccessorySummary | null = null
  private sideErrors: Record<SidePoll, string | null> = { plugins: null, accessories: null }
  private accessoriesShared = true
  private hostStats: HostStats | null = null
  private updatedAt: number | null = null
  private lastPublished = ''

  constructor(options: MonitorOptions) {
    this.options = options
    const intervals = { ...DEFAULT_INTERVALS, ...options.intervals }
    const { random } = options
    this.pollers = [
      new Poller({ intervalMs: intervals.statusMs, task: () => this.pollStatus(), onError: (error) => this.statusFailed(error), random }),
      new Poller({ intervalMs: intervals.pluginsMs, task: () => this.pollPlugins(), onError: (error) => this.sideFailed('plugins', error), random }),
      new Poller({ intervalMs: intervals.accessoriesMs, task: () => this.pollAccessories(), onError: (error) => this.accessoriesFailed(error), random }),
    ]
  }

  get name(): string {
    return this.options.config.name
  }

  start(): void {
    this.pollers.forEach((poller) => poller.start())
  }

  stop(): void {
    this.pollers.forEach((poller) => poller.stop())
  }

  setLogsState(state: ConnectionState, error: string | null): void {
    if (state !== this.logs.state || error !== this.logs.error) {
      this.logs = connection(state, error)
      this.changed()
    }
  }

  snapshot(): InstanceSnapshot {
    return {
      name: this.name,
      uiUrl: this.options.config.uiUrl,
      api: this.api,
      logs: this.logs,
      homebridge: this.status ? { ...this.status, ...this.version } : null,
      childBridges: this.childBridges,
      plugins: this.plugins,
      pluginsError: this.sideErrors.plugins,
      accessories: this.accessories,
      accessoriesError: this.sideErrors.accessories,
      host: this.api.state === 'connected' ? this.hostStats : null,
      updatedAt: this.updatedAt,
    }
  }

  private async pollStatus(): Promise<void> {
    const api = this.options.api
    const [status, bridges, cpu, ram, uptime, network] = await Promise.all([
      api.get('/status/homebridge'),
      api.get('/status/homebridge/child-bridges'),
      api.get('/status/cpu'),
      api.get('/status/ram'),
      api.get('/status/uptime'),
      // Optional: a host where Homebridge UI cannot read network stats still counts as connected.
      api.get('/status/network').catch(() => null),
    ])
    this.status = mapHomebridgeStatus(status)
    this.childBridges = mapChildBridges(bridges)
    this.hostStats = mapHost({ cpu, ram, uptime, network })
    this.updatedAt = Date.now()
    this.setApiState('connected', null)
    this.changed()
  }

  private async pollPlugins(): Promise<void> {
    const [plugins, version] = await Promise.all([this.options.api.get('/plugins'), this.options.api.get('/status/homebridge-version')])
    this.plugins = mapPlugins(plugins)
    this.version = mapHomebridgeVersion(version)
    this.sideRecovered('plugins')
    this.changed()
  }

  private async pollAccessories(): Promise<void> {
    this.accessories = mapAccessories(await this.options.api.get('/accessories'))
    this.accessoriesShared = true
    this.sideRecovered('accessories')
    this.changed()
  }

  private statusFailed(error: unknown): void {
    const isAuth = error instanceof HomebridgeApiError && error.kind === 'unauthorized'
    const message = error instanceof HomebridgeApiError ? error.message : 'unexpected error'
    if (!(error instanceof HomebridgeApiError)) {
      this.options.logger.error('status poll failed', { error })
    } else if (this.api.state !== (isAuth ? 'unauthorized' : 'unreachable')) {
      this.options.logger.warn('Homebridge UI unavailable', { error })
    }
    this.setApiState(isAuth ? 'unauthorized' : 'unreachable', message)
    this.changed()
  }

  /** Accessories need Homebridge in insecure mode (-I). Without it Homebridge UI answers 400 and the summary stays empty. */
  private accessoriesFailed(error: unknown): void {
    if (error instanceof HomebridgeApiError && error.status === 400) {
      if (this.accessoriesShared) {
        this.options.logger.info('accessories unavailable; is Homebridge running with -I?')
      }
      this.accessoriesShared = false
      this.accessories = null
      this.sideRecovered('accessories')
      this.changed()
      return
    }
    this.sideFailed('accessories', error)
  }

  /** The last good data stays on the card, with the error next to it. */
  private sideFailed(what: SidePoll, error: unknown): void {
    const message = error instanceof HomebridgeApiError ? error.message : 'unexpected error'
    if (!(error instanceof HomebridgeApiError)) {
      this.options.logger.error(`${what} poll failed`, { error })
    } else if (this.sideErrors[what] !== message) {
      this.options.logger.warn(`${what} poll failed`, { error })
    }
    this.sideErrors[what] = message
    this.changed()
  }

  private sideRecovered(what: SidePoll): void {
    if (this.sideErrors[what] !== null) {
      this.options.logger.info(`${what} poll recovered`)
      this.sideErrors[what] = null
    }
  }

  private setApiState(state: ConnectionState, error: string | null): void {
    if (state !== this.api.state || error !== this.api.error) {
      this.api = connection(state, error)
    }
  }

  /** Tell the hub only when the snapshot really changed, so an idle dashboard sends nothing. */
  private changed(): void {
    const published = JSON.stringify(this.snapshot())
    if (published !== this.lastPublished) {
      this.lastPublished = published
      this.options.onChange()
    }
  }
}

function connection(state: ConnectionState, error: string | null = null): Connection {
  return { state, since: Date.now(), error }
}
