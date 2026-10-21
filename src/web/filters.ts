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

/** Filters live in the URL, so a bookmark or a reload keeps them. */
export function readFilters(search: string): Filters {
  const params = new URLSearchParams(search)
  const level = params.get('level') ?? ''
  return {
    instances: (params.get('instance') ?? '').split(',').filter(Boolean),
    level: level === 'warn' || level === 'error' ? level : '',
    plugin: params.get('plugin') ?? '',
    search: params.get('q') ?? '',
  }
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
  if (filters.plugin && line.plugin !== filters.plugin) return false
  const query = filters.search.trim().toLowerCase()
  if (query) {
    const haystack = `${line.plugin ?? ''} ${stripAnsi(line.message)}`.toLowerCase()
    if (!haystack.includes(query)) return false
  }
  return true
}
