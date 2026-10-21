import type { Health, InstanceSnapshot, LogCount, Overview } from '../shared/types.ts'
import type { LogStore } from './store/log-store.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const COUNTS_TTL_MS = 60_000

export interface SnapshotSource {
  snapshot(): InstanceSnapshot
}

export interface DashboardDeps {
  monitors: readonly SnapshotSource[]
  store: LogStore
  /** True while new log lines cannot be written. */
  isStoreFailing: () => boolean
}

/** Builds the overview from the monitors. The 24-hour counts are a query, so they are cached for a minute. */
export class Dashboard {
  private readonly deps: DashboardDeps
  private counts: { at: number, value: LogCount[] } | null = null

  constructor(deps: DashboardDeps) {
    this.deps = deps
  }

  overview(now = Date.now()): Overview {
    if (!this.counts || now - this.counts.at > COUNTS_TTL_MS) {
      this.counts = { at: now, value: this.deps.store.counts(now - DAY_MS) }
    }
    return {
      instances: this.deps.monitors.map((monitor) => monitor.snapshot()),
      logCounts: this.counts.value,
    }
  }

  /** Degraded when lines cannot be stored, or any instance's API or log stream is not connected. */
  health(): Health {
    const instances: Health['instances'] = {}
    const store = this.deps.isStoreFailing() ? 'failing' : 'ok'
    let isHealthy = store === 'ok'
    for (const monitor of this.deps.monitors) {
      const { name, api, logs } = monitor.snapshot()
      instances[name] = { api: api.state, logs: logs.state }
      isHealthy &&= api.state === 'connected' && logs.state === 'connected'
    }
    return { status: isHealthy ? 'ok' : 'degraded', store, instances }
  }
}
