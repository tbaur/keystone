import { MAX_PAGE, type LogFilter } from '../store/log-store.ts'
import { BadRequest } from './http-utils.ts'

const DEFAULT_PAGE = 300
const MAX_SEARCH = 200
const MAX_PLUGIN = 80
const PARAMETERS = new Set(['instance', 'level', 'plugin', 'q', 'before', 'limit'])

export interface LogQuery {
  filter: LogFilter
  limit: number
  beforeId?: number
}

/**
 * Parse `GET /api/logs`: `instance` (comma list), `level` (warn or error),
 * `plugin`, `q`, `before` (an id) and `limit`. Anything unexpected is a 400.
 */
export function parseLogQuery(params: URLSearchParams, knownInstances: readonly string[]): LogQuery {
  const unexpected = [...new Set(params.keys())].filter((name) => !PARAMETERS.has(name))
  if (unexpected.length > 0) {
    throw new BadRequest(`unknown parameter: ${unexpected.join(', ')}`)
  }
  const instances = [...new Set((params.get('instance') ?? '').split(',').filter(Boolean))]
  const unknown = instances.filter((name) => !knownInstances.includes(name))
  if (unknown.length > 0) {
    throw new BadRequest(`unknown instance: ${unknown.join(', ')}`)
  }
  const level = params.get('level') ?? ''
  if (level !== '' && level !== 'warn' && level !== 'error') {
    throw new BadRequest('level must be warn or error')
  }
  const filter: LogFilter = {
    instances,
    minLevel: level === '' ? undefined : level,
    plugin: limitedText(params, 'plugin', MAX_PLUGIN),
    search: limitedText(params, 'q', MAX_SEARCH),
  }
  const before = params.get('before')
  return {
    filter,
    limit: positiveInteger(params.get('limit'), 'limit') ?? DEFAULT_PAGE,
    beforeId: before === null ? undefined : positiveInteger(before, 'before'),
  }
}

/** Where a stream starts: the browser's Last-Event-ID on a reconnect, else `?after=`. */
export function parseStreamStart(lastEventId: string | string[] | undefined, after: string | null): number | null {
  const value = typeof lastEventId === 'string' && lastEventId !== '' ? lastEventId : after
  return value === null ? null : (positiveInteger(value, 'after') ?? null)
}

function limitedText(params: URLSearchParams, name: string, max: number): string | undefined {
  const value = params.get(name)?.trim() ?? ''
  if (value.length > max) {
    throw new BadRequest(`${name} is longer than ${max} characters`)
  }
  return value === '' ? undefined : value
}

function positiveInteger(value: string | null, name: string): number | undefined {
  if (value === null || value === '') {
    return undefined
  }
  if (!/^\d{1,15}$/.test(value)) {
    throw new BadRequest(`${name} must be a whole number`)
  }
  const number = Number(value)
  if (name === 'limit' && (number < 1 || number > MAX_PAGE)) {
    throw new BadRequest(`limit must be from 1 to ${MAX_PAGE}`)
  }
  return number
}
