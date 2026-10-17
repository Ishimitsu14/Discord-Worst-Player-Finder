import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { analyzeGeminiMatch } from '../src/match-analysis/index.js';
import { fixture, errorIs, jobInput, inputs } from './storage-helpers.js';
import { storeGemini, storedGeminiAttempt, recovery, brokenConnection, geminiPrompt, geminiPromptV2, settings } from './gemini-runtime-helpers.js';

test('Gemini migration3: upgrade2 preserves discovery, legacy jobs, revision digest and original migration checksums', async t => {
  const fx = await fixture(t), store = fx.open(), first = store.enqueueInitial(jobInput()), claim = store.claimNext()!.claim;
  store.finish(claim, { state: 'failed', reason: 'synthetic' });
  const revisionInput = { requestId: 'old-request', matchId: 101, side: 'radiant' as const, settings: jobInput().settings }, second = store.createRevision(revisionInput);
  const contextKey = 'a'.repeat(64); store.observeDiscoveryCandidate({ contextKey, matchId: 102, observedAt: 1000, expiresAt: 61000 }); store.close();
  let db = new DatabaseSync(fx.path); const checksums = db.prepare('SELECT * FROM migrations WHERE version<3 ORDER BY version').all();
  const previousDigest = db.prepare('SELECT digest FROM revision_requests').get()!.digest;
  db.exec('DROP TABLE gemini_recoveries; ALTER TABLE jobs DROP COLUMN analysis_profile; DELETE FROM migrations WHERE version=3; PRAGMA user_version=2'); db.close();
  const upgraded = fx.open(); assert.equal(upgraded.getJob(first.id).analysisProfile, 'legacy'); assert.equal(upgraded.getDiscoveryCandidate(contextKey, 102)!.state, 'pending');
  assert.equal(upgraded.createRevision({ ...revisionInput, analysisProfile: 'legacy' }).id, second.id);
  assert.throws(() => upgraded.createRevision({ ...revisionInput, analysisProfile: 'gemini' }), errorIs('conflict')); upgraded.close();
  db = new DatabaseSync(fx.path); assert.deepEqual(db.prepare('SELECT * FROM migrations WHERE version<3 ORDER BY version').all(), checksums);
  assert.equal(db.prepare('SELECT digest FROM revision_requests').get()!.digest, previousDigest); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3); db.close();
});

test('Gemini migration3: DDL failure rolls back new column/table/checksum and does not lose legacy data', async t => {
  const fx = await fixture(t), store = fx.open(), job = store.enqueueInitial(jobInput()); store.close();
  let db = new DatabaseSync(fx.path); db.exec('DROP TABLE gemini_recoveries; ALTER TABLE jobs DROP COLUMN analysis_profile; DELETE FROM migrations WHERE version=3; PRAGMA user_version=2'); db.close();
  const original = DatabaseSync.prototype.exec, fault = t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
    if (sql.includes('CREATE TABLE gemini_recoveries')) { original.call(this, sql.slice(0, sql.indexOf(';') + 1)); throw Error('synthetic migration failure'); }
    return original.call(this, sql);
  });
  assert.throws(() => fx.open(), errorIs('io-error')); fault.mock.restore();
  db = new DatabaseSync(fx.path); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 2);
  assert.equal(db.prepare('PRAGMA table_info(jobs)').all().some(row => row.name === 'analysis_profile'), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM migrations').get()!.n, 2); db.close(); assert.equal(fx.open().getJob(job.id).analysisProfile, 'legacy');
});

test('Gemini job profiles: initial dedup ignores new config; explicit revision freezes profile and old request digest', async t => {
  const fx = await fixture(t), store = fx.open(), first = store.enqueueInitial(jobInput());
  assert.equal(store.enqueueInitial({ ...jobInput(), analysisProfile: 'gemini' }).id, first.id); assert.equal(store.getJob(first.id).analysisProfile, 'legacy');
  const claim = store.claimNext()!.claim; store.finish(claim, { state: 'failed', reason: 'synthetic' });
  const next = store.createRevision({ requestId: 'gemini-revision', matchId: 101, side: 'radiant', settings, analysisProfile: 'gemini' });
  assert.equal(next.analysisProfile, 'gemini'); assert.equal(next.revision, 2);
  assert.equal(store.enqueueInitial(jobInput()).id, first.id);
  assert.throws(() => store.createRevision({ requestId: 'gemini-revision', matchId: 101, side: 'radiant', settings }), errorIs('conflict'));
});

