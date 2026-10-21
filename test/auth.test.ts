import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { addressKey, LoginThrottle, type Attempt, type Reservation } from '../src/server/auth/login-throttle.ts'
import { hashPassword, isPasswordHash, verifyPassword } from '../src/server/auth/password.ts'
import { credentialOf, SESSION_LIFETIME_MS, SESSION_MAX_AGE_MS, SessionStore } from '../src/server/auth/sessions.ts'
import { openDatabase } from '../src/server/store/database.ts'

const DAY = 24 * 60 * 60 * 1000

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery')
    assert.ok(isPasswordHash(hash))
    assert.equal(await verifyPassword('correct horse battery', hash), true)
    assert.equal(await verifyPassword('correct horse batterz', hash), false)
  })

  it('never matches a malformed hash', async () => {
    assert.equal(await verifyPassword('anything', 'plain-text-password'), false)
  })
})

describe('SessionStore', () => {
  it('accepts a new session until it expires, then not', () => {
    const sessions = new SessionStore(openDatabase(':memory:'))
    const { token } = sessions.create('example', 'credential-1', 0)
    assert.deepEqual(sessions.check(token, DAY), { username: 'example', credential: 'credential-1', expiresAt: SESSION_LIFETIME_MS, renewed: false })
    assert.equal(sessions.check(token, SESSION_LIFETIME_MS), null)
    assert.equal(sessions.check('not-a-token', DAY), null)
  })

  it('pushes the expiry out once half the lifetime has passed', () => {
    const sessions = new SessionStore(openDatabase(':memory:'))
    const { token } = sessions.create('example', 'credential-1', 0)
    const later = 20 * DAY
    assert.deepEqual(sessions.check(token, later), { username: 'example', credential: 'credential-1', expiresAt: later + SESSION_LIFETIME_MS, renewed: true })
  })

  it('ends a session 90 days after sign-in, however often it is used', () => {
    const sessions = new SessionStore(openDatabase(':memory:'))
    const { token } = sessions.create('example', 'credential-1', 0)
    let now = 0
    while (now < SESSION_MAX_AGE_MS - 20 * DAY) {
      now += 20 * DAY
      assert.ok(sessions.check(token, now))
    }
    assert.equal(sessions.check(token, now)?.expiresAt, SESSION_MAX_AGE_MS)
    assert.equal(sessions.check(token, SESSION_MAX_AGE_MS), null)
  })

  it('peeks without renewing', () => {
    const sessions = new SessionStore(openDatabase(':memory:'))
    const { token } = sessions.create('example', 'credential-1', 0)
    assert.equal(sessions.peek(token, 20 * DAY)?.expiresAt, SESSION_LIFETIME_MS)
    assert.equal(sessions.check(token, 20 * DAY)?.renewed, true)
  })

  it('forgets a revoked session', () => {
    const sessions = new SessionStore(openDatabase(':memory:'))
    const { token } = sessions.create('example', 'credential-1')
    sessions.revoke(token)
    assert.equal(sessions.check(token), null)
  })

  it('gives each password hash its own credential fingerprint', () => {
    assert.equal(credentialOf('hash-a'), credentialOf('hash-a'))
    assert.notEqual(credentialOf('hash-a'), credentialOf('hash-b'))
  })
})

function attemptOf(reservation: Reservation): Attempt {
  assert.ok('attempt' in reservation, `expected a try to be allowed, got ${JSON.stringify(reservation)}`)
  return reservation.attempt
}

function fail(throttle: LoginThrottle, address: string, username: string | null = null, now = 0): void {
  throttle.finish(attemptOf(throttle.begin(address, username, now)), 'failure', now)
}

