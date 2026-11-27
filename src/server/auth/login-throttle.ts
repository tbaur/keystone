/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import { isIPv4, isIPv6 } from 'node:net'

/** Failures allowed before a lock: per client address, and per known user name from any address. */
const FREE_FAILURES = { address: 5, user: 10 } as const
const BASE_LOCK_MS = 60_000
const MAX_LOCK_MS = 15 * 60_000
const FORGET_AFTER_MS = 60 * 60_000
const MAX_TRACKED = 10_000
/** Password checks are slow on purpose and run on libuv's small thread pool, so only this many run at once. */
const MAX_CONCURRENT_CHECKS = 2
/** Above this many failures a minute from everywhere together, every login waits for the next minute. */
const MAX_FAILURES_PER_MINUTE = 300
const MINUTE_MS = 60_000
/** An address that signed in as a user stays trusted for that user this long after its last sign-in. */
const TRUST_MS = 30 * 24 * 60 * 60_000
const MAX_TRUSTED = 10_000

type KeyKind = keyof typeof FREE_FAILURES

interface Entry {
  kind: KeyKind
  failures: number
  lockedUntil: number
  lastFailure: number
  /** Tries that have started but not finished, so parallel tries count before their result is known. */
  inFlight: number
}

/** A try that has its place reserved. Pass it to `finish` exactly once. */
export interface Attempt {
  readonly keys: readonly string[]
  /** The address and user name pair that a success makes trusted, when a name was given. */
  readonly trustKey: string | null
}

export type Outcome = 'success' | 'failure' | 'abandoned'

export type Reservation = { attempt: Attempt } | { retryAfter: number, reason: 'locked' | 'busy' }

/**
 * Slows down password guessing. Per client address: five free failures, then
 * a lock that doubles from one minute up to fifteen. The same per user name
 * after ten failures from any address, whether or not the name exists, so a
 * lock never tells which names are real. A success clears both, and makes
 * that address trusted for that user: its tries are then held back only by
 * the address's own lock, not the user's lock or the cap for everyone, so a
 * guesser elsewhere cannot lock the real user out. A try is reserved before
 * the password check, so a burst of parallel tries cannot all pass before
 * the first failure is counted.
 */
export class LoginThrottle {
  private readonly entries = new Map<string, Entry>()
  /** When each address and user name pair last signed in, oldest first. */
  private readonly trusted = new Map<string, number>()
  private checking = 0
  private minute = { start: -Infinity, failures: 0 }

  /**
   * Reserve a try for `address`, and for `username` when one was given.
   * Returns the attempt, or how many seconds to wait.
   */
  begin(address: string, username: string | null, now = Date.now()): Reservation {
    if (this.checking >= MAX_CONCURRENT_CHECKS) {
      return { retryAfter: 1, reason: 'busy' }
    }
    const trustKey = username === null ? null : `${addressKey(address)} ${username}`
    const isTrusted = trustKey !== null && now - (this.trusted.get(trustKey) ?? -Infinity) < TRUST_MS
    if (!isTrusted && now - this.minute.start < MINUTE_MS && this.minute.failures >= MAX_FAILURES_PER_MINUTE) {
      return { retryAfter: Math.ceil((this.minute.start + MINUTE_MS - now) / 1000), reason: 'locked' }
    }
    const keys = [`address:${addressKey(address)}`, ...(username === null || isTrusted ? [] : [`user:${username}`])]
    const waits = keys.map((key) => this.waitFor(key, now)).filter((wait) => wait !== null)
    const longest = waits.sort((a, b) => b.retryAfter - a.retryAfter)[0]
    if (longest) {
      return longest
    }
    for (const key of keys) {
      this.entry(key, now).inFlight += 1
    }
    this.checking += 1
    return { attempt: { keys, trustKey } }
  }

