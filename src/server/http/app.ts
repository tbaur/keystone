import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Health, Overview } from '../../shared/types.ts'
import type { LoginThrottle, Outcome } from '../auth/login-throttle.ts'
import { hashPassword, verifyPassword } from '../auth/password.ts'
import { credentialOf, type Session, type SessionStore } from '../auth/sessions.ts'
import type { Config } from '../config.ts'
import { asRecord, asString } from '../json.ts'
import type { Logger } from '../logger.ts'
import { normalizeUsername } from '../secrets.ts'
import type { LogStore } from '../store/log-store.ts'
import {
  BadRequest, clientAddress, isSameOrigin, parseCookies, readJson, redirect, sendError, sendJson, setSecurityHeaders,
} from './http-utils.ts'
import { parseLogQuery, parseStreamStart } from './log-query.ts'
import { sendAsset, type Asset } from './static-assets.ts'
import type { StreamHub } from './stream-hub.ts'

const SESSION_COOKIE = 'keystone_session'
const MAX_PASSWORD_LENGTH = 1024
const MAX_USERNAME_LENGTH = 64

export interface AppDeps {
  config: Config
  logger: Logger
  sessions: SessionStore
  throttle: LoginThrottle
  store: LogStore
  hub: StreamHub
  dashboard: { overview(): Overview, health(): Health }
  assets: Map<string, Asset>
}

interface Context {
  deps: AppDeps
  req: IncomingMessage
  res: ServerResponse
  url: URL
}

interface Route {
  handler: (ctx: Context) => Promise<void> | void
  /** 'api' answers 401 without a session; 'page' sends the browser to the login page. */
  auth: 'none' | 'api' | 'page'
}

const ROUTES: Record<string, Route> = {
  'GET /healthz': { auth: 'none', handler: health },
  'GET /': { auth: 'page', handler: (ctx) => page(ctx, '/index.html') },
  'GET /login': { auth: 'none', handler: loginPage },
  'POST /api/login': { auth: 'none', handler: login },
  'POST /api/logout': { auth: 'none', handler: logout },
  'GET /api/overview': { auth: 'api', handler: ({ deps, res }) => sendJson(res, 200, deps.dashboard.overview()) },
  'GET /api/logs': { auth: 'api', handler: logs },
  'GET /api/stream': { auth: 'api', handler: stream },
}

/** HEAD gets the GET answer without its body, except where the answer is a stream. */
const NO_HEAD = new Set(['/api/stream'])

/** The request handler. Every error ends as a generic response; details go to the server log only. */
export function createHandler(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  // Ready before the first login, so an unknown name never takes longer than a wrong password.
  unknownUserHash().catch((error: unknown) => deps.logger.error('could not prepare the login check', { error }))
  return (req, res) => void handle(deps, req, res)
}

async function handle(deps: AppDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  setSecurityHeaders(res, deps.config.cookieSecure)
  // The caller drops this promise. A throw here has to stay in the try, or the process exits.
  let path: string | undefined
  try {
    const url = new URL(req.url ?? '/', 'http://dashboard.invalid')
    path = url.pathname
    await route({ deps, req, res, url })
  } catch (error) {
    if (error instanceof BadRequest) {
      sendError(res, 400, 'bad_request', error.message)
      return
    }
    const requestId = randomUUID()
    deps.logger.error('request failed', { requestId, method: req.method, path, error })
    if (res.headersSent) {
      res.destroy()
    } else {
      sendError(res, 500, 'internal', `Something went wrong (request ${requestId}). The server log has details.`)
    }
  }
}

async function route(ctx: Context): Promise<void> {
  const { req, res, url } = ctx
  const method = req.method ?? 'GET'
  const isHead = method === 'HEAD' && !NO_HEAD.has(url.pathname)
  const match = ROUTES[`${isHead ? 'GET' : method} ${url.pathname}`]
  if (!match) {
    serveOther(ctx, method)
    return
  }
  if (match.auth !== 'none' && !authenticate(ctx)) {
    if (match.auth === 'page') {
      redirect(res, '/login')
    } else {
      sendError(res, 401, 'unauthenticated', 'Sign in again.')
    }
    return
  }
  await match.handler(ctx)
}

/** A static file, or 405 for a known path with the wrong method, or 404. */
function serveOther({ deps, req, res, url }: Context, method: string): void {
  const asset = url.pathname.endsWith('.html') ? undefined : deps.assets.get(url.pathname)
  if (asset && (method === 'GET' || method === 'HEAD')) {
    sendAsset(req, res, asset)
    return
  }
  const allowed = asset ? ['GET', 'HEAD'] : allowedMethods(url.pathname)
  if (allowed.length > 0) {
    res.setHeader('allow', allowed.join(', '))
    sendError(res, 405, 'method_not_allowed', `Use ${allowed.join(' or ')} here.`)
    return
  }
  sendError(res, 404, 'not_found', 'Nothing here.')
}

function allowedMethods(path: string): string[] {
  const methods = Object.keys(ROUTES).filter((key) => key.endsWith(` ${path}`)).map((key) => key.split(' ')[0] ?? '')
  return methods.includes('GET') && !NO_HEAD.has(path) ? [...methods, 'HEAD'] : methods
}