for (const prompt of [geminiPrompt, geminiPromptV2]) test(`Gemini storage ${prompt.profile.responseFormat}: exact artifacts, final, idempotence and late valid`, async t => {
  const fx = await fixture(t), store = fx.open(), current = storeGemini(store, 'dire', prompt), original = store.getJobArtifacts(current.job.id, 'gemini');
  assert.equal('dataDigest' in current.bundle.manifest, false); assert.ok(current.bundle.manifest.sourceDataDigest);
  const result = await storedGeminiAttempt(store, current.claim); assert.equal(result.status, 'valid');
  store.saveAnalysisOutcome(result.attemptId!, result); assert.deepEqual(store.saveAnalysisOutcome(result.attemptId!, result).outcome, result);
  fx.advance(); store.recoverInterrupted(); assert.throws(() => store.checkpoint(current.claim, { step: 'publish', resultAttemptId: result.attemptId! }), errorIs('lease-lost'));
  const claim = store.claimNext()!.claim; store.checkpoint(claim, { step: 'publish', resultAttemptId: result.attemptId! });
  assert.equal(store.getLatestResult(101, 'dire', 'gemini')!.attempt.analysis!.format, prompt.profile.responseFormat);
  store.close(); const reopened = fx.open(); assert.deepEqual(reopened.getJobArtifacts(current.job.id, 'gemini'), original);
  assert.deepEqual(reopened.getLatestResult(101, 'dire', 'gemini')!.attempt, result); assert.equal(reopened.getBillingSummary().knownCostUsd, 0.001);
});

test('Gemini storage: reject legacy/compact mixing, side/source digest, prepared changes and mutable prompt', async t => {
  const fx = await fixture(t), store = fx.open(), current = storeGemini(store), legacy = inputs(101, 'dire');
  for (const value of [{ bundle: legacy.bundle, prepared: legacy.prepared }, { bundle: { ...current.bundle, manifest: { ...current.bundle.manifest, side: 'radiant' as const } } },
    { bundle: { ...current.bundle, manifest: { ...current.bundle.manifest, sourceDataDigest: '0'.repeat(64) } } }, { prepared: { ...current.prepared, body: current.prepared.body + ' ' } },
    { prepared: { ...current.prepared, prompt: { ...current.prepared.prompt, digest: '0'.repeat(64) } } }]) {
    assert.throws(() => store.saveInputs(current.claim, value));
  }
  assert.equal(store.getJobArtifacts(current.job.id, 'gemini').prepared!.body, current.prepared.body);
});

test('Gemini final: strict SSE fields, game evidence, own quote, version, content digest and original body', async t => {
  const fx = await fixture(t), store = fx.open(), current = storeGemini(store), valid = await storedGeminiAttempt(store, current.claim);
  for (const mutate of [
    (value: typeof valid) => { value.responseReceived = false; }, (value: typeof valid) => { value.streamBytes = -1; },
    (value: typeof valid) => { value.firstContentMs = value.elapsedMs + 1; }, (value: typeof valid) => { value.identity!.side = 'radiant'; },
    (value: typeof valid) => { value.analysis!.quoteId = current.bundle.context.chat.find(row => row.value.player_slot !== value.analysis!.selectedPlayerSlot)?.id ?? 'e999'; },
    (value: typeof valid) => { value.analysis!.facts[0].evidenceIds = ['e999999']; },
    (value: typeof valid) => { value.analysis!.format = 'gemini-match-analysis-v1'; }, (value: typeof valid) => { value.content += ' '; },
  ]) { const changed = structuredClone(valid); mutate(changed); assert.throws(() => store.saveAnalysisOutcome(valid.attemptId!, changed)); }
  store.saveAnalysisOutcome(valid.attemptId!, valid); assert.deepEqual(store.listAttempts(current.job.id)[0].outcome, valid);
});

