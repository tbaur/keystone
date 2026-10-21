import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'

import { openDatabase, SCHEMA_VERSION, transaction } from '../src/server/store/database.ts'
import { LogStore } from '../src/server/store/log-store.ts'
import { tempDir } from './helpers/util.ts'

/** The schema as version 3 left it. */
const VERSION_3 = `
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY, instance TEXT NOT NULL, ts INTEGER NOT NULL, received_at INTEGER NOT NULL,
    plugin TEXT, level TEXT NOT NULL, system INTEGER NOT NULL DEFAULT 0, raw TEXT NOT NULL,
    plain TEXT NOT NULL, message_offset INTEGER NOT NULL
  );
  CREATE INDEX logs_instance_id ON logs (instance, id);
  CREATE INDEX logs_level_id ON logs (level, id);
  CREATE INDEX logs_received_at ON logs (received_at);
  CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE INDEX logs_ts_id ON logs (ts, id);
  ALTER TABLE sessions ADD COLUMN username TEXT NOT NULL DEFAULT '';
  PRAGMA user_version = 3;
`

describe('openDatabase', () => {
  it('moves a version 3 database to the current schema and keeps its lines searchable', (t) => {
    const dir = tempDir(t)
    const old = new DatabaseSync(join(dir, 'dashboard.sqlite'))
    old.exec(VERSION_3)
    old.prepare(`INSERT INTO logs (instance, ts, received_at, plugin, level, raw, plain, message_offset) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('example-1', 1000, 1000, 'Example', 'error', '[t] [Example] \u001b[31mDisk Full', '[t] [Example] Disk Full', 14)
    old.prepare('INSERT INTO sessions (token_hash, created_at, expires_at, username) VALUES (?, ?, ?, ?)').run('hash', 0, 1, 'example')
    old.close()

    const db = openDatabase(dir)
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    assert.equal(version.user_version, SCHEMA_VERSION)
    const columns = (db.prepare('PRAGMA table_info(logs)').all() as Array<{ name: string }>).map((column) => column.name)
    assert.ok(!columns.includes('plain'))
    const store = new LogStore(db)
    assert.deepEqual(store.page({ search: 'disk full' }, 10).lines.map((line) => line.message), ['\u001b[31mDisk Full'])
    assert.deepEqual(store.page({ search: 'example disk' }, 10).lines.length, 1)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 0, 'old sessions end')
    db.close()
  })

  it('refuses a database from a newer build', (t) => {
    const dir = tempDir(t)
    const newer = new DatabaseSync(join(dir, 'dashboard.sqlite'))
    newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    newer.close()
    assert.throws(() => openDatabase(dir), /newer than this build/)
  })

  it('makes the data directory private', (t) => {
    const dir = join(tempDir(t), 'data')
    openDatabase(dir).close()
    assert.equal(statSync(dir).mode & 0o777, 0o700)
  })

  it('uses the filter indexes for the common log pages', () => {
    const db = openDatabase(':memory:')
    const plan = (sql: string, ...params: Array<string | number>): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((row) => row.detail).join('; ')
    assert.match(plan("SELECT id FROM logs WHERE level = 'error' ORDER BY ts DESC, id DESC LIMIT 10"), /logs_error_ts_id/)
    assert.match(plan("SELECT id FROM logs WHERE level IN ('error', 'warn') ORDER BY ts DESC, id DESC LIMIT 10"), /logs_warn_ts_id/)
    assert.match(plan('SELECT id FROM logs WHERE instance = ? ORDER BY ts DESC, id DESC LIMIT 10', 'example-1'), /logs_instance_ts_id/)
    assert.match(plan('SELECT id FROM logs WHERE plugin = ? ORDER BY ts DESC, id DESC LIMIT 10', 'Example'), /logs_plugin_ts_id/)
    assert.doesNotMatch(plan('SELECT id FROM logs ORDER BY ts DESC, id DESC LIMIT 10'), /TEMP B-TREE/)
    db.close()
  })
})

describe('transaction', () => {
  it('rolls back when the work fails, and keeps what came before', () => {
    const db = openDatabase(':memory:')
    db.exec("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES ('kept', 0, 1)")
    assert.throws(() => transaction(db, () => {
      db.exec("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES ('lost', 0, 1)")
      throw new Error('boom')
    }), /boom/)
    assert.equal(db.isTransaction, false)
    assert.deepEqual((db.prepare('SELECT token_hash FROM sessions').all() as Array<{ token_hash: string }>).map((row) => row.token_hash), ['kept'])
    db.close()
  })
})
