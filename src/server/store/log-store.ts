/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'

import type { LogCount, LogLevel, LogLine, LogPage } from '../../shared/types.ts'
import { stripAnsiText } from '../logs/line-parser.ts'
import { asNumber, asRecord, asString } from '../json.ts'
import { transaction } from './database.ts'
import { searchQuery, searchText } from './search.ts'

export interface NewLogLine {
  instance: string
  ts: number
  receivedAt: number
  plugin: string | null
  level: LogLevel
  system: boolean
  raw: string
  messageOffset: number
}

export type MinLevel = 'warn' | 'error'

/**
 * The plugin filter for lines from Homebridge itself, which have no plugin.
 * A plugin name cannot hold `]`, so no plugin can have this name. The browser
 * (src/web/filters.ts) uses the same value; a test keeps them equal.
 */
export const CORE_PLUGIN = '[core]'

export interface LogFilter {
  instances?: readonly string[]
  minLevel?: MinLevel
  plugin?: string
  /** Case-insensitive text to find in the plugin name or the message. */
  search?: string
}

interface Row {
  id: number
  instance: string
  ts: number
  plugin: string | null
  level: LogLevel
  system: number
  raw: string
  message_offset: number
}

const COLUMNS = 'id, instance, ts, plugin, level, system, raw, message_offset'
export const MAX_PAGE = 1000
/**
 * A search first asks the trigram index for up to this many of the newest
 * matches. Fewer means that is every match, and the page comes from those
 * rows. More means matches are common, and a scan in page order finds a page
 * of them quickly.
 */
const INDEXED_MATCHES = 2000
/** The index needs three characters to look anything up. */
const MIN_INDEXED_SEARCH = 3
/**
 * A search that the index cannot answer reads at most this many lines per
 * page. Queries run on the event loop, so one request must never hold up the
 * log streams and every other request for long.
 */
const SCAN_BUDGET = 100_000

export interface LogStoreOptions {
  /** For tests: lines a search may read per page. */
  scanBudget?: number
}

/** Stored log lines. All queries are parameterised; filter values never become SQL. */
export class LogStore {
  private readonly db: DatabaseSync
  private readonly insert: StatementSync
  private readonly statements = new Map<string, StatementSync>()
  private readonly scanBudget: number

