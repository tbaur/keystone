import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { setImmediate as yieldToEvents } from 'node:timers/promises'
import type { DatabaseSync } from 'node:sqlite'

import { LoginThrottle } from './auth/login-throttle.ts'
import { SessionStore } from './auth/sessions.ts'
import type { Config } from './config.ts'
import { Dashboard } from './dashboard.ts'
import { HomebridgeApi } from './homebridge/api-client.ts'
import { InstanceMonitor, type PollIntervals } from './homebridge/instance-monitor.ts'
import { LogStream, type StreamTiming } from './homebridge/log-stream.ts'
import { createHandler } from './http/app.ts'
import { loadAssets } from './http/static-assets.ts'
import { StreamHub } from './http/stream-hub.ts'
import type { Logger } from './logger.ts'
import { LogPipeline } from './logs/pipeline.ts'
import { REPLAY_COMPARE_LINES } from './logs/replay.ts'
import { openDatabase } from './store/database.ts'
import { LogStore } from './store/log-store.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const MAINTENANCE_MS = 60 * 60_000
/** A ceiling on stored lines whatever the retention, so a runaway plugin cannot fill the disk. */
const MAX_STORED_LINES = 2_000_000
/** Lines deleted per step of a prune, with a pause for other work after each step. */
const PRUNE_BATCH = 10_000
const SHUTDOWN_GRACE_MS = 5000
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export interface StartOptions {
  webRoot?: string
  intervals?: Partial<PollIntervals>
  streamTiming?: Partial<StreamTiming>
}

export interface RunningDashboard {
  port: number
  close(): Promise<void>
}

/** A problem with the install, such as a missing build or a database from a newer Keystone. Restarting will not fix it. */
export class SetupError extends Error {
  override name = 'SetupError'
}

/** Open the database, start following every instance, and serve the dashboard. */
export async function startDashboard(config: Config, logger: Logger, options: StartOptions = {}): Promise<RunningDashboard> {
  const assets = setup(() => loadAssets(options.webRoot ?? join(import.meta.dirname, '..', 'web')), 'the web files are missing; run npm run build')
  const db = setup(() => openDatabase(config.dataDir), `cannot open the database in ${config.dataDir}`)
  warnAboutPlainHttp(config, logger)
  const store = new LogStore(db)
  const sessions = new SessionStore(db)
  const monitors: InstanceMonitor[] = []
  const pipeline = new LogPipeline({ store, logger, onStored: (lines) => hub.publishLines(lines) })
  const dashboard = new Dashboard({ monitors, store, isStoreFailing: () => pipeline.isFailing })
  const hub = new StreamHub({ store, logger, overview: () => dashboard.overview() })

  const streams = config.instances.map((instance) => {
    const log = logger.child({ instance: instance.name })
    const api = new HomebridgeApi({ baseUrl: instance.apiUrl, username: instance.username, password: instance.password })
    const monitor = new InstanceMonitor({ config: instance, api, logger: log, onChange: () => hub.overviewChanged(), intervals: options.intervals })
    monitors.push(monitor)
    return new LogStream({
      instance: instance.name, api, logger: log, timing: options.streamTiming,
      recentLines: () => store.recentPlain(instance.name, REPLAY_COMPARE_LINES),
      onLines: (lines) => pipeline.push(lines),
      onState: (state, error) => monitor.setLogsState(state, error),
    })
  })

  const handler = createHandler({ config, logger, sessions, throttle: new LoginThrottle(), store, hub, dashboard, assets })
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, handler)
  await listen(server, config.listen.host, config.listen.port)
  monitors.forEach((monitor) => monitor.start())
  streams.forEach((stream) => stream.start())
  const port = (server.address() as AddressInfo).port
  logger.info('keystone listening', { host: config.listen.host, port, instances: config.instances.length })

  const maintenance = new Maintenance({ store, sessions, logger, retentionDays: config.retentionDays })
  void maintenance.run()
  const timer = setInterval(() => void maintenance.run(), MAINTENANCE_MS)

  return {
    port,
    async close() {
      clearInterval(timer)
      maintenance.stop()
      streams.forEach((stream) => stream.stop())
      monitors.forEach((monitor) => monitor.stop())
      pipeline.flush()
      hub.close()
      await closeServer(server)
      await maintenance.idle()
      closeDatabase(db, logger)
      logger.info('keystone stopped')
    },
  }
}

function setup<T>(work: () => T, problem: string): T {
  try {
    return work()
  } catch (error) {
    throw new SetupError(`${problem}: ${(error as Error).message}`, { cause: error })
  }
}

/** The Homebridge password goes to `apiUrl` at every login, so plain http should not leave the host. */
function warnAboutPlainHttp(config: Config, logger: Logger): void {
  for (const instance of config.instances) {
    const url = new URL(instance.apiUrl)
    if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname) && !url.hostname.startsWith('127.')) {
      logger.warn('apiUrl uses plain http to another host, so the Homebridge password crosses the network unencrypted', {
        instance: instance.name,
      })
    }
  }
}

interface MaintenanceDeps {
  store: LogStore
  sessions: SessionStore
  logger: Logger
  retentionDays: number
}

/** The hourly clean-up: old lines in small batches, so a large prune never stalls the server, then expired sessions. */
class Maintenance {
  private readonly deps: MaintenanceDeps
  private running: Promise<void> | null = null
  private stopped = false

  constructor(deps: MaintenanceDeps) {
    this.deps = deps
  }

  run(): Promise<void> {
    this.running ??= this.work().finally(() => {
      this.running = null
    })
    return this.running
  }

  stop(): void {
    this.stopped = true
  }

  async idle(): Promise<void> {
    await this.running
  }

  private async work(): Promise<void> {
    const { store, sessions, logger, retentionDays } = this.deps
    try {
      const cutoff = Date.now() - retentionDays * DAY_MS
      let removed = 0
      let step = PRUNE_BATCH
      while (step === PRUNE_BATCH && !this.stopped) {
        step = store.pruneBatch(cutoff, MAX_STORED_LINES, PRUNE_BATCH)
        removed += step
        await yieldToEvents()
      }
      if (removed > 0) {
        logger.info('old log lines removed', { removed })
      }
      sessions.removeExpired()
      store.optimize()
    } catch (error) {
      logger.error('maintenance failed', { error })
    }
  }
}

function closeDatabase(db: DatabaseSync, logger: Logger): void {
  try {
    db.close()
  } catch (error) {
    logger.error('could not close the database', { error })
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolvePromise()
    })
  })
}

/** Stop accepting, let open requests finish, and cut whatever is left after the grace period. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => {
    const force = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS)
    server.close(() => {
      clearTimeout(force)
      resolvePromise()
    })
    server.closeIdleConnections()
  })
}
