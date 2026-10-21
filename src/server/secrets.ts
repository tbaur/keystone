import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

import { isPasswordHash } from './auth/password.ts'
import { asRecord } from './json.ts'

/** What secrets.json holds. Written by `npm run secrets`, never by hand. */
export interface Secrets {
  /** Keystone password hash per user name. */
  users: Record<string, string>
  /** Homebridge UI password per instance name. */
  passwords: Record<string, string>
}

export class SecretsError extends Error {
  override name = 'SecretsError'
  readonly problems: string[]

  constructor(path: string, problems: string[]) {
    super(`Invalid secrets ${path}:\n  - ${problems.join('\n  - ')}`)
    this.problems = problems
  }
}

const SETUP_HINT = 'run `npm run secrets` to write it'
const USERNAME = /^[a-z0-9][a-z0-9._-]{0,31}$/

/** The canonical user name: trimmed and lowercased. Null when it is not a valid name. */
export function normalizeUsername(value: string): string | null {
  const name = value.trim().toLowerCase()
  return USERNAME.test(name) ? name : null
}

/**
 * Read secrets.json without requiring every value, so `npm run secrets` can
 * keep what is there. Returns null when the file does not exist. The file must
 * give group and others no permissions at all (mode 600 or stricter).
 */
export function readSecretsFile(path: string): Secrets | null {
  let mode: number
  try {
    mode = statSync(path).mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
  if ((mode & 0o077) !== 0) {
    throw new SecretsError(path, [`mode is ${mode.toString(8)}; run chmod 600 on it`])
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new SecretsError(path, [`not valid JSON: ${(error as Error).message}`])
  }
  const root = asRecord(raw) ?? {}
  return { users: nonEmptyStrings(root.users), passwords: nonEmptyStrings(root.passwords) }
}

/** Read secrets.json and require at least one valid user and a password for each instance. */
export function loadSecrets(path: string, instanceNames: readonly string[]): Secrets {
  const found = readSecretsFile(path)
  if (!found) {
    throw new SecretsError(path, [`the file is missing; ${SETUP_HINT}`])
  }
  const problems: string[] = []
  const names = Object.keys(found.users)
  if (names.length === 0) {
    problems.push(`there are no users; ${SETUP_HINT}`)
  }
  for (const [name, hash] of Object.entries(found.users)) {
    if (normalizeUsername(name) !== name) {
      problems.push(`user name ${JSON.stringify(name)} is not valid; use lowercase letters, digits, dots, dashes and underscores`)
    } else if (!isPasswordHash(hash)) {
      problems.push(`the password of ${name} is not a hash from \`npm run secrets\``)
    }
  }
  const missing = instanceNames.filter((name) => !found.passwords[name])
  if (missing.length > 0) {
    problems.push(`no Homebridge password for ${missing.join(', ')}; ${SETUP_HINT}`)
  }
  if (problems.length > 0) {
    throw new SecretsError(path, problems)
  }
  return { users: found.users, passwords: found.passwords }
}

/**
 * Write secrets.json with mode 600. The rename means a reader never sees half
 * a file, and the syncs mean a power cut cannot leave an empty one.
 */
export function writeSecretsFile(path: string, secrets: Secrets): void {
  const temporary = `${path}.${process.pid}.tmp`
  const content: Secrets = { users: secrets.users, passwords: secrets.passwords }
  try {
    const file = openSync(temporary, 'wx', 0o600)
    try {
      writeSync(file, `${JSON.stringify(content, null, 2)}\n`)
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  syncDirectory(dirname(path))
}

/** Make the rename itself durable. Some systems cannot sync a directory, which is fine to skip. */
function syncDirectory(dir: string): void {
  let handle: number | null = null
  try {
    handle = openSync(dir, 'r')
    fsyncSync(handle)
  } catch {
    // The file is already written and renamed; only its durability across a power cut is weaker.
  } finally {
    if (handle !== null) {
      closeSync(handle)
    }
  }
}

function nonEmptyStrings(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(asRecord(value) ?? {})) {
    if (typeof item === 'string' && item.length > 0) {
      result[key] = item
    }
  }
  return result
}