/**
 * The session in the request's cookie, when it is live, its user is still in
 * the secrets file, and that user's password has not changed since sign-in.
 * Any other session is deleted.
 */
function validSession(deps: AppDeps, token: string, session: Pick<Session, 'username' | 'credential'> | null): boolean {
  if (!session) {
    return false
  }
  const hash = Object.hasOwn(deps.config.users, session.username) ? deps.config.users[session.username] : undefined
  if (!hash || credentialOf(hash) !== session.credential) {
    deps.sessions.revoke(token)
    return false
  }
  return true
}

/** True for a valid session. Renews the cookie when the session was extended. */
function authenticate({ deps, req, res }: Context): boolean {
  const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
  const session = token ? deps.sessions.check(token) : null
  if (!token || !session || !validSession(deps, token, session)) {
    return false
  }
  if (session.renewed) {
    setSessionCookie(res, token, session, deps.config.cookieSecure)
  }
  return true
}

/** Anyone may ask whether Keystone is healthy; only a signed-in user sees the instance names and states. */
function health(ctx: Context): void {
  const result = ctx.deps.dashboard.health()
  const status = result.status === 'ok' ? 200 : 503
  sendJson(ctx.res, status, authenticate(ctx) ? result : { status: result.status })
}

function page({ deps, req, res }: Context, path: string): void {
  const asset = deps.assets.get(path)
  if (!asset) {
    throw new Error(`${path} is missing from the build; run npm run build`)
  }
  sendAsset(req, res, asset)
}

function loginPage(ctx: Context): void {
  if (authenticate(ctx)) {
    redirect(ctx.res, '/')
    return
  }
  page(ctx, '/login.html')
}

async function login({ deps, req, res }: Context): Promise<void> {
  if (!isSameOrigin(req)) {
    sendError(res, 403, 'cross_site', 'Cross-site requests are refused.')
    return
  }
  const body = asRecord(await readJson(req))
  const typedName = asString(body?.username)
  const password = asString(body?.password)
  if (!typedName || typedName.length > MAX_USERNAME_LENGTH || !password || password.length > MAX_PASSWORD_LENGTH) {
    throw new BadRequest('username and password are required')
  }
  const address = clientAddress(req, deps.config.trustProxy)
  const username = normalizeUsername(typedName)
  const hash = username && Object.hasOwn(deps.config.users, username) ? deps.config.users[username] : undefined
  const reservation = deps.throttle.begin(address, hash ? username : null)
  if ('retryAfter' in reservation) {
    res.setHeader('retry-after', String(reservation.retryAfter))
    const message = reservation.reason === 'busy'
      ? 'Too many sign-ins at once. Try again in a moment.'
      : `Too many attempts. Try again in ${reservation.retryAfter} second${reservation.retryAfter === 1 ? '' : 's'}.`
    sendError(res, 429, 'rate_limited', message)
    return
  }
  let outcome: Outcome = 'abandoned'
  try {
    const isValid = await verifyPassword(password, hash ?? await unknownUserHash())
    outcome = hash && username && isValid ? 'success' : 'failure'
  } finally {
    deps.throttle.finish(reservation.attempt, outcome)
  }
  if (outcome !== 'success' || !hash || !username) {
    // A known name only: people sometimes type their password into the name field.
    deps.logger.warn('login failed', { address, user: hash ? username : null })
    sendError(res, 401, 'invalid_login', 'That user name or password is not right.')
    return
  }
  const session = deps.sessions.create(username, credentialOf(hash))
  setSessionCookie(res, session.token, session, deps.config.cookieSecure)
  deps.logger.info('login', { address, user: username })
  res.writeHead(204).end()
}

let unknownUserHashPromise: Promise<string> | undefined

/** A hash to check against when the user is unknown, so that a wrong name takes as long as a wrong password. */
function unknownUserHash(): Promise<string> {
  unknownUserHashPromise ??= hashPassword(randomUUID())
  return unknownUserHashPromise
}

function logout({ deps, req, res }: Context): void {
  if (!isSameOrigin(req)) {
    sendError(res, 403, 'cross_site', 'Cross-site requests are refused.')
    return
  }
  const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
  if (token) {
    deps.sessions.revoke(token)
    deps.hub.closeEndedSessions()
  }
  setSessionCookie(res, '', { expiresAt: 0 }, deps.config.cookieSecure)
  res.writeHead(204).end()
}

function logs({ deps, res, url }: Context): void {
  const query = parseLogQuery(url.searchParams, deps.config.instances.map((instance) => instance.name))
  sendJson(res, 200, deps.store.page(query.filter, query.limit, query.beforeId))
}

function stream({ deps, req, res, url }: Context): void {
  const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE) ?? ''
  const isAllowed = (): boolean => validSession(deps, token, deps.sessions.peek(token))
  deps.hub.open(res, parseStreamStart(req.headers['last-event-id'], url.searchParams.get('after')), isAllowed)
}

function setSessionCookie(res: ServerResponse, token: string, session: Pick<Session, 'expiresAt'>, isSecure: boolean): void {
  const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000))
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`]
  if (isSecure) {
    parts.push('Secure')
  }
  res.setHeader('set-cookie', parts.join('; '))
}
