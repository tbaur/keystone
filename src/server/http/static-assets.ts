import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export interface Asset {
  body: Buffer
  type: string
  etag: string
}

/**
 * Load the built browser files into memory at startup. Requests can only ever
 * get one of these, so there is no path on disk for a request to traverse.
 */
export function loadAssets(root: string): Map<string, Asset> {
  const assets = new Map<string, Asset>()
  for (const file of walk(root)) {
    const type = TYPES[extname(file)]
    if (!type) {
      continue
    }
    const body = readFileSync(file)
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 16)}"`
    assets.set(`/${relative(root, file).split(sep).join('/')}`, { body, type, etag })
  }
  return assets
}

/** Files are small and change only with a deploy, so the browser revalidates by ETag every time. */
export function sendAsset(req: IncomingMessage, res: ServerResponse, asset: Asset): void {
  if (req.headers['if-none-match'] === asset.etag) {
    res.writeHead(304, { etag: asset.etag })
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': asset.type, etag: asset.etag, 'cache-control': 'no-cache' })
  res.end(req.method === 'HEAD' ? undefined : asset.body)
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}
