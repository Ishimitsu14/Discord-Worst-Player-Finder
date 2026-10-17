import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture, jobInput, setup, analyze, errorIs } from './storage-helpers.js';

const contextKey = 'a'.repeat(64), other = 'b'.repeat(64);
const observation = (matchId = 101, observedAt = 1000) => ({ contextKey, matchId, observedAt, expiresAt: observedAt + 60000 });

test('discovery storage: v1 upgrade preserves old jobs, artifacts, attempts, costs and result', async t => {
  const fx = await fixture(t), store = fx.open(), saved = setup(store);
  const result = await analyze(store, saved.claim); store.saveAnalysisOutcome(result.attemptId, result.attempt);
  store.checkpoint(saved.claim, { step: 'publish', resultAttemptId: result.attemptId });
  const before = store.getLatestResult(101, 'radiant'), billing = store.getBillingSummary(); store.close();
  const old = new DatabaseSync(fx.path), checksum = old.prepare('SELECT checksum FROM migrations WHERE version=1').get()!.checksum;
  old.exec('DROP TABLE gemini_recoveries; ALTER TABLE jobs DROP COLUMN analysis_profile; DELETE FROM migrations WHERE version=3; DROP TABLE discovery_candidates; DELETE FROM migrations WHERE version=2; PRAGMA user_version=1'); old.close();
  const upgraded = fx.open(); assert.deepEqual(upgraded.getLatestResult(101, 'radiant'), before); assert.deepEqual(upgraded.getBillingSummary(), billing);
  assert.equal(upgraded.getDiscoveryCandidate(contextKey, 101), null); upgraded.close();
  const db = new DatabaseSync(fx.path); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3);
  assert.equal(db.prepare('SELECT checksum FROM migrations WHERE version=1').get()!.checksum, checksum);
  assert.equal(db.prepare('SELECT count(*) AS count FROM migrations').get()!.count, 3); db.close();
});

test('discovery storage: failed v2 migration rolls back DDL and preserves the v1 job', async t => {
  const fx = await fixture(t), store = fx.open(), job = store.enqueueInitial(jobInput()); store.close();
  let db = new DatabaseSync(fx.path); db.exec('DROP TABLE gemini_recoveries; ALTER TABLE jobs DROP COLUMN analysis_profile; DELETE FROM migrations WHERE version=3; DROP TABLE discovery_candidates; DELETE FROM migrations WHERE version=2; PRAGMA user_version=1'); db.close();
  const exec = DatabaseSync.prototype.exec;
  const fault = t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
    if (sql.includes('CREATE TABLE discovery_candidates')) { exec.call(this, sql.slice(0, sql.indexOf(';') + 1)); throw Error('synthetic v2 failure'); }
    return exec.call(this, sql);
  });
  assert.throws(() => fx.open(), errorIs('io-error')); fault.mock.restore();
  db = new DatabaseSync(fx.path); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='discovery_candidates'").get()!.count, 0); db.close();
  assert.equal(fx.open().getJob(job.id).id, job.id);
});

test('discovery storage: initial candidate has no guessed side or job', async t => {
  const fx = await fixture(t), store = fx.open(), first = store.observeDiscoveryCandidate(observation());
  assert.deepEqual(first, { contextKey, matchId: 101, expiresAt: 61000, firstSeenAt: 1000, lastSeenAt: 1000, state: 'pending', nextCheckAt: 1000, reason: null });
});

test('discovery storage: monotonic observations never reset state, next check or expiry', async t => {
  const fx = await fixture(t), store = fx.open(); store.observeDiscoveryCandidate(observation());
  store.decideDiscoveryCandidate({ contextKey, matchId: 101, state: 'pending', nextCheckAt: 5000, reason: 'opendota-not-found' });
  const seen = store.observeDiscoveryCandidate(observation(101, 2000)); assert.equal(seen.firstSeenAt, 1000); assert.equal(seen.expiresAt, 61000); assert.equal(seen.nextCheckAt, 5000);
  assert.equal(store.observeDiscoveryCandidate(observation(101, 500)).lastSeenAt, 2000);
  store.decideDiscoveryCandidate({ contextKey, matchId: 101, state: 'ignored', nextCheckAt: null, reason: 'outside-window' });
  store.observeDiscoveryCandidate(observation(101, 3000)); assert.equal(store.getDiscoveryCandidate(contextKey, 101)!.state, 'ignored');
  assert.throws(() => store.decideDiscoveryCandidate({ contextKey, matchId: 101, state: 'pending', nextCheckAt: 5000, reason: null }), errorIs('conflict'));
  store.observeDiscoveryCandidate({ ...observation(), contextKey: other }); assert.equal(store.getDiscoveryCandidate(other, 101)!.state, 'pending');
  store.close(); assert.equal(fx.open().getDiscoveryCandidate(contextKey, 101)!.expiresAt, 61000);
});

test('discovery storage: due order, expiry, validation and no fictitious analysis job', async t => {
  const fx = await fixture(t), store = fx.open();
  store.observeDiscoveryCandidate(observation(102)); store.observeDiscoveryCandidate(observation(101));
  assert.deepEqual(store.listDueDiscoveryCandidates(contextKey, 1).map(row => row.matchId), [101]);
  store.decideDiscoveryCandidate({ contextKey, matchId: 101, state: 'pending', nextCheckAt: 100000, reason: 'opendota-rate-limited' });
  assert.deepEqual(store.getDiscoveryCounts(contextKey), { pending: 2, due: 1 });
  fx.advance(); assert.equal(store.listDueDiscoveryCandidates(contextKey, 10).length, 2);
  assert.equal(store.getLatestJob(101, 'radiant'), null);
  for (const bad of [{ contextKey: 'invalid' }, { expiresAt: 1000 }, { matchId: 0 }, { secret: 'synthetic' }]) assert.throws(() => store.observeDiscoveryCandidate({ ...observation(), ...bad }), errorIs('invalid-input'));
  assert.throws(() => store.decideDiscoveryCandidate({ contextKey, matchId: 102, state: 'ignored', nextCheckAt: 12, reason: 'url?key=secret' }), errorIs('invalid-input'));
});

test('discovery storage: enqueue before admitted remains idempotent after crash and manual arrival', async t => {
  const fx = await fixture(t), store = fx.open(); store.observeDiscoveryCandidate(observation());
  const saved = setup(store), manual = saved.job, analyzed = await analyze(store, saved.claim);
  store.saveAnalysisOutcome(analyzed.attemptId, analyzed.attempt); store.checkpoint(saved.claim, { step: 'publish', resultAttemptId: analyzed.attemptId });
  const result = store.getLatestResult(101, 'radiant'); store.close();
  const reopened = fx.open(), recovered = reopened.enqueueInitial({ ...jobInput(), origin: 'automatic' }); assert.equal(recovered.id, manual.id);
  reopened.decideDiscoveryCandidate({ contextKey, matchId: 101, state: 'admitted', nextCheckAt: null, reason: null });
  assert.equal(reopened.getLatestJob(101, 'radiant')!.revision, 1); assert.equal(reopened.listAttempts(manual.id).length, 1);
  assert.deepEqual(reopened.getLatestResult(101, 'radiant'), result);
});
