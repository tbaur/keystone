/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'

import type { Config } from '../src/server/config.ts'
import { Maintenance, SetupError, startDashboard, warnAboutPlainHttp } from '../src/server/dashboard-server.ts'
import { isLoopbackHost } from '../src/server/http/http-utils.ts'
import { writeSecretsFile } from '../src/server/secrets.ts'
import { openDatabase, SCHEMA_VERSION } from '../src/server/store/database.ts'
import { LogStore } from '../src/server/store/log-store.ts'
import { fakeWebRoot, memoryLogger, tempDir, waitFor } from './helpers/util.ts'

const HASH = `scrypt$32768$8$1$${'A'.repeat(22)}$${'B'.repeat(43)}`
const MAIN = join(import.meta.dirname, '..', 'src', 'server', 'main.ts')

function config(dataDir: string, overrides: Partial<Config> = {}): Config {
  return {
    listen: { host: '127.0.0.1', port: 0 }, dataDir, retentionDays: 7, users: { example: HASH }, cookieSecure: false,
    trustProxy: false, allowedHosts: ['keystone.example.com'], logLevel: 'debug',
    instances: [{ name: 'example-1', apiUrl: 'http://127.0.0.1:9', uiUrl: 'https://example-1.example.com', username: 'example', password: 'test-password' }],
    ...overrides,
  }
}

describe('isLoopbackHost', () => {
  it('knows the names that always mean this machine, and nothing that only looks like one', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.5', '[::1]', '::1']) {
      assert.equal(isLoopbackHost(host), true, host)
    }
    for (const host of ['127.example.net', '127.0.0.1.example.net', 'host.test', '192.0.2.1', '[2001:db8::1]']) {
      assert.equal(isLoopbackHost(host), false, host)
    }
  })
})

describe('warnAboutPlainHttp', () => {
  it('warns about plain http to another host, even one whose name starts with 127.', () => {
    const urls = ['http://127.example.net:8581', 'http://127.0.0.5:8581', 'http://localhost:8581', 'http://[::1]:8581', 'https://host.test', 'http://host.test']
    const logger = memoryLogger()
    warnAboutPlainHttp({ instances: urls.map((apiUrl, i) => ({ ...config('').instances[0]!, name: `example-${i}`, apiUrl })) }, logger)
    assert.deepEqual(logger.records.map((record) => record.instance), ['example-0', 'example-5'])
  })
})

describe('Maintenance', () => {
  function fakeStore(batches: number[]): { store: ConstructorParameters<typeof Maintenance>[0]['store'], calls: string[] } {
    const calls: string[] = []
    const store = {
      capThreshold: (maxRows: number) => {
        calls.push(`threshold ${maxRows}`)
        return 40
      },
      pruneBatch: (_cutoff: number, capId: number) => {
        calls.push(`batch below ${capId}`)
        return batches.shift() ?? 0
      },
      optimize: () => {
        calls.push('optimize')
      },
    }
    return { store, calls }
  }

  it('works out the cap once, deletes batch after batch with other work between, then cleans up', async () => {
    const { store, calls } = fakeStore([3, 3, 1])
    let expired = 0
    const maintenance = new Maintenance({
      store, sessions: { removeExpired: () => { expired++ } }, logger: memoryLogger(), retentionDays: 7, maxStoredLines: 100, pruneBatch: 3,
    })
    setImmediate(() => calls.push('other work'))
    await maintenance.run()
    assert.deepEqual(calls, ['threshold 100', 'batch below 40', 'other work', 'batch below 40', 'batch below 40', 'optimize'])
    assert.equal(expired, 1)
  })

  it('stops between batches once stopped', async () => {
    const { store, calls } = fakeStore([3, 3, 3, 3])
    const maintenance = new Maintenance({ store, sessions: { removeExpired: () => undefined }, logger: memoryLogger(), retentionDays: 7, pruneBatch: 3 })
    const running = maintenance.run()
    maintenance.stop()
    await running
    assert.equal(calls.filter((call) => call.startsWith('batch')).length, 1)
  })

  it('runs as the server starts', async (t) => {
    const dir = tempDir(t)
    const store = new LogStore(openDatabase(dir))
    store.append([{ instance: 'example-1', ts: 1, receivedAt: 1, plugin: null, level: 'info', system: false, raw: 'old', messageOffset: 0 }])
    const logger = memoryLogger()
    const running = await startDashboard(config(dir), logger, { webRoot: fakeWebRoot(dir) })
    t.after(() => running.close())
    await waitFor(() => logger.records.find((record) => record.msg === 'old log lines removed'))
  })
})

