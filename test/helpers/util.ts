import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLogger, type Logger } from '../../src/server/logger.ts'

/** A logger that keeps records in memory, for asserting on what was logged. */
export function memoryLogger(): Logger & { records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = []
  const logger = createLogger({ level: 'debug', write: (line) => records.push(JSON.parse(line) as Record<string, unknown>) })
  return Object.assign(logger, { records })
}

export function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'keystone-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A minimal browser build, so the HTTP tests do not depend on `npm run build`. */
export function fakeWebRoot(dir: string): string {
  const root = join(dir, 'web')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>dashboard</title>')
  writeFileSync(join(root, 'login.html'), '<!doctype html><title>login</title>')
  writeFileSync(join(root, 'main.js'), 'export {}')
  return root
}

/** Poll until `check` returns a value, or fail after `timeoutMs`. */
export async function waitFor<T>(check: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs = 5000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await check()
    if (value) {
      return value
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
