/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { setImmediate as yieldToEvents } from 'node:timers/promises'
import type { DatabaseSync } from 'node:sqlite'

import { LoginThrottle } from './auth/login-throttle.ts'
import { SessionStore } from './auth/sessions.ts'
import type { Config } from './config.ts'
import { Dashboard } from './dashboard.ts'
import { errorMessage } from './errors.ts'
import { HomebridgeApi } from './homebridge/api-client.ts'
import { InstanceMonitor, type PollIntervals } from './homebridge/instance-monitor.ts'
import { LogStream, type StreamTiming } from './homebridge/log-stream.ts'
import { createHandler } from './http/app.ts'
import { isLoopbackHost } from './http/http-utils.ts'
import { loadAssets } from './http/static-assets.ts'
import { StreamHub } from './http/stream-hub.ts'
import type { Logger } from './logger.ts'
import { LogPipeline } from './logs/pipeline.ts'
import { REPLAY_COMPARE_LINES } from './logs/replay.ts'
import { openDatabase, SchemaError } from './store/database.ts'
import { LogStore } from './store/log-store.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const MAINTENANCE_MS = 60 * 60_000
/** A ceiling on stored lines whatever the retention, so a runaway plugin cannot fill the disk. */
const MAX_STORED_LINES = 2_000_000
/** Lines deleted per step of a prune, with a pause for other work after each step. */
const PRUNE_BATCH = 10_000
const SHUTDOWN_GRACE_MS = 5000

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
  const db = openStore(config.dataDir)
  warnAboutPlainHttp(config, logger)
  if (config.allowedHosts.length === 0) {
    logger.warn('allowedHosts is not set, so a page on another site can reach Keystone by DNS rebinding; list the names people use to reach it')
  }
  const store = new LogStore(db)
  const sessions = new SessionStore(db)
  const monitors: InstanceMonitor[] = []
  const pipeline = new LogPipeline({ store, logger, onStored: (lines) => hub.publishLines(lines), onFailingChange: () => hub.overviewChanged() })
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
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.listen.port
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
    throw new SetupError(`${problem}: ${errorMessage(error)}`, { cause: error })
  }
}

/**
 * Only a database from a newer Keystone is a setup problem. Anything else, such
 * as a full disk or a lock held for a moment, may clear, so the process exits
 * with a code that lets the service manager try again.
 */
function openStore(dataDir: string): DatabaseSync {
  try {
    return openDatabase(dataDir)
  } catch (error) {
    const message = `cannot open the database in ${dataDir}: ${errorMessage(error)}`
    throw error instanceof SchemaError ? new SetupError(message, { cause: error }) : new Error(message, { cause: error })
  }
}

/** The Homebridge password goes to `apiUrl` at every login, so plain http should not leave the host. */
export function warnAboutPlainHttp(config: Pick<Config, 'instances'>, logger: Logger): void {
  for (const instance of config.instances) {
    const url = new URL(instance.apiUrl)
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
      logger.warn('apiUrl uses plain http to another host, so the Homebridge password crosses the network unencrypted', {
        instance: instance.name,
      })
    }
  }
}

export interface MaintenanceDeps {
  store: Pick<LogStore, 'capThreshold' | 'pruneBatch' | 'optimize'>
  sessions: Pick<SessionStore, 'removeExpired'>
  logger: Logger
  retentionDays: number
  /** For tests: the line ceiling and the batch size. */
  maxStoredLines?: number
  pruneBatch?: number
}

/** The hourly clean-up: old lines in small batches, so a large prune never stalls the server, then expired sessions. */
export class Maintenance {
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
    const batch = this.deps.pruneBatch ?? PRUNE_BATCH
    try {
      const cutoff = Date.now() - retentionDays * DAY_MS
      // Worked out once per run: lines that arrive during the run stay for the next one.
      const capId = store.capThreshold(this.deps.maxStoredLines ?? MAX_STORED_LINES)
      let removed = 0
      let step = batch
      while (step === batch && !this.stopped) {
        step = store.pruneBatch(cutoff, capId, batch)
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