describe('starting the server', () => {
  it('calls only a database from a newer Keystone a setup problem', async (t) => {
    const newer = tempDir(t)
    const db = new DatabaseSync(join(newer, 'dashboard.sqlite'))
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    db.close()
    await assert.rejects(startDashboard(config(newer), memoryLogger(), { webRoot: fakeWebRoot(newer) }), (error: unknown) => {
      assert.ok(error instanceof SetupError)
      assert.match(error.message, /newer than this build/)
      return true
    })
    const dir = tempDir(t)
    const notADirectory = join(dir, 'file')
    writeFileSync(notADirectory, '')
    await assert.rejects(startDashboard(config(notADirectory), memoryLogger(), { webRoot: fakeWebRoot(dir) }), (error: unknown) => {
      assert.ok(error instanceof Error && !(error instanceof SetupError), 'a disk problem may clear, so the service manager should try again')
      assert.match(error.message, /cannot open the database/)
      return true
    })
  })

  it('warns at start while allowedHosts is not set', async (t) => {
    const dir = tempDir(t)
    const logger = memoryLogger()
    const running = await startDashboard(config(dir, { allowedHosts: [] }), logger, { webRoot: fakeWebRoot(dir) })
    t.after(() => running.close())
    assert.ok(logger.records.some((record) => record.level === 'warn' && String(record.msg).startsWith('allowedHosts is not set')))
  })
})

describe('exit codes', () => {
  /** Run the server entry point with `args`, from a directory that holds `files`. */
  function run(t: { after: (fn: () => void) => void }, args: string[], files: (dir: string) => void = () => undefined) {
    const dir = tempDir(t)
    files(dir)
    return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, ...args], { cwd: dir, encoding: 'utf8', timeout: 20_000 })
  }

  function install(dir: string, dataDir: string): void {
    // Both runs stop at the database, before the server listens, so the port is never taken.
    const settings = {
      listen: { port: 65000 }, dataDir, allowedHosts: ['keystone.example.com'],
      instances: [{ name: 'example-1', apiUrl: 'http://127.0.0.1:9', uiUrl: 'https://example-1.example.com', username: 'example' }],
    }
    writeFileSync(join(dir, 'config.json'), JSON.stringify(settings))
    writeSecretsFile(join(dir, 'secrets.json'), { users: { example: HASH }, passwords: { 'example-1': 'test-password' } })
  }

  it('exits 64 for a wrong command line', (t) => {
    const result = run(t, ['--nonsense'])
    assert.equal(result.status, 64)
    assert.match(result.stderr, /usage:/)
  })

  it('exits 78 for a missing config, and says it is missing', (t) => {
    const result = run(t, ['--config', 'nowhere.json'])
    assert.equal(result.status, 78)
    assert.match(result.stderr, /the file is missing/)
  })

  it('exits 78 for a database from a newer Keystone, and 1 for a database it cannot open', (t) => {
    const newer = run(t, [], (dir) => {
      install(dir, 'data')
      const db = openDatabase(join(dir, 'data'))
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
      db.close()
    })
    assert.equal(newer.status, 78, newer.stdout + newer.stderr)
    assert.match(newer.stdout, /start failed/)
    const blocked = run(t, [], (dir) => {
      install(dir, 'data')
      writeFileSync(join(dir, 'data'), '')
    })
    assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr)
    assert.match(blocked.stdout, /cannot open the database/)
  })
})
