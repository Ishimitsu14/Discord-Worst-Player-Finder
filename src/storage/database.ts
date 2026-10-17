import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ensure, hash, keys, translated } from './values.js';
import type { StorageOptions } from './types.js';

const applicationId = 0x44575046;
const schema = `
CREATE TABLE migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL);
CREATE TABLE matches (match_id INTEGER PRIMARY KEY CHECK(match_id > 0), first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
CREATE TABLE artifacts (ref TEXT PRIMARY KEY, kind TEXT NOT NULL, version INTEGER NOT NULL CHECK(version=1), digest TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(kind,digest));
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, match_id INTEGER NOT NULL REFERENCES matches(match_id), side TEXT NOT NULL CHECK(side IN ('radiant','dire')),
 revision INTEGER NOT NULL CHECK(revision>0), origin TEXT NOT NULL CHECK(origin IN ('manual','automatic')), settings TEXT NOT NULL, settings_digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','waiting','needs-attention','succeeded','failed')),
 step TEXT NOT NULL CHECK(step IN ('load-match','wait-parse','build-facts','analyze','publish')), version INTEGER NOT NULL CHECK(version>0),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_run_at INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER, reason TEXT,
 snapshot_ref TEXT REFERENCES artifacts(ref), bundle_ref TEXT REFERENCES artifacts(ref), prepared_ref TEXT REFERENCES artifacts(ref),
 result_attempt_id TEXT REFERENCES external_attempts(id), UNIQUE(match_id,side,revision),
 CHECK((state='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (state!='running' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE UNIQUE INDEX one_unfinished_job ON jobs(match_id,side) WHERE state IN ('queued','running','waiting','needs-attention');
CREATE INDEX ready_jobs ON jobs(state,next_run_at,created_at,id);
CREATE TABLE revision_requests (id TEXT PRIMARY KEY, digest TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id));
CREATE TABLE external_attempts (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), kind TEXT NOT NULL CHECK(kind IN ('parse','analysis','publication')),
 state TEXT NOT NULL CHECK(state IN ('prepared','started','finished','interrupted')), input_ref TEXT NOT NULL REFERENCES artifacts(ref),
 started_ref TEXT REFERENCES artifacts(ref), outcome_ref TEXT REFERENCES artifacts(ref),
 unresolved INTEGER NOT NULL CHECK(unresolved IN (0,1)), released INTEGER NOT NULL CHECK(released IN (0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_active_attempt ON external_attempts(job_id,kind) WHERE released=0 AND (state='prepared' OR unresolved=1);
CREATE TABLE resolutions (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES external_attempts(id), input TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

export function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = run(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}
export function openDatabase(options: StorageOptions): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    keys(options, ['path'], ['clock']);
    ensure(typeof options.path === 'string' && options.path.trim().length > 0 && options.path !== ':memory:' && !/^[a-z]+:\/\//i.test(options.path) && !options.path.startsWith('file:'));
    if (options.clock !== undefined) { keys(options.clock, ['now']); ensure(typeof options.clock.now === 'function'); }
    const path = resolve(options.path); ensure(statSync(dirname(path)).isDirectory());
    db = new DatabaseSync(path);
    const application = db.prepare('PRAGMA application_id').get()!.application_id;
    const version = db.prepare('PRAGMA user_version').get()!.user_version;
    const empty = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length === 0;
    ensure(application === applicationId || application === 0 && version === 0 && empty, 'incompatible-schema');
    ensure(version === 0 && empty || version === 1 && application === applicationId, 'incompatible-schema');
    if (version === 1) {
      ensure(db.prepare('PRAGMA quick_check').all().every(row => row.quick_check === 'ok'), 'integrity-error');
      ensure(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'integrity-error');
      const migrations = db.prepare('SELECT version,checksum FROM migrations ORDER BY version').all();
      ensure(migrations.length === 1 && migrations[0].version === 1 && migrations[0].checksum === hash(schema), 'incompatible-schema');
    }
    db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    ensure(db.prepare('PRAGMA journal_mode').get()!.journal_mode === 'delete' && db.prepare('PRAGMA synchronous').get()!.synchronous === 2
      && db.prepare('PRAGMA foreign_keys').get()!.foreign_keys === 1 && db.prepare('PRAGMA busy_timeout').get()!.timeout === 1000, 'incompatible-schema');
    if (version === 0) {
      const connection = db;
      transaction(connection, () => {
        connection.exec(schema);
        connection.prepare('INSERT INTO migrations VALUES(1,?)').run(hash(schema));
        connection.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=1;`);
      });
    }
    return db;
  } catch (error) { try { db?.close(); } catch {} throw translated(error, 'openStorage'); }
}
