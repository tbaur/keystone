import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync, StatementSync } from 'node:sqlite'

const DAY_MS = 24 * 60 * 60 * 1000
/** A tab that stays open keeps its session; one that is idle for 30 days signs in again. */
export const SESSION_LIFETIME_MS = 30 * DAY_MS
/** However much it is used, a session ends this long after sign-in. */
export const SESSION_MAX_AGE_MS = 90 * DAY_MS
const RENEW_WHEN_LEFT_MS = 15 * DAY_MS

export interface Session {
  username: string
  /** The fingerprint of the password hash that the session was made with. */
  credential: string
  expiresAt: number
  /** True when this check pushed the expiry out, so the caller should resend the cookie. */
  renewed: boolean
}

interface Row {
  username: string
  credential: string
  created_at: number
  expires_at: number
}

/**
 * Sessions live in SQLite so they survive a restart. Only a SHA-256 of each
 * token is stored: a copy of the database cannot sign anyone in.
 */
export class SessionStore {
  private readonly insert: StatementSync
  private readonly select: StatementSync
  private readonly extend: StatementSync
  private readonly remove: StatementSync
  private readonly purge: StatementSync

  constructor(db: DatabaseSync) {
    this.insert = db.prepare('INSERT INTO sessions (token_hash, username, credential, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    this.select = db.prepare('SELECT username, credential, created_at, expires_at FROM sessions WHERE token_hash = ?')
    this.extend = db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
    this.remove = db.prepare('DELETE FROM sessions WHERE token_hash = ?')
    this.purge = db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR created_at <= ?')
  }

  /** Returns the token for the cookie. */
  create(username: string, credential: string, now = Date.now()): { token: string, expiresAt: number } {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = now + SESSION_LIFETIME_MS
    this.insert.run(digest(token), username, credential, now, expiresAt)
    return { token, expiresAt }
  }

  /** The live session for `token`, renewed when it is past half its life. */
  check(token: string, now = Date.now()): Session | null {
    const hash = digest(token)
    const row = this.live(hash, now)
    if (!row) {
      return null
    }
    const session = { username: row.username, credential: row.credential, expiresAt: row.expires_at, renewed: false }
    if (row.expires_at - now > RENEW_WHEN_LEFT_MS) {
      return session
    }
    const expiresAt = Math.min(now + SESSION_LIFETIME_MS, row.created_at + SESSION_MAX_AGE_MS)
    if (expiresAt <= row.expires_at) {
      return session
    }
    this.extend.run(expiresAt, hash)
    return { ...session, expiresAt, renewed: true }
  }

  /** The live session for `token`, without renewing it. */
  peek(token: string, now = Date.now()): Omit<Session, 'renewed'> | null {
    const row = this.live(digest(token), now)
    return row ? { username: row.username, credential: row.credential, expiresAt: row.expires_at } : null
  }

  revoke(token: string): void {
    this.remove.run(digest(token))
  }

  removeExpired(now = Date.now()): void {
    this.purge.run(now, now - SESSION_MAX_AGE_MS)
  }

  private live(hash: string, now: number): Row | null {
    const row = this.select.get(hash) as Row | undefined
    if (!row || row.expires_at <= now || row.created_at + SESSION_MAX_AGE_MS <= now) {
      return null
    }
    return row
  }
}

/** A short fingerprint of a user's password hash. A new password gives a new one, which ends the old sessions. */
export function credentialOf(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('base64url').slice(0, 22)
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}
