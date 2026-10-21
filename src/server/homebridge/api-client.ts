import { ExpectedError } from '../logger.ts'
import { asNumber, asRecord, asString } from '../json.ts'

export type ApiFailure = 'unreachable' | 'unauthorized' | 'http' | 'invalid'

/** A Homebridge UI call that failed. `message` is safe to show in the dashboard. */
export class HomebridgeApiError extends ExpectedError {
  override name = 'HomebridgeApiError'
  readonly kind: ApiFailure
  readonly status: number | null

  constructor(kind: ApiFailure, message: string, options: { status?: number, cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.kind = kind
    this.status = options.status ?? null
  }
}

export interface ApiClientOptions {
  baseUrl: string
  username: string
  password: string
  timeoutMs?: number
  fetch?: typeof fetch
  now?: () => number
}

/**
 * After a rejected login, wait this long before the next one. Homebridge UI
 * locks a user after 10 failures that come less than 5 minutes apart, so one
 * try every 6 minutes can never lock the account.
 */
export const AUTH_RETRY_MS = 6 * 60_000

const DEFAULT_TIMEOUT_MS = 10_000
/** Log in again this long before the token expires, or halfway through a shorter token's life. */
const RENEW_EARLY_MS = 5 * 60_000

interface Token {
  value: string
  renewAt: number
}

/**
 * Talks to one Homebridge UI REST API as a signed-in user. Holds one token,
 * renews it before it expires, and logs in again once after a 401. Every
 * poller and the log stream of an instance share one client, so a rejected
 * login blocks them all until AUTH_RETRY_MS has passed.
 */
export class HomebridgeApi {
  readonly baseUrl: string
  private readonly options: ApiClientOptions
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private token: Token | null = null
  private pendingLogin: Promise<string> | null = null
  private rejected: { error: HomebridgeApiError, until: number } | null = null

  constructor(options: ApiClientOptions) {
    this.options = options
    this.baseUrl = options.baseUrl
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
  }

  /** A valid token, logging in when there is none or it is about to expire. */
  async accessToken(): Promise<string> {
    if (this.token && this.token.renewAt > this.now()) {
      return this.token.value
    }
    if (this.rejected && this.rejected.until > this.now()) {
      throw this.rejected.error
    }
    this.pendingLogin ??= this.login().finally(() => {
      this.pendingLogin = null
    })
    return this.pendingLogin
  }

  /** Forget `token` because Homebridge rejected it. A newer token stays. */
  invalidate(token: string): void {
    if (this.token?.value === token) {
      this.token = null
    }
  }

  /** GET a JSON endpoint under /api. */
  async get(path: string): Promise<unknown> {
    const first = await this.authorizedGet(path)
    if (first.response.status !== 401) {
      return this.json(first.response, path)
    }
    await first.response.body?.cancel()
    this.invalidate(first.token)
    return this.json((await this.authorizedGet(path)).response, path)
  }

  private async authorizedGet(path: string): Promise<{ response: Response, token: string }> {
    const token = await this.accessToken()
    return { response: await this.request(path, { headers: { authorization: `Bearer ${token}` } }), token }
  }

  private async login(): Promise<string> {
    const response = await this.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.options.username, password: this.options.password }),
    })
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      await response.body?.cancel()
      const message = response.status === 429
        ? 'Homebridge UI is refusing logins after too many failures; check the username and password'
        : 'login rejected; check the username and password'
      const error = new HomebridgeApiError('unauthorized', message, { status: response.status })
      this.rejected = { error, until: this.now() + AUTH_RETRY_MS }
      throw error
    }
    const body = asRecord(await this.json(response, '/auth/login'))
    const value = asString(body?.access_token)
    const expiresIn = asNumber(body?.expires_in)
    if (!value || expiresIn === null) {
      throw new HomebridgeApiError('invalid', 'login response had no token')
    }
    this.rejected = null
    const lifetimeMs = expiresIn * 1000
    this.token = { value, renewAt: this.now() + lifetimeMs - Math.min(RENEW_EARLY_MS, lifetimeMs / 2) }
    return value
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let response: Response
    try {
      // A redirect would carry the login body, password included, to wherever it points.
      response = await this.fetch(`${this.baseUrl}/api${path}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      const reason = (error as Error).name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : 'connection failed'
      throw new HomebridgeApiError('unreachable', reason, { cause: error })
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new HomebridgeApiError('http', `${path} redirected (${response.status}); apiUrl must point at Homebridge UI itself`, { status: response.status })
    }
    return response
  }

  private async json(response: Response, path: string): Promise<unknown> {
    if (response.status === 401) {
      await response.body?.cancel()
      throw new HomebridgeApiError('unauthorized', 'token rejected', { status: 401 })
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new HomebridgeApiError('http', `${path} answered ${response.status}`, { status: response.status })
    }
    try {
      return await response.json()
    } catch (error) {
      throw new HomebridgeApiError('invalid', `${path} did not answer with JSON`, { cause: error })
    }
  }
}
