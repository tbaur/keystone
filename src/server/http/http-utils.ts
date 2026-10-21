import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'

const MAX_BODY_BYTES = 4096

/** The same headers on every response. The CSP allows nothing but this origin. */
export function setSecurityHeaders(res: ServerResponse, isSecure: boolean): void {
  res.setHeader('content-security-policy', [
    "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
    "connect-src 'self'", "font-src 'self'",
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '))
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('cross-origin-opener-policy', 'same-origin')
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()')
  if (isSecure) {
    res.setHeader('strict-transport-security', 'max-age=31536000')
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/** Errors use one shape: `{ error, message }`. `message` is always safe to show. */
export function sendError(res: ServerResponse, status: number, error: string, message: string): void {
  sendJson(res, status, { error, message })
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store' })
  res.end()
}

export class BadRequest extends Error {
  override name = 'BadRequest'
}

/** Read a small JSON body. Larger or non-JSON bodies are a BadRequest. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new BadRequest('expected application/json')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw new BadRequest('body too large')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BadRequest('body is not JSON')
  }
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const piece of (header ?? '').split(';')) {
    const part = piece.trim()
    const index = part.indexOf('=')
    if (index > 0) {
      cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim())
    }
  }
  return cookies
}

/**
 * The client address. With `trustProxy`, a request from loopback may name the
 * real client in X-Real-IP, as nginx on the same host does. Anything that is
 * not an IP address there is ignored.
 */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  const remote = req.socket.remoteAddress ?? 'unknown'
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const forwarded = req.headers['x-real-ip']
  const claimed = typeof forwarded === 'string' ? forwarded.trim() : ''
  return trustProxy && isLoopback && isIP(claimed) !== 0 ? claimed : remote
}

/** Browsers say where a request came from. Only same-origin or direct requests may change state. */
export function isSameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin' || site === 'none'
}
