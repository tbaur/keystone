import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, resolve } from 'node:path'

import { isLevel, type Level } from './logger.ts'
import { asArray, asRecord, type JsonRecord } from './json.ts'
import { loadSecrets } from './secrets.ts'

export interface InstanceSettings {
  /** Short id shown in the dashboard, such as "example-1". */
  name: string
  /** The Homebridge UI as the server reaches it, usually loopback. */
  apiUrl: string
  /** The Homebridge UI as a browser reaches it, for links. May have a path. */
  uiUrl: string
  username: string
}

/** What config.json holds. It has no secrets, so a deploy tool can write it. */
export interface Settings {
  listen: { host: string, port: number }
  /** Absolute. Holds the SQLite database. */
  dataDir: string
  /** Absolute. The Keystone users' password hashes and the Homebridge passwords. */
  secretsFile: string
  retentionDays: number
  /** Mark the session cookie Secure. Only turn off for plain http on a LAN. */
  cookieSecure: boolean
  /**
   * Take the client address from X-Real-IP when the request comes from
   * loopback. Only for a reverse proxy on the same host that sets the header,
   * since any local process could otherwise pick its own address.
   */
  trustProxy: boolean
  logLevel: Level
  instances: InstanceSettings[]
}

export interface InstanceConfig extends InstanceSettings {
  password: string
}

/** The settings with their secrets, as the server runs with them. */
export interface Config extends Omit<Settings, 'instances' | 'secretsFile'> {
  /** Keystone password hash per user name, made by `npm run secrets`. */
  users: Record<string, string>
  instances: InstanceConfig[]
}

const CONFIG_ENV = 'KEYSTONE_CONFIG'
const LOG_LEVEL_ENV = 'KEYSTONE_LOG_LEVEL'

const INSTANCE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i
const MAX_INSTANCES = 8
const LEVELS_TEXT = 'debug, info, warn or error'
/** Keys that hold secrets. They get their own message, which points at the secrets file. */
const SECRET_KEYS = ['users', 'passwordHash', 'password']
const ROOT_KEYS = ['listen', 'dataDir', 'secretsFile', 'retentionDays', 'cookieSecure', 'trustProxy', 'logLevel', 'instances']
const LISTEN_KEYS = ['host', 'port']
const INSTANCE_KEYS = ['name', 'apiUrl', 'uiUrl', 'username']

export class ConfigError extends Error {
  override name = 'ConfigError'
  readonly problems: string[]

  constructor(path: string, problems: string[]) {
    super(`Invalid config ${path}:\n  - ${problems.join('\n  - ')}`)
    this.problems = problems
  }
}

/** The config path: the `--config` value, then KEYSTONE_CONFIG, then ./config.json. */
export function configPath(flagValue: string | undefined, env: NodeJS.ProcessEnv): string {
  return resolve(flagValue || env[CONFIG_ENV] || 'config.json')
}

/**
 * Read config.json and its secrets file. Throws ConfigError or SecretsError
 * with every problem in that file at once.
 */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = {}): Config {
  const { secretsFile, instances, ...settings } = readSettings(path, env)
  const secrets = loadSecrets(secretsFile, instances.map((instance) => instance.name))
  return {
    ...settings,
    users: secrets.users,
    instances: instances.map((instance) => ({ ...instance, password: secrets.passwords[instance.name] ?? '' })),
  }
}

/** Read and validate config.json alone. */
export function readSettings(path: string, env: NodeJS.ProcessEnv = {}): Settings {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ConfigError(path, [`not valid JSON: ${(error as Error).message}`])
  }
  return parseSettings(raw, { path, env })
}

export function parseSettings(raw: unknown, context: { path: string, env: NodeJS.ProcessEnv }): Settings {
  const problems: string[] = []
  const root = asRecord(raw)
  if (!root) {
    problems.push('the file must hold one JSON object')
  }
  const reader = new Reader(root ?? {}, '', problems)
  reader.onlyKeys(ROOT_KEYS)
  for (const key of SECRET_KEYS) {
    if (key in (root ?? {}) || asArray(root?.instances).some((item) => key in (asRecord(item) ?? {}))) {
      problems.push(`${key} does not belong here, because this file is not secret; \`npm run secrets\` writes it to the secrets file`)
    }
  }
  const base = dirname(context.path)
  const settings: Settings = {
    listen: parseListen(root?.listen, problems),
    dataDir: resolve(base, reader.optionalString('dataDir') ?? 'data'),
    secretsFile: resolve(base, reader.optionalString('secretsFile') ?? 'secrets.json'),
    retentionDays: reader.integer('retentionDays', 7, [1, 90]),
    cookieSecure: reader.boolean('cookieSecure', true),
    trustProxy: reader.boolean('trustProxy', false),
    logLevel: parseLogLevel(reader, context.env, problems),
    instances: parseInstances(root?.instances, problems),
  }
  if (problems.length > 0) {
    throw new ConfigError(context.path, problems)
  }
  return settings
}