test('Gemini preflight: missing identity is accepted only before started and carries no cost', async t => {
  const fx = await fixture(t), store = fx.open(), current = storeGemini(store), attemptId = randomUUID();
  store.reserveAnalysis(current.claim, { attemptId, preparedRef: store.getJob(current.job.id).refs.prepared! });
  const outcome = await analyzeGeminiMatch(current.prepared, current.bundle, { attemptId, maxEstimatedCostUsd: 1 }, { apiKey: '', beforeSend: async () => assert.fail(), fetcher: async () => assert.fail() });
  assert.equal(outcome.identity, null); store.saveAnalysisOutcome(attemptId, outcome); assert.equal(store.getBillingSummary().unknownCount, 0);
});

test('Gemini recovery: immutable audit, competing child admissions and permanent generic-reserve prohibition', async t => {
  const fx = await fixture(t), store = fx.open(), current = storeGemini(store), attempt = await storedGeminiAttempt(store, current.claim, brokenConnection);
  store.saveAnalysisOutcome(attempt.attemptId!, attempt); const audit = recovery(attempt), saved = store.saveGeminiRecovery(attempt.attemptId!, audit);
  assert.deepEqual(store.saveGeminiRecovery(attempt.attemptId!, audit), saved);
  assert.throws(() => store.saveGeminiRecovery(attempt.attemptId!, { ...audit, reserveUsd: audit.reserveUsd + 1 }));
  const other = fx.open(), child = store.reserveGeminiRetry(current.claim, { parentAttemptId: attempt.attemptId!, attemptId: 'child-one' });
  assert.throws(() => other.reserveGeminiRetry(current.claim, { parentAttemptId: attempt.attemptId!, attemptId: 'child-two' }), errorIs('conflict'));
  assert.throws(() => store.reserveAnalysis(current.claim, { attemptId: 'generic-bypass', preparedRef: store.getJob(current.job.id).refs.prepared! }), errorIs('conflict'));
  assert.equal(child.inputRef, store.listAttempts(current.job.id)[0].inputRef);
  const result = await storedGeminiAttempt(store, current.claim, undefined, child.id); store.saveAnalysisOutcome(child.id, result);
  assert.throws(() => store.reserveGeminiRetry(current.claim, { parentAttemptId: attempt.attemptId!, attemptId: 'third-attempt' }), errorIs('conflict'));
  const billing = store.getBillingSummary(); assert.equal(billing.unknownCount, 1); assert.equal(billing.uncoveredUnknownCount, 0); assert.equal(billing.knownCostUsd, 0.001); assert.equal(billing.reservedCostUsd, attempt.estimatedCostUsd);
  store.close(); other.close(); assert.deepEqual(fx.open().getBillingSummary(), billing);
});

test('Gemini known invalid child cannot bypass its permanent slot with generic reserve', async t => {
  const fx = await fixture(t), store = fx.open(), current = storeGemini(store), parent = await storedGeminiAttempt(store, current.claim, brokenConnection);
  store.saveAnalysisOutcome(parent.attemptId!, parent); store.saveGeminiRecovery(parent.attemptId!, recovery(parent));
  const child = store.reserveGeminiRetry(current.claim, { parentAttemptId: parent.attemptId!, attemptId: 'invalid-child' }), result = await storedGeminiAttempt(store, current.claim, undefined, child.id);
  result.status = 'invalid-output'; result.error = { code: 'invalid-output' }; result.analysis = null; store.saveAnalysisOutcome(child.id, result);
  assert.equal(store.listAttempts(current.job.id).some(row => row.unresolved), false);
  assert.throws(() => store.reserveAnalysis(current.claim, { attemptId: 'third-generic', preparedRef: child.inputRef }), errorIs('conflict'));
});

test('Gemini retry admission COMMIT failure rolls back parent release, child and link', async t => {
  const fx = await fixture(t), store = fx.open(), current = storeGemini(store), attempt = await storedGeminiAttempt(store, current.claim, brokenConnection);
  store.saveAnalysisOutcome(attempt.attemptId!, attempt); store.saveGeminiRecovery(attempt.attemptId!, recovery(attempt));
  const original = DatabaseSync.prototype.exec; let armed = true;
  const fault = t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) { if (armed && sql === 'COMMIT') { armed = false; throw Error('synthetic commit'); } return original.call(this, sql); });
  assert.throws(() => store.reserveGeminiRetry(current.claim, { parentAttemptId: attempt.attemptId!, attemptId: 'rolled-back' }), errorIs('io-error')); fault.mock.restore();
  assert.equal(store.getGeminiRecovery(attempt.attemptId!)!.retryAttemptId, null); assert.equal(store.listAttempts(current.job.id).length, 1); assert.equal(store.listAttempts(current.job.id)[0].released, false);
});