  finish(attempt: Attempt, outcome: Outcome, now = Date.now()): void {
    this.checking = Math.max(0, this.checking - 1)
    for (const key of attempt.keys) {
      const entry = this.entries.get(key)
      if (!entry) {
        continue
      }
      entry.inFlight = Math.max(0, entry.inFlight - 1)
      if (outcome === 'success') {
        this.entries.delete(key)
      } else if (outcome === 'failure') {
        this.recordFailure(key, entry, now)
      }
    }
    if (outcome === 'success' && attempt.trustKey !== null) {
      this.trust(attempt.trustKey, now)
    }
    if (outcome === 'failure') {
      this.countGlobalFailure(now)
    }
    this.evict(now)
  }

  /** Remember a sign-in, newest last, so the oldest trust goes first when there are too many. */
  private trust(key: string, now: number): void {
    this.trusted.delete(key)
    this.trusted.set(key, now)
    for (const [oldest, at] of this.trusted) {
      if (this.trusted.size <= MAX_TRUSTED && now - at < TRUST_MS) {
        break
      }
      this.trusted.delete(oldest)
    }
  }

  /** How long `key` must wait: while it is locked, or briefly while earlier tries could still use up its free failures. */
  private waitFor(key: string, now: number): { retryAfter: number, reason: 'locked' | 'busy' } | null {
    const entry = this.entries.get(key)
    if (!entry) {
      return null
    }
    if (entry.lockedUntil > now) {
      return { retryAfter: Math.ceil((entry.lockedUntil - now) / 1000), reason: 'locked' }
    }
    const hasRoom = entry.failures + entry.inFlight < FREE_FAILURES[entry.kind] || entry.inFlight === 0
    return hasRoom ? null : { retryAfter: 1, reason: 'busy' }
  }

  private entry(key: string, now: number): Entry {
    let entry = this.entries.get(key)
    if (entry && entry.inFlight === 0 && entry.lockedUntil <= now && now - entry.lastFailure >= FORGET_AFTER_MS) {
      entry.failures = 0
    }
    if (!entry) {
      entry = { kind: key.startsWith('user:') ? 'user' : 'address', failures: 0, lockedUntil: 0, lastFailure: now, inFlight: 0 }
    }
    // Map order is the eviction order, so a key moves to the end when it is used.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  private recordFailure(key: string, entry: Entry, now: number): void {
    entry.failures += 1
    entry.lastFailure = now
    const over = entry.failures - FREE_FAILURES[entry.kind]
    if (over >= 0) {
      entry.lockedUntil = now + Math.min(BASE_LOCK_MS * 2 ** over, MAX_LOCK_MS)
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  private countGlobalFailure(now: number): void {
    if (now - this.minute.start >= MINUTE_MS) {
      this.minute = { start: now, failures: 0 }
    }
    this.minute.failures += 1
  }

  /** Forget the oldest idle, unlocked keys first, so a flood of new addresses cannot push out a lock. */
  private evict(now: number): void {
    if (this.entries.size <= MAX_TRACKED) {
      return
    }
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= MAX_TRACKED) {
        return
      }
      if (entry.inFlight === 0 && entry.lockedUntil <= now) {
        this.entries.delete(key)
      }
    }
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= MAX_TRACKED) {
        return
      }
      if (entry.inFlight === 0) {
        this.entries.delete(key)
      }
    }
  }
}

/**
 * The throttle key of a client address. One IPv6 host usually has a whole /64
 * to pick addresses from, so IPv6 addresses count by their /64.
 */
export function addressKey(address: string): string {
  const plain = address.split('%')[0] ?? address
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(plain)
  if (mapped?.[1]) {
    return mapped[1]
  }
  if (isIPv4(plain) || !isIPv6(plain)) {
    return plain
  }
  const [head = '', tail] = plain.split('::')
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':')
  const tailLength = tailGroups.reduce((sum, group) => sum + (group.includes('.') ? 2 : 1), 0)
  const groups = [...headGroups, ...Array<string>(Math.max(0, 8 - headGroups.length - tailLength)).fill('0'), ...tailGroups]
  return `${groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16)).join(':')}::/64`
}