/** KEYSTONE_LOG_LEVEL wins over the file when it is set and not empty. Both are checked. */
function parseLogLevel(reader: Reader, env: NodeJS.ProcessEnv, problems: string[]): Level {
  const fromFile = reader.optionalString('logLevel')
  if (fromFile !== undefined && !isLevel(fromFile)) {
    problems.push(`logLevel must be ${LEVELS_TEXT}, not "${fromFile}"`)
  }
  const fromEnv = env[LOG_LEVEL_ENV]
  if (fromEnv) {
    if (isLevel(fromEnv)) {
      return fromEnv
    }
    problems.push(`${LOG_LEVEL_ENV} must be ${LEVELS_TEXT}, not "${fromEnv}"`)
  }
  return fromFile !== undefined && isLevel(fromFile) ? fromFile : 'info'
}

function parseListen(value: unknown, problems: string[]): Settings['listen'] {
  const record = value === undefined ? {} : asRecord(value)
  if (!record) {
    problems.push('listen must be an object such as { "host": "127.0.0.1", "port": 8590 }')
  }
  const reader = new Reader(record ?? {}, 'listen.', problems)
  reader.onlyKeys(LISTEN_KEYS)
  const host = reader.optionalString('host') ?? '127.0.0.1'
  if (!isIP(host) && !HOST_NAME.test(host)) {
    problems.push(`listen.host must be an IP address or a host name, not "${host}"`)
  }
  return { host, port: reader.integer('port', 8590, [1, 65535]) }
}

function parseInstances(value: unknown, problems: string[]): InstanceSettings[] {
  const items = asArray(value)
  if (items.length === 0 || items.length > MAX_INSTANCES) {
    problems.push(`instances must list 1 to ${MAX_INSTANCES} Homebridge instances`)
  }
  const instances = items.map((item, index) => parseInstance(item, `instances[${index}].`, problems))
  const names = instances.map((instance) => instance.name)
  const duplicates = names.filter((name, index) => name && names.indexOf(name) !== index)
  if (duplicates.length > 0) {
    problems.push(`instance names must be unique: ${[...new Set(duplicates)].join(', ')}`)
  }
  return instances
}

function parseInstance(value: unknown, prefix: string, problems: string[]): InstanceSettings {
  const reader = new Reader(asRecord(value) ?? {}, prefix, problems)
  reader.onlyKeys(INSTANCE_KEYS)
  const name = reader.string('name')
  if (name && !INSTANCE_NAME.test(name)) {
    problems.push(`${prefix}name must be lowercase letters, digits and dashes, up to 32 characters, starting with a letter or digit`)
  }
  return {
    name,
    apiUrl: reader.url('apiUrl', { allowPath: false }),
    uiUrl: reader.url('uiUrl', { allowPath: true }),
    username: reader.string('username'),
  }
}

/** Reads typed fields from one object and records a problem for each bad one. */
class Reader {
  private readonly record: JsonRecord
  private readonly prefix: string
  private readonly problems: string[]

  constructor(record: JsonRecord, prefix: string, problems: string[]) {
    this.record = record
    this.prefix = prefix
    this.problems = problems
  }

  string(key: string): string {
    const value = this.record[key]
    if (typeof value !== 'string' || value.length === 0) {
      this.problems.push(`${this.prefix}${key} is required`)
      return ''
    }
    return value
  }

  optionalString(key: string): string | undefined {
    const value = this.record[key]
    if (value === undefined) {
      return undefined
    }
    if (typeof value !== 'string' || value.length === 0) {
      this.problems.push(`${this.prefix}${key} must be a non-empty string`)
      return undefined
    }
    return value
  }

  integer(key: string, fallback: number, [min, max]: [number, number]): number {
    const value = this.record[key] ?? fallback
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      this.problems.push(`${this.prefix}${key} must be a whole number from ${min} to ${max}`)
      return fallback
    }
    return value
  }

  boolean(key: string, fallback: boolean): boolean {
    const value = this.record[key] ?? fallback
    if (typeof value !== 'boolean') {
      this.problems.push(`${this.prefix}${key} must be true or false`)
      return fallback
    }
    return value
  }

  /** Report every key that is not in `allowed`, so a typo does not silently fall back to a default. */
  onlyKeys(allowed: readonly string[]): void {
    for (const key of Object.keys(this.record)) {
      if (!allowed.includes(key) && !SECRET_KEYS.includes(key)) {
        this.problems.push(`${this.prefix}${key} is not a setting; check the spelling`)
      }
    }
  }

  /**
   * An http or https URL without a trailing slash. The Homebridge UI API must
   * be at the root of its origin, because the log socket always is. A link
   * may have a path, for a Homebridge UI behind a proxy at a sub-path.
   */
  url(key: string, options: { allowPath: boolean }): string {
    const name = `${this.prefix}${key}`
    const value = this.string(key)
    if (!value) {
      return ''
    }
    let url: URL
    try {
      url = new URL(value)
    } catch {
      this.problems.push(`${name} is not a URL`)
      return ''
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      this.problems.push(`${name} must be http or https`)
    }
    if (url.username || url.password) {
      this.problems.push(`${name} must not hold a user name or password; \`npm run secrets\` stores the password`)
    }
    if (url.search || url.hash) {
      this.problems.push(`${name} must not have a query or fragment`)
    }
    const path = url.pathname.replace(/\/+$/, '')
    if (path && !options.allowPath) {
      this.problems.push(`${name} must be the Homebridge UI origin with no path, such as http://127.0.0.1:8581`)
    }
    return options.allowPath ? `${url.origin}${path}` : url.origin
  }
}
