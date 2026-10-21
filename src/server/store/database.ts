import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { searchText } from './search.ts'

const DATABASE_FILE = 'dashboard.sqlite'

/**
 * Each entry moves the schema up one version. Append new entries; never edit
 * an old one, because a database that already ran it will not run it again.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE logs (
     id INTEGER PRIMARY KEY,
     instance TEXT NOT NULL,
     ts INTEGER NOT NULL,
     received_at INTEGER NOT NULL,
     plugin TEXT,
     level TEXT NOT NULL,
     system INTEGER NOT NULL DEFAULT 0,
     raw TEXT NOT NULL,
     plain TEXT NOT NULL,
     message_offset INTEGER NOT NULL
   );
   CREATE INDEX logs_instance_id ON logs (instance, id);
   CREATE INDEX logs_level_id ON logs (level, id);
   CREATE INDEX logs_received_at ON logs (received_at);
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );`,
  'CREATE INDEX logs_ts_id ON logs (ts, id);',
  // Sessions from before user names belong to no one, so they end.
  `DELETE FROM sessions;
   ALTER TABLE sessions ADD COLUMN username TEXT NOT NULL DEFAULT '';`,
  // Search the plugin and message, lowercased, through a trigram index. The
  // index stores no positions (detail=none), which keeps it near the size of
  // the text. Indexes match the filters, each in page order. Sessions record
  // which password they were made with; older sessions have none and end.
  `ALTER TABLE logs ADD COLUMN search TEXT NOT NULL DEFAULT '';
   UPDATE logs SET search = keystone_search(plugin, raw, message_offset);
   ALTER TABLE logs DROP COLUMN plain;
   CREATE VIRTUAL TABLE logs_fts USING fts5(search, content='logs', content_rowid='id', tokenize='trigram', detail=none);
   INSERT INTO logs_fts (logs_fts) VALUES ('rebuild');
   CREATE TRIGGER logs_fts_insert AFTER INSERT ON logs BEGIN
     INSERT INTO logs_fts (rowid, search) VALUES (new.id, new.search);
   END;
   CREATE TRIGGER logs_fts_delete AFTER DELETE ON logs BEGIN
     INSERT INTO logs_fts (logs_fts, rowid, search) VALUES ('delete', old.id, old.search);
   END;
   DROP INDEX logs_level_id;
   CREATE INDEX logs_instance_ts_id ON logs (instance, ts, id);
   CREATE INDEX logs_plugin_ts_id ON logs (plugin, ts, id);
   CREATE INDEX logs_error_ts_id ON logs (ts, id) WHERE level = 'error';
   CREATE INDEX logs_warn_ts_id ON logs (ts, id) WHERE level IN ('error', 'warn');
   ALTER TABLE sessions ADD COLUMN credential TEXT NOT NULL DEFAULT '';
   DELETE FROM sessions;`,
]

export const SCHEMA_VERSION = MIGRATIONS.length

/**
 * Open (or create) the database in `dataDir` and bring its schema up to date.
 * The directory is made private, since it holds logs and session hashes. Pass
 * ':memory:' for tests.
 */
export function openDatabase(dataDir: string): DatabaseSync {
  let location = ':memory:'
  if (dataDir !== ':memory:') {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    chmodSync(dataDir, 0o700)
    location = join(dataDir, DATABASE_FILE)
  }
  const db = new DatabaseSync(location)
  // A short busy wait: every query runs on the event loop, so a long one would stall the whole server.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 1000;')
  db.function('keystone_search', { deterministic: true }, (plugin, raw, offset) => {
    return searchText(typeof plugin === 'string' ? plugin : null, String(raw).slice(Number(offset)))
  })
  migrate(db)
  return db
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
  const current = row?.user_version ?? 0
  if (current > MIGRATIONS.length) {
    throw new Error(`database schema ${current} is newer than this build (${MIGRATIONS.length}); upgrade Keystone`)
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version] ?? '')
      db.exec(`PRAGMA user_version = ${version + 1}`)
    })
  }
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    // SQLite ends the transaction on its own after some errors, such as a full disk.
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    throw error
  }
}