describe('LoginThrottle', () => {
  it('allows five failures, then locks for a minute, then longer', () => {
    const throttle = new LoginThrottle()
    for (let i = 0; i < 5; i++) {
      fail(throttle, '192.0.2.1')
    }
    assert.deepEqual(throttle.begin('192.0.2.1', null, 0), { retryAfter: 60, reason: 'locked' })
    fail(throttle, '192.0.2.1', null, 60_000)
    assert.deepEqual(throttle.begin('192.0.2.1', null, 60_000), { retryAfter: 120, reason: 'locked' })
    assert.ok('attempt' in throttle.begin('192.0.2.2', null, 0))
  })

  it('clears an address after a success', () => {
    const throttle = new LoginThrottle()
    for (let i = 0; i < 5; i++) {
      fail(throttle, '192.0.2.1')
    }
    throttle.finish(attemptOf(throttle.begin('192.0.2.1', null, 60_000)), 'success', 60_000)
    assert.ok('attempt' in throttle.begin('192.0.2.1', null, 60_000))
  })

  it('counts tries that are still running, so a parallel burst cannot pass the limit', () => {
    const throttle = new LoginThrottle()
    const attempts: Attempt[] = []
    const reservations = Array.from({ length: 30 }, () => throttle.begin('192.0.2.1', null, 0))
    for (const reservation of reservations) {
      if ('attempt' in reservation) {
        attempts.push(reservation.attempt)
      }
    }
    assert.equal(attempts.length, 2, 'only two password checks run at once')
    attempts.forEach((attempt) => throttle.finish(attempt, 'failure', 0))
    for (let i = 0; i < 3; i++) {
      fail(throttle, '192.0.2.1')
    }
    assert.equal('retryAfter' in throttle.begin('192.0.2.1', null, 0), true)
  })

  it('does not let a second try start while the first could use up the last free failure', () => {
    const throttle = new LoginThrottle()
    for (let i = 0; i < 4; i++) {
      fail(throttle, '192.0.2.1')
    }
    const first = attemptOf(throttle.begin('192.0.2.1', null, 0))
    assert.deepEqual(throttle.begin('192.0.2.1', null, 0), { retryAfter: 1, reason: 'busy' })
    throttle.finish(first, 'abandoned', 0)
    assert.ok('attempt' in throttle.begin('192.0.2.1', null, 0))
  })

  it('locks a known user name after ten failures from any address', () => {
    const throttle = new LoginThrottle()
    for (let i = 0; i < 10; i++) {
      fail(throttle, `192.0.2.${i + 1}`, 'example')
    }
    assert.equal('retryAfter' in throttle.begin('198.51.100.1', 'example', 0), true)
    assert.ok('attempt' in throttle.begin('198.51.100.1', null, 0))
  })

  it('stops every login for the rest of the minute after 300 failures from anywhere', () => {
    const throttle = new LoginThrottle()
    for (let i = 0; i < 300; i++) {
      fail(throttle, `10.0.${Math.floor(i / 250)}.${i % 250}`, null, 1000)
    }
    assert.deepEqual(throttle.begin('203.0.113.9', null, 30_000), { retryAfter: 31, reason: 'locked' })
    assert.ok('attempt' in throttle.begin('203.0.113.9', null, 61_000))
  })

  it('keeps a lock when many new addresses fail', () => {
    const throttle = new LoginThrottle()
    for (let i = 0; i < 5; i++) {
      fail(throttle, '192.0.2.1')
    }
    for (let i = 0; i < 10_050; i++) {
      throttle.finish(attemptOf(throttle.begin(`2001:db8:${i.toString(16)}::1`, null, 1000)), 'abandoned', 1000)
    }
    assert.equal('retryAfter' in throttle.begin('192.0.2.1', null, 1000), true)
  })
})

describe('addressKey', () => {
  it('groups IPv6 addresses by their /64 and keeps IPv4 as it is', () => {
    assert.equal(addressKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64')
    assert.equal(addressKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'), '2001:db8:1:2::/64')
    assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64')
    assert.equal(addressKey('fe80::1%en0'), 'fe80:0:0:0::/64')
    assert.equal(addressKey('::ffff:192.0.2.7'), '192.0.2.7')
    assert.equal(addressKey('192.0.2.7'), '192.0.2.7')
  })
})