  constructor(db: DatabaseSync, options: LogStoreOptions = {}) {
    this.db = db
    this.scanBudget = options.scanBudget ?? SCAN_BUDGET
    this.insert = db.prepare(
      `INSERT INTO logs (instance, ts, received_at, plugin, level, system, raw, message_offset, search)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
  }

  /** Store lines in one transaction and return them with their ids. */
  append(lines: readonly NewLogLine[]): LogLine[] {
    return transaction(this.db, () => lines.map((line) => {
      const message = line.raw.slice(line.messageOffset)
      const result = this.insert.run(
        line.instance, line.ts, line.receivedAt, line.plugin, line.level,
        line.system ? 1 : 0, line.raw, line.messageOffset, searchText(line.plugin, message),
      )
      return {
        id: Number(result.lastInsertRowid),
        instance: line.instance,
        ts: line.ts,
        plugin: line.plugin,
        level: line.level,
        message,
        system: line.system,
      }
    }))
  }

  /**
   * The newest `limit` matching lines before the line `beforeId`, oldest first.
   * Lines are in log time order, so instances that replay their logs at
   * different moments still interleave.
   */
  page(filter: LogFilter, limit: number, beforeId?: number): LogPage {
    const latestId = this.latestId()
    const where = this.filterSql(filter)
    if (beforeId !== undefined) {
      where.clauses.push('(ts, id) < (SELECT ts, id FROM logs WHERE id = ?)')
      where.params.push(beforeId)
    }
    // A scan reads no further back than the line `scanBudget` lines before the cursor.
    const bound = where.isScan ? this.scanBound(beforeId) : undefined
    if (bound) {
      where.clauses.push('(ts, id) >= (?, ?)')
      where.params.push(bound.ts, bound.id)
    }
    const size = Math.min(Math.max(limit, 1), MAX_PAGE)
    const rows = this.query(where, 'ORDER BY ts DESC, id DESC LIMIT ?', [size + 1])
    const lines = rows.slice(0, size).reverse().map(toLogLine)
    if (bound && rows.length <= size) {
      return { lines, hasMore: true, latestId, nextBefore: bound.id }
    }
    return { lines, hasMore: rows.length > size, latestId }
  }

  /** The line `scanBudget` lines back in page order from the cursor, or undefined when the log is shorter than that. */
  private scanBound(beforeId: number | undefined): { ts: number, id: number } | undefined {
    const cursor = beforeId === undefined ? '' : 'WHERE (ts, id) < (SELECT ts, id FROM logs WHERE id = ?)'
    const params = beforeId === undefined ? [this.scanBudget - 1] : [beforeId, this.scanBudget - 1]
    const row = asRecord(this.statement(`SELECT ts, id FROM logs ${cursor} ORDER BY ts DESC, id DESC LIMIT 1 OFFSET ?`).get(...params))
    const ts = asNumber(row?.ts)
    const id = asNumber(row?.id)
    return ts === null || id === null ? undefined : { ts, id }
  }

  /** Lines newer than `afterId`, oldest first, for a stream that reconnects. */
  after(afterId: number, limit: number): LogLine[] {
    return this.query({ clauses: ['id > ?'], params: [afterId] }, 'ORDER BY id ASC LIMIT ?', [limit]).map(toLogLine)
  }

  latestId(): number {
    return asNumber(asRecord(this.statement('SELECT MAX(id) AS id FROM logs').get())?.id) ?? 0
  }

  /** The newest Homebridge lines of one instance as plain text, oldest first. */
  recentPlain(instance: string, limit: number): string[] {
    const rows = this.statement('SELECT raw FROM logs WHERE instance = ? AND system = 0 ORDER BY id DESC LIMIT ?').all(instance, limit)
    return rows.reverse().map((row) => stripAnsiText(asString(asRecord(row)?.raw) ?? '')).filter((plain) => plain.trim() !== '')
  }

  /** Errors and warnings per instance and plugin logged since `since`. */
  counts(since: number): LogCount[] {
    const rows = this.statement(
      `SELECT instance, plugin, level, COUNT(*) AS count FROM logs
       WHERE ts >= ? AND level IN ('error', 'warn') AND system = 0
       GROUP BY instance, plugin, level ORDER BY count DESC`,
    ).all(since)
    return rows.map(readCount)
  }

  /**
   * The highest id that the line cap removes: the cap keeps the newest
   * `maxRows` ids. Ids only grow, so this is one index lookup, where counting
   * rows would read the whole table. 0 when nothing is over the cap.
   */
  capThreshold(maxRows: number): number {
    return Math.max(0, this.latestId() - maxRows)
  }

  /**
   * Delete up to `batch` lines that arrived before the cutoff, then, with what
   * is left of the batch, the oldest lines up to `capId`. Returns how many
   * went; fewer than `batch` means there is nothing more to delete.
   */
  pruneBatch(cutoff: number, capId: number, batch: number): number {
    let removed = Number(this.statement('DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE received_at < ? LIMIT ?)')
      .run(cutoff, batch).changes)
    if (removed < batch && capId > 0) {
      removed += Number(this.statement('DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE id <= ? ORDER BY id LIMIT ?)')
        .run(capId, batch - removed).changes)
    }
    return removed
  }

  /** Let SQLite refresh the statistics that its query planner uses. Cheap when nothing changed. */
  optimize(): void {
    this.db.exec('PRAGMA optimize')
  }

  private query(where: Where, tail: string, tailParams: SQLInputValue[]): Row[] {
    const clause = where.clauses.length > 0 ? `WHERE ${where.clauses.join(' AND ')}` : ''
    const sql = `SELECT ${COLUMNS} FROM logs ${clause} ${tail}`
    return this.statement(sql).all(...where.params, ...tailParams).map(readRow)
  }

  /** Every SQL text comes from a fixed set of shapes, so this cache stays small. */
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  private filterSql(filter: LogFilter): Where {
    const where: Where = { clauses: [], params: [], isScan: false }
    const instances = [...new Set(filter.instances ?? [])]
    if (instances.length === 1) {
      where.clauses.push('instance = ?')
      where.params.push(instances[0] ?? '')
    } else if (instances.length > 1) {
      where.clauses.push('instance IN (SELECT value FROM json_each(?))')
      where.params.push(JSON.stringify(instances))
    }
    if (filter.minLevel === 'error') {
      where.clauses.push("level = 'error'")
    } else if (filter.minLevel === 'warn') {
      where.clauses.push("level IN ('error', 'warn')")
    }
    if (filter.plugin === CORE_PLUGIN) {
      where.clauses.push('plugin IS NULL AND system = 0')
    } else if (filter.plugin) {
      where.clauses.push('plugin = ?')
      where.params.push(filter.plugin)
    }
    const query = searchQuery(filter.search ?? '')
    if (query) {
      const ids = this.indexedMatches(query)
      where.clauses.push(ids ? 'id IN (SELECT value FROM json_each(?))' : 'instr(search, ?) > 0')
      where.params.push(ids ? JSON.stringify(ids) : query)
      where.isScan = ids === null
    }
    return where
  }

  /** The ids of every line that contains `query`, or null when the index cannot give them cheaply. */
  private indexedMatches(query: string): number[] | null {
    if (Array.from(query).length < MIN_INDEXED_SEARCH) {
      return null
    }
    const { operator, pattern } = indexPattern(query)
    const rows = this.statement(`SELECT rowid AS id FROM logs_fts WHERE search ${operator} ? ORDER BY rowid DESC LIMIT ?`)
      .all(pattern, INDEXED_MATCHES)
    return rows.length < INDEXED_MATCHES ? rows.map((row) => asNumber(asRecord(row)?.id) ?? 0) : null
  }
}

interface Where {
  clauses: string[]
  params: SQLInputValue[]
  /** True when a search has to read lines one by one, because the index could not give the matches. */
  isScan?: boolean
}

/**
 * A substring pattern that the trigram index can use. The index cannot use
 * LIKE with ESCAPE, so GLOB comes first, then LIKE, and brackets only when the
 * text holds wildcards of both kinds.
 */
function indexPattern(query: string): { operator: 'GLOB' | 'LIKE', pattern: string } {
  if (!/[*?[]/.test(query)) {
    return { operator: 'GLOB', pattern: `*${query}*` }
  }
  if (!/[%_]/.test(query)) {
    return { operator: 'LIKE', pattern: `%${query}%` }
  }
  return { operator: 'GLOB', pattern: `*${query.replace(/[*?[]/g, (char) => `[${char}]`)}*` }
}

const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug']

/** A row of the logs table, checked field by field: the database is outside the program. */
function readRow(value: unknown): Row {
  const row = asRecord(value)
  const id = asNumber(row?.id)
  const ts = asNumber(row?.ts)
  const system = asNumber(row?.system)
  const offset = asNumber(row?.message_offset)
  const instance = asString(row?.instance)
  const raw = asString(row?.raw)
  const level = LEVELS.find((each) => each === row?.level)
  const plugin = row?.plugin === null ? null : asString(row?.plugin)
  if (id === null || ts === null || system === null || offset === null || instance === null || raw === null || !level) {
    throw new Error('the logs table returned a row of an unexpected shape')
  }
  if (row?.plugin !== null && plugin === null) {
    throw new Error('the logs table returned a plugin that is not text')
  }
  return { id, ts, system, message_offset: offset, instance, raw, level, plugin }
}

function readCount(value: unknown): LogCount {
  const row = asRecord(value)
  const instance = asString(row?.instance)
  const count = asNumber(row?.count)
  const level = row?.level === 'error' || row?.level === 'warn' ? row.level : null
  const plugin = row?.plugin === null ? null : asString(row?.plugin)
  if (instance === null || count === null || level === null || (row?.plugin !== null && plugin === null)) {
    throw new Error('the error counts query returned a row of an unexpected shape')
  }
  return { instance, plugin, level, count }
}

function toLogLine(row: Row): LogLine {
  return {
    id: row.id,
    instance: row.instance,
    ts: row.ts,
    plugin: row.plugin,
    level: row.level,
    message: row.raw.slice(row.message_offset),
    system: row.system === 1,
  }
}
