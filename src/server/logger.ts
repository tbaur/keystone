/** Structured JSON logging, one object per line on stdout. */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type Level = (typeof LOG_LEVELS)[number]

export type Fields = Record<string, unknown>

export interface Logger {
  debug(msg: string, fields?: Fields): void
  info(msg: string, fields?: Fields): void
  warn(msg: string, fields?: Fields): void
  error(msg: string, fields?: Fields): void
  child(fields: Fields): Logger
}

export interface LoggerOptions {
  level: Level
  write?: (line: string) => void
  base?: Fields
}

export function isLevel(value: string): value is Level {
  return (LOG_LEVELS as readonly string[]).includes(value)
}

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(line))
  const minimum = LOG_LEVELS.indexOf(options.level)
  const base = options.base ?? {}

  const emit = (level: Level, msg: string, fields: Fields = {}): void => {
    if (LOG_LEVELS.indexOf(level) < minimum) {
      return
    }
    const core = { time: new Date().toISOString(), level, msg }
    // The core keys come first in the line, and a field of the same name cannot replace them.
    const record = { ...core, ...base, ...serializeFields(fields), ...core }
    write(`${JSON.stringify(record)}\n`)
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  }
}

/** Errors serialise as their name and message. Stacks stay out of the log unless the error is unexpected. */
function serializeFields(fields: Fields): Fields {
  const out: Fields = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? serializeError(value) : value
  }
  return out
}

const ERROR_DETAILS = ['code', 'kind', 'status'] as const
const MAX_CAUSES = 3

function serializeError(error: Error, depth = 0): Fields {
  const out: Fields = { name: error.name, message: error.message }
  for (const key of ERROR_DETAILS) {
    const value = (error as Partial<Record<typeof key, unknown>>)[key]
    if (typeof value === 'string' || typeof value === 'number') {
      out[key] = value
    }
  }
  // fetch() hides the system error (ECONNREFUSED, ENOTFOUND, a certificate error) in its cause.
  if (error.cause instanceof Error && depth < MAX_CAUSES) {
    out.cause = serializeError(error.cause, depth + 1)
  }
  if (!(error instanceof ExpectedError) && depth === 0) {
    out.stack = error.stack
  }
  return out
}

/** A failure that the code handles on purpose, such as an unreachable instance. Logged without a stack. */
export class ExpectedError extends Error {
  override name = 'ExpectedError'
}
