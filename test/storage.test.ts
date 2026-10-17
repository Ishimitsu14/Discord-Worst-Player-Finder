import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, unlink, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { openStorage, StorageError, type Storage } from '../src/storage/index.js';

const settings = { steamAccountIds: [123, 456], guildId: '18446744073709551615', channelId: '9007199254740993' };
const input = () => ({ matchId: 101, side: 'radiant' as const, origin: 'manual' as const, settings: structuredClone(settings) });
function errorIs(code: StorageError['code']) { return (error: unknown) => { assert.ok(error instanceof StorageError); assert.equal(error.code, code); assert.equal(error.cause, undefined); return true; }; }
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'storage-')), path = join(root, 'app.sqlite'); let now = 1000;
  const stores: Storage[] = [];
  t.after(async () => { stores.forEach(store => store.close()); for (const name of await readdir(root)) await unlink(join(root, name)); await rmdir(root); });
  return { root, path, advance: (ms = 60001) => { now += ms; }, open: () => { const store = openStorage({ path, clock: { now: () => now } }); stores.push(store); return store; } };
}

test('storage: import не читает env, не открывает БД и не запускает сеть', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import { syncBuiltinESMExports } from 'node:module';
    import sqlite from 'node:sqlite';
    sqlite.DatabaseSync = class { constructor() { throw Error('unexpected database'); } }; syncBuiltinESMExports();
    globalThis.fetch = () => { throw Error('unexpected network'); };
    const api = await import('./dist/src/storage/index.js');
    assert.deepEqual(Object.keys(api).sort(), ['StorageError','openStorage']);
  `], { cwd: resolve('.'), encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
});

test('storage: создание, настройки SQLite, повторное открытие, close и безопасные ошибки', async t => {
  const f = await fixture(t), store = f.open(), job = store.enqueueInitial(input()); store.close(); store.close();
  assert.throws(() => store.getJob(job.id), errorIs('closed'));
  assert.deepEqual(f.open().getJob(job.id), job);
  const db = new DatabaseSync(f.path);
  assert.equal(db.prepare('PRAGMA application_id').get()!.application_id, 0x44575046);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3);
  assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete');
  assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
  db.close();
  assert.throws(() => store.recordMatch({ matchId: -1, observedAt: 1 }), error => {
    assert.ok(error instanceof StorageError); assert.deepEqual(error.toJSON(), { code: 'closed', operation: 'recordMatch', message: 'Storage: closed' }); return true;
  });
});

test('storage: плохие пути и ввод не создают запасную БД', async t => {
  const f = await fixture(t);
  for (const path of ['', ' ', ':memory:', 'file:example.db', 'https://example.test/db']) assert.throws(() => openStorage({ path }), errorIs('invalid-input'));
  assert.throws(() => openStorage({ path: join(f.root, 'missing', 'app.sqlite') }), errorIs('io-error'));
  const store = f.open();
  for (const value of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '101']) assert.throws(() => store.recordMatch({ matchId: value as number, observedAt: 0 }), errorIs('invalid-input'));
  for (const changes of [{ side: 'unknown' }, { origin: 'unknown' }, { settings: { ...settings, apiKey: 'private-sentinel' } }, { settings: { ...settings, steamAccountIds: [123, 123] } }, { settings: { ...settings, guildId: '01' } }]) {
    assert.throws(() => store.enqueueInitial({ ...input(), ...changes } as ReturnType<typeof input>), error => { assert.ok(error instanceof StorageError); assert.ok(!JSON.stringify(error).includes('private-sentinel')); return true; });
  }
  assert.equal(store.getLatestJob(101, 'radiant'), null);
});

test('storage: чужая, повреждённая, более новая БД и checksum отклоняются без перезаписи', async t => {
  const f = await fixture(t);
  await writeFile(f.path, 'not sqlite'); const before = await readFile(f.path);
  assert.throws(() => f.open(), errorIs('integrity-error')); assert.deepEqual(await readFile(f.path), before);
  await unlink(f.path);
  let db = new DatabaseSync(f.path); db.exec('CREATE TABLE foreign_data(value); INSERT INTO foreign_data VALUES(42)'); db.close();
  assert.throws(() => f.open(), errorIs('incompatible-schema'));
  db = new DatabaseSync(f.path); assert.equal(db.prepare('SELECT value FROM foreign_data').get()!.value, 42); db.close(); await unlink(f.path);
  f.open().close(); db = new DatabaseSync(f.path); db.exec('PRAGMA user_version=4'); db.close();
  assert.throws(() => f.open(), errorIs('incompatible-schema'));
  db = new DatabaseSync(f.path); db.exec("PRAGMA user_version=1; UPDATE migrations SET checksum='invalid'"); db.close();
  assert.throws(() => f.open(), errorIs('incompatible-schema'));
});

test('storage: ошибка внутри миграции откатывает DDL и номер версии', async t => {
  const f = await fixture(t), original = DatabaseSync.prototype.exec;
  const fault = t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
    if (sql.includes('CREATE TABLE migrations')) { original.call(this, sql.slice(0, sql.indexOf(';') + 1)); throw Error('synthetic migration failure'); }
    return original.call(this, sql);
  });
  assert.throws(() => f.open(), errorIs('io-error')); fault.mock.restore();
  const db = new DatabaseSync(f.path); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 0); assert.equal(db.prepare('PRAGMA application_id').get()!.application_id, 0);
  assert.deepEqual(db.prepare('SELECT name FROM sqlite_master').all(), []); db.close(); f.open().close();
});

test('storage: busy ограничен, транзакция не сообщает успех и не теряет задачу', async t => {
  const f = await fixture(t), store = f.open(), other = new DatabaseSync(f.path); const job = store.enqueueInitial(input());
  other.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => store.claimNext(), errorIs('busy')); } finally { other.exec('ROLLBACK'); other.close(); }
  assert.equal(store.getJob(job.id).state, 'queued'); assert.equal(store.claimNext()!.job.id, job.id);
});

test('storage: обнаружения и дедупликация ручного/автоматического запуска живут после reopen', async t => {
  const f = await fixture(t), store = f.open();
  assert.deepEqual(store.recordMatch({ matchId: 101, observedAt: 100 }), { matchId: 101, firstSeenAt: 100, lastSeenAt: 100 });
  assert.deepEqual(store.recordMatch({ matchId: 101, observedAt: 50 }), { matchId: 101, firstSeenAt: 50, lastSeenAt: 100 });
  const job = store.enqueueInitial({ ...input(), origin: 'automatic' });
  const repeated = store.enqueueInitial({ ...input(), settings: { ...settings, channelId: '2' } }); assert.deepEqual(repeated, job);
  const claim = store.claimNext()!.claim; store.finish(claim, { state: 'failed', reason: 'synthetic stop' }); store.close();
  const reopened = f.open(); assert.equal(reopened.enqueueInitial(input()).id, job.id); assert.equal(reopened.enqueueInitial({ ...input(), side: 'dire' }).revision, 1);
  assert.deepEqual(reopened.getJob(job.id).settings, settings);
});

test('storage: ревизии атомарны, ключи постоянны и unfinished не дублируется', async t => {
  const f = await fixture(t), store = f.open(), other = f.open(), job = store.enqueueInitial(input());
  const request = { requestId: 'revision-request', matchId: 101, side: 'radiant' as const, settings };
  assert.throws(() => store.createRevision({ ...request, matchId: 102 }), errorIs('not-found'));
  assert.throws(() => other.createRevision(request), errorIs('conflict'));
  store.finish(store.claimNext()!.claim, { state: 'failed', reason: 'test' });
  const revision = other.createRevision(request); assert.equal(revision.revision, 2);
  assert.deepEqual(store.createRevision(request), revision);
  assert.throws(() => store.createRevision({ ...request, settings: { ...settings, channelId: '3' } }), errorIs('conflict'));
  assert.throws(() => store.createRevision({ ...request, requestId: 'different-key' }), errorIs('conflict'));
  assert.equal(store.enqueueInitial(input()).id, job.id); assert.equal(store.getLatestJob(101, 'radiant')!.id, revision.id);
});

test('storage: claim, version, сроки, renew и nextRunAt защищают задачу', async t => {
  const f = await fixture(t), store = f.open(), other = f.open(), job = store.enqueueInitial(input());
  const first = store.claimNext()!; assert.equal(other.claimNext(), null);
  let claim = store.renewClaim(first.claim); assert.throws(() => store.renewClaim(first.claim), errorIs('lease-lost'));
  const checkpoint = store.checkpoint(claim, { step: 'build-facts' }); claim = checkpoint.claim;
  assert.throws(() => store.finish(claim, { state: 'succeeded' }), errorIs('conflict'));
  store.defer(claim, { nextRunAt: 2000, reason: 'cooldown' }); assert.equal(other.claimNext(), null);
  f.advance(1000); const next = other.claimNext()!; assert.equal(next.job.id, job.id); assert.notEqual(next.claim.token, claim.token);
  assert.throws(() => store.checkpoint(claim, { step: 'publish' }), errorIs('lease-lost'));
  f.advance(); assert.throws(() => other.renewClaim(next.claim), errorIs('lease-lost'));
});

test('storage: готовые задачи с одинаковым временем имеют стабильный порядок', async t => {
  const f = await fixture(t), store = f.open();
  const jobs = [store.enqueueInitial(input()), store.enqueueInitial({ ...input(), matchId: 102 }), store.enqueueInitial({ ...input(), matchId: 103 })];
  const ids = jobs.map(job => job.id).sort();
  for (const expected of ids) { const current = store.claimNext()!; assert.equal(current.job.id, expected); store.finish(current.claim, { state: 'failed', reason: 'synthetic stop' }); }
});
