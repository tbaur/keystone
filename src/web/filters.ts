/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import type { LogLine } from '../shared/types.ts'
import { stripAnsi } from './ansi.ts'

export type LevelFilter = '' | 'warn' | 'error'

export interface Filters {
  /** The instances to show. Empty shows all. */
  instances: string[]
  level: LevelFilter
  plugin: string
  search: string
}

export const NO_FILTERS: Filters = { instances: [], level: '', plugin: '', search: '' }

/**
 * The plugin filter for lines from Homebridge itself, which have no plugin.
 * A plugin name cannot hold `]`, so no plugin can have this name. The server
 * (src/server/store/log-store.ts) uses the same value; a test keeps them equal.
 */
export const CORE_PLUGIN = '[core]'
/** The longest search and plugin name that the server accepts (src/server/http/log-query.ts); a test keeps them equal. */
export const MAX_SEARCH = 200
export const MAX_PLUGIN = 80

/** Filters live in the URL, so a bookmark or a reload keeps them. Values longer than the server accepts are cut to fit. */
export function readFilters(search: string): Filters {
  const params = new URLSearchParams(search)
  const level = params.get('level') ?? ''
  return {
    instances: (params.get('instance') ?? '').split(',').filter(Boolean),
    level: level === 'warn' || level === 'error' ? level : '',
    plugin: (params.get('plugin') ?? '').trim().slice(0, MAX_PLUGIN),
    search: (params.get('q') ?? '').trim().slice(0, MAX_SEARCH),
  }
}

/** The filters without instances that no longer exist, such as one renamed since a bookmark was made. */
export function withKnownInstances(filters: Filters, known: readonly string[]): Filters {
  const instances = filters.instances.filter((name) => known.includes(name))
  return instances.length === filters.instances.length ? filters : { ...filters, instances }
}

export function isLevelFilter(value: string | undefined): value is LevelFilter {
  return value === '' || value === 'warn' || value === 'error'
}

export function toParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.instances.length > 0) params.set('instance', filters.instances.join(','))
  if (filters.level) params.set('level', filters.level)
  if (filters.plugin) params.set('plugin', filters.plugin)
  if (filters.search) params.set('q', filters.search)
  return params
}

export function isFiltered(filters: Filters): boolean {
  return toParams(filters).size > 0
}

/**
 * The browser-side twin of the server's filter, for lines that arrive live.
 * Search looks in the plugin and the message without colours, lowercased, as
 * `searchText` in src/server/store/search.ts does; a test keeps them the same.
 */
export function matches(line: LogLine, filters: Filters): boolean {
  if (filters.instances.length > 0 && !filters.instances.includes(line.instance)) return false
  if (filters.level === 'error' && line.level !== 'error') return false
  if (filters.level === 'warn' && line.level !== 'error' && line.level !== 'warn') return false
  if (filters.plugin === CORE_PLUGIN) {
    if (line.plugin !== null || line.system) return false
  } else if (filters.plugin && line.plugin !== filters.plugin) {
    return false
  }
  const query = filters.search.trim().toLowerCase()
  if (query) {
    const haystack = `${line.plugin ?? ''} ${stripAnsi(line.message)}`.toLowerCase()
    if (!haystack.includes(query)) return false
  }
  return true
}