test('Gemini recovery rejects wrong identity, timing, checks, amount and ineligible/child parents', async t => {
  const fx = await fixture(t), store = fx.open(), current = storeGemini(store), attempt = await storedGeminiAttempt(store, current.claim, brokenConnection);
  store.saveAnalysisOutcome(attempt.attemptId!, attempt); const audit = recovery(attempt);
  for (const value of [{ ...audit, attemptId: 'other' }, { ...audit, requestDigest: 'a'.repeat(64) }, { ...audit, reserveUsd: 0 },
    { ...audit, checks: audit.checks.slice(0, 2) }, { ...audit, costUsd: 0.01 }, { ...audit, checks: audit.checks.map(row => ({ ...row, checkedAt: attempt.endedAt })) },
    { ...audit, checks: audit.checks.map((row, index) => index === 2 ? { ...row, status: 'recorded' as const, generationIds: ['gen-contradiction'] } : row) }]) assert.throws(() => store.saveGeminiRecovery(attempt.attemptId!, value));
  store.saveGeminiRecovery(attempt.attemptId!, audit); const child = store.reserveGeminiRetry(current.claim, { parentAttemptId: attempt.attemptId!, attemptId: 'only-child' });
  const failure = await storedGeminiAttempt(store, current.claim, brokenConnection, child.id); store.saveAnalysisOutcome(child.id, failure);
  assert.throws(() => store.saveGeminiRecovery(child.id, recovery(failure)), errorIs('conflict'));
  assert.equal(store.getBillingSummary().uncoveredUnknownCount, 1);
});

for (const cost of [null, 0, 0.003]) test(`Gemini recorded cost=${cost}: effective billing once, original final unchanged`, async t => {
  const fx = await fixture(t), store = fx.open(), current = storeGemini(store), attempt = await storedGeminiAttempt(store, current.claim, brokenConnection);
  store.saveAnalysisOutcome(attempt.attemptId!, attempt); const audit = recovery(attempt, 'recorded', cost);
  store.saveGeminiRecovery(attempt.attemptId!, audit); store.saveGeminiRecovery(attempt.attemptId!, audit);
  assert.deepEqual(store.listAttempts(current.job.id)[0].outcome, attempt); const billing = store.getBillingSummary();
  assert.equal(billing.knownCostUsd, cost ?? 0); assert.equal(billing.unknownCount, cost === null ? 1 : 0); assert.equal(billing.uncoveredUnknownCount, cost === null ? 1 : 0);
  assert.equal(billing.reservedCostUsd, cost === null ? attempt.estimatedCostUsd : 0); store.close(); assert.deepEqual(fx.open().getBillingSummary(), billing);
});

for (const phase of ['started', 'final', 'decision', 'child-reserved', 'child-started', 'child-final'] as const) test(`Gemini crash boundary: ${phase} local recovery performs no network`, async t => {
  const fx = await fixture(t), store = fx.open(), current = storeGemini(store), attempt = await storedGeminiAttempt(store, current.claim, brokenConnection);
  if (phase !== 'started') store.saveAnalysisOutcome(attempt.attemptId!, attempt);
  if (!['started', 'final'].includes(phase)) store.saveGeminiRecovery(attempt.attemptId!, recovery(attempt));
  if (phase.startsWith('child')) {
    const child = store.reserveGeminiRetry(current.claim, { parentAttemptId: attempt.attemptId!, attemptId: 'crash-child' });
    if (phase !== 'child-reserved') { const final = await storedGeminiAttempt(store, current.claim, undefined, child.id); if (phase === 'child-final') store.saveAnalysisOutcome(child.id, final); }
  }
  store.close(); fx.advance(); const restarted = fx.open(), result = restarted.recoverInterrupted();
  const resumable = ['final', 'decision', 'child-final'].includes(phase); assert.equal(result.resumed, resumable ? 1 : 0); assert.equal(result.attention, resumable ? 0 : 1);
  assert.equal(restarted.getJob(current.job.id).state, resumable ? 'waiting' : 'needs-attention'); assert.deepEqual(restarted.recoverInterrupted(), { resumed: 0, attention: 0 });
});
