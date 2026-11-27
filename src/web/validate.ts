/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Readers for the JSON that the server sends. The page and the server are
 * built together, but an old server during an upgrade, a proxy's error page or
 * a bug can still send something else, so the page checks each field instead
 * of trusting the whole shape. A reader throws ShapeError, naming the field.
 */

import type {
  AccessorySummary, ChildBridgeSummary, Connection, ConnectionState, HomebridgeSummary, HostStats, InstanceSnapshot, LogCount, LogLevel,
  LogLine, LogPage, LowBattery, Overview, PluginSummary, RunState,
} from '../shared/types.ts'

export class ShapeError extends Error {
  override name = 'ShapeError'
}

type Json = Record<string, unknown>

const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug']
const CONNECTION_STATES: readonly ConnectionState[] = ['connecting', 'connected', 'unreachable', 'unauthorized']
const RUN_STATES: readonly RunState[] = ['ok', 'pending', 'down', 'unknown']

function record(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ShapeError(`${what} is not an object`)
  }
  // An object that is not an array: its keys are strings and its values are unknown until read below.
  return value as Json
}

function list<T>(value: unknown, what: string, read: (item: unknown, what: string) => T): T[] {
  if (!Array.isArray(value)) {
    throw new ShapeError(`${what} is not a list`)
  }
  return value.map((item: unknown, index) => read(item, `${what}[${index}]`))
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new ShapeError(`${what} is not text`)
  }
  return value
}

function number(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ShapeError(`${what} is not a number`)
  }
  return value
}

function flag(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ShapeError(`${what} is not true or false`)
  }
  return value
}

function nullable<T>(value: unknown, what: string, read: (value: unknown, what: string) => T): T | null {
  return value === null ? null : read(value, what)
}

function oneOf<T extends string>(values: readonly T[]): (value: unknown, what: string) => T {
  return (value, what) => {
    const found = values.find((each) => each === value)
    if (found === undefined) {
      throw new ShapeError(`${what} is not one of ${values.join(', ')}`)
    }
    return found
  }
}

export function readLogLine(value: unknown, what = 'line'): LogLine {
  const line = record(value, what)
  return {
    id: number(line.id, `${what}.id`),
    instance: text(line.instance, `${what}.instance`),
    ts: number(line.ts, `${what}.ts`),
    plugin: nullable(line.plugin, `${what}.plugin`, text),
    level: oneOf(LEVELS)(line.level, `${what}.level`),
    message: text(line.message, `${what}.message`),
    system: flag(line.system, `${what}.system`),
  }
}

export function readLogLines(value: unknown): LogLine[] {
  return list(value, 'lines', readLogLine)
}

export function readLogPage(value: unknown): LogPage {
  const page = record(value, 'page')
  const result: LogPage = {
    lines: list(page.lines, 'page.lines', readLogLine),
    hasMore: flag(page.hasMore, 'page.hasMore'),
    latestId: number(page.latestId, 'page.latestId'),
  }
  if (page.nextBefore !== undefined) {
    result.nextBefore = number(page.nextBefore, 'page.nextBefore')
  }
  return result
}

function readConnection(value: unknown, what: string): Connection {
  const connection = record(value, what)
  return {
    state: oneOf(CONNECTION_STATES)(connection.state, `${what}.state`),
    since: number(connection.since, `${what}.since`),
    error: nullable(connection.error, `${what}.error`, text),
  }
}

function readHomebridge(value: unknown, what: string): HomebridgeSummary {
  const homebridge = record(value, what)
  return {
    status: oneOf(RUN_STATES)(homebridge.status, `${what}.status`),
    bridgeName: nullable(homebridge.bridgeName, `${what}.bridgeName`, text),
    version: nullable(homebridge.version, `${what}.version`, text),
    latestVersion: nullable(homebridge.latestVersion, `${what}.latestVersion`, text),
    updateAvailable: flag(homebridge.updateAvailable, `${what}.updateAvailable`),
  }
}

function readChildBridge(value: unknown, what: string): ChildBridgeSummary {
  const bridge = record(value, what)
  return {
    name: text(bridge.name, `${what}.name`),
    plugin: nullable(bridge.plugin, `${what}.plugin`, text),
    status: oneOf(RUN_STATES)(bridge.status, `${what}.status`),
    manuallyStopped: flag(bridge.manuallyStopped, `${what}.manuallyStopped`),
  }
}

function readPlugin(value: unknown, what: string): PluginSummary {
  const plugin = record(value, what)
  return {
    name: text(plugin.name, `${what}.name`),
    displayName: text(plugin.displayName, `${what}.displayName`),
    version: nullable(plugin.version, `${what}.version`, text),
    latestVersion: nullable(plugin.latestVersion, `${what}.latestVersion`, text),
    updateAvailable: flag(plugin.updateAvailable, `${what}.updateAvailable`),
    disabled: flag(plugin.disabled, `${what}.disabled`),
  }
}

function readBattery(value: unknown, what: string): LowBattery {
  const battery = record(value, what)
  return { name: text(battery.name, `${what}.name`), level: nullable(battery.level, `${what}.level`, number) }
}

function readAccessories(value: unknown, what: string): AccessorySummary {
  const accessories = record(value, what)
  return { total: number(accessories.total, `${what}.total`), lowBattery: list(accessories.lowBattery, `${what}.lowBattery`, readBattery) }
}

function readHost(value: unknown, what: string): HostStats {
  const host = record(value, what)
  const stat = (key: keyof HostStats): number | null => nullable(host[key], `${what}.${key}`, number)
  return {
    cpuLoad: stat('cpuLoad'), memoryTotal: stat('memoryTotal'), memoryAvailable: stat('memoryAvailable'),
    uptime: stat('uptime'), networkReceive: stat('networkReceive'), networkTransmit: stat('networkTransmit'),
  }
}

function readInstance(value: unknown, what: string): InstanceSnapshot {
  const instance = record(value, what)
  return {
    name: text(instance.name, `${what}.name`),
    uiUrl: text(instance.uiUrl, `${what}.uiUrl`),
    api: readConnection(instance.api, `${what}.api`),
    logs: readConnection(instance.logs, `${what}.logs`),
    homebridge: nullable(instance.homebridge, `${what}.homebridge`, readHomebridge),
    childBridges: list(instance.childBridges, `${what}.childBridges`, readChildBridge),
    plugins: list(instance.plugins, `${what}.plugins`, readPlugin),
    pluginsError: nullable(instance.pluginsError, `${what}.pluginsError`, text),
    accessories: nullable(instance.accessories, `${what}.accessories`, readAccessories),
    accessoriesError: nullable(instance.accessoriesError, `${what}.accessoriesError`, text),
    host: nullable(instance.host, `${what}.host`, readHost),
    updatedAt: nullable(instance.updatedAt, `${what}.updatedAt`, number),
  }
}

function readCount(value: unknown, what: string): LogCount {
  const count = record(value, what)
  return {
    instance: text(count.instance, `${what}.instance`),
    plugin: nullable(count.plugin, `${what}.plugin`, text),
    level: oneOf(['error', 'warn'] as const)(count.level, `${what}.level`),
    count: number(count.count, `${what}.count`),
  }
}

export function readOverview(value: unknown): Overview {
  const overview = record(value, 'overview')
  return {
    instances: list(overview.instances, 'overview.instances', readInstance),
    logCounts: list(overview.logCounts, 'overview.logCounts', readCount),
    store: oneOf(['ok', 'failing'] as const)(overview.store, 'overview.store'),
  }
}
