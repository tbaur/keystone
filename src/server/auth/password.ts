import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

/**
 * Password hashes are `scrypt$N$r$p$salt$hash`, with salt and hash in base64url.
 * N = 2^15 takes about 50 ms here, which is slow enough to make guessing
 * expensive and fast enough for a login page.
 */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1 } as const
const KEY_LENGTH = 32
const SALT_LENGTH = 16
const MAX_MEMORY = 64 * 1024 * 1024
const HASH_PATTERN = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]{16,})\$([\w-]{32,})$/

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const key = await derive(password, salt, SCRYPT)
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$')
}

export function isPasswordHash(value: string): boolean {
  return HASH_PATTERN.test(value)
}

/** Constant-time comparison. A malformed hash never matches. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = HASH_PATTERN.exec(encoded)
  if (!match) {
    return false
  }
  const [, n, r, p, salt, hash] = match as unknown as [string, string, string, string, string, string]
  const expected = Buffer.from(hash, 'base64url')
  const actual = await derive(password, Buffer.from(salt, 'base64url'), { N: Number(n), r: Number(r), p: Number(p) }, expected.length)
  return timingSafeEqual(actual, expected)
}

function derive(password: string, salt: Buffer, params: { N: number, r: number, p: number }, length = KEY_LENGTH): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: MAX_MEMORY }
  return new Promise((resolvePromise, reject) => {
    scrypt(password.normalize('NFKC'), salt, length, options, (error, key) => {
      if (error) {
        reject(error)
      } else {
        resolvePromise(key)
      }
    })
  })
}
