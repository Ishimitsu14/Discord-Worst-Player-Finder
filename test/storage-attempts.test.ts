import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { analyzeMatch } from '../src/match-analysis/index.js';
import type { AnalysisAttempt, Inputs } from '../src/storage/index.js';
import { fixture, inputs, setup, started, analyze, invalidAttempt, jobInput, errorIs, settings } from './storage-helpers.js';
import { metadata, payload } from './match-analysis-helpers.js';
import { analyzeStored } from './storage-example.js';

test('storage: точные артефакты переживают reopen и настоящий аналитик отправляет исходное body', async t => {
  const f = await fixture(t), store = f.open(), current = setup(store), original = inputs();
  assert.deepEqual(store.getJobArtifacts(current.job.id, 'legacy'), { analysisProfile: 'legacy', ...original }); store.close();
  const reopened = f.open(), claim = reopened.renewClaim(current.claim); let posts = 0;
  const { attemptId, attempt } = await analyze(reopened, claim, { onPost: body => {
    posts++; assert.equal(body, original.prepared.body);
    const db = new DatabaseSync(f.path); const row = db.prepare("SELECT state,started_ref FROM external_attempts WHERE kind='analysis'").get()!;
    assert.equal(row.state, 'started'); assert.ok(row.started_ref); db.close();
  } });
  assert.equal(posts, 1); assert.equal(attempt.status, 'valid'); reopened.saveAnalysisOutcome(attemptId, attempt);
  const accepted = reopened.checkpoint(claim, { step: 'publish', resultAttemptId: attemptId }); reopened.finish(accepted.claim, { state: 'succeeded' });
  assert.equal(reopened.getLatestResult(101, 'radiant', 'legacy')!.attempt.identity!.calibration, 'experimental');
});

test('storage: ограничения, ссылки и повреждение артефакта не раскрывают данные', async t => {
  const f = await fixture(t), store = f.open(), job = store.enqueueInitial(jobInput()), claim = store.claimNext()!.claim;
  const original = inputs();
  for (const value of [
    { snapshot: null }, { snapshot: { ...original.snapshot, parseState: 'basic' } }, { snapshot: { ...original.snapshot, retrievedAt: NaN } },
    { snapshot: { ...original.snapshot, data: { ...original.snapshot.data, match_id: 102 } } },
    { snapshot: { ...original.snapshot, data: { ...original.snapshot.data, invalid: () => 'not JSON' } } },
    { ...original, bundle: { ...original.bundle, manifest: { ...original.bundle.manifest, side: 'dire' } } },
    { ...original, prepared: { ...original.prepared, body: original.prepared.body + ' ' } },
  ]) assert.throws(() => store.saveInputs(claim, value as Inputs));
  const oversized = inputs(); oversized.snapshot.data.private = 'private-sentinel'.repeat(2400000);
  assert.throws(() => store.saveInputs(claim, { snapshot: oversized.snapshot }), errorIs('too-large'));
  assert.equal(store.getJob(job.id).refs.snapshot, null);
  const saved = store.saveInputs(claim, original);
  assert.throws(() => store.saveInputs(saved.claim, { snapshot: { ...original.snapshot, retrievedAt: 1001 } }), errorIs('conflict'));
  const db = new DatabaseSync(f.path); db.prepare("UPDATE artifacts SET body='private-sentinel' WHERE kind='bundle'").run(); db.close();
  assert.throws(() => store.getJobArtifacts(job.id, 'legacy'), error => { assert.ok(errorIs('integrity-error')(error)); assert.ok(!JSON.stringify(error).includes('private-sentinel')); return true; });
});

test('storage: rollback не оставляет частичные артефакты и ссылки', async t => {
  const f = await fixture(t), store = f.open(), job = store.enqueueInitial(jobInput()), claim = store.claimNext()!.claim;
  const db = new DatabaseSync(f.path); db.exec("CREATE TRIGGER fault BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  assert.throws(() => store.saveInputs(claim, inputs()), errorIs('conflict'));
  assert.equal(db.prepare('SELECT count(*) AS count FROM artifacts').get()!.count, 0); assert.equal(store.getJob(job.id).refs.snapshot, null);
  db.exec('DROP TRIGGER fault'); db.close();
  const saved = store.saveInputs(claim, inputs());
  assert.throws(() => store.checkpoint(saved.claim, { step: 'publish', resultAttemptId: 'missing-result' }), errorIs('not-found'));
  assert.equal(store.getJob(job.id).step, 'load-match'); assert.equal(store.getJob(job.id).resultAttemptId, null);
});

test('storage: parse одноразовый; известный job ID повторно не отправляется', async t => {
  const f = await fixture(t), store = f.open(), job = store.enqueueInitial(jobInput()), claim = store.claimNext()!.claim;
  store.beginParse(claim, { attemptId: 'parse-1' });
  assert.throws(() => store.beginParse(claim, { attemptId: 'parse-1' }), errorIs('attempt-already-started'));
  assert.throws(() => store.beginParse(claim, { attemptId: 'parse-2' }), errorIs('conflict'));
  const outcome = { jobId: '588786891' }, receipt = store.saveParseOutcome('parse-1', outcome);
  assert.deepEqual(store.saveParseOutcome('parse-1', outcome), receipt);
  assert.throws(() => store.saveParseOutcome('parse-1', { jobId: '588786892' }), errorIs('conflict'));
  store.close(); const reopened = f.open();
  assert.deepEqual(reopened.listAttempts(job.id)[0].outcome, outcome);
  assert.throws(() => reopened.beginParse(claim, { attemptId: 'parse-2' }), errorIs('conflict'));
});

test('storage: unknown parse требует аудита, ключ решения идемпотентен', async t => {
  const f = await fixture(t), store = f.open(), job = store.enqueueInitial(jobInput()), claim = store.claimNext()!.claim;
  store.beginParse(claim, { attemptId: 'parse-1' });
  store.saveParseOutcome('parse-1', { error: { code: 'timeout', operation: 'requestParse', requestMayHaveSucceeded: true } });
  assert.throws(() => store.defer(claim, { nextRunAt: 0, reason: 'retry' }), errorIs('conflict'));
  assert.throws(() => store.finish(claim, { state: 'failed', reason: 'retry' }), errorIs('conflict'));
  const attention = store.finish(claim, { state: 'needs-attention', reason: 'unknown' });
  const resolution = { resolutionId: 'decision-1', jobId: job.id, expectedVersion: attention.version, attemptId: 'parse-1', decision: 'allow-new-attempt' as const, state: 'waiting' as const, reason: 'explicit synthetic decision', evidenceRef: 'test:review' };
  assert.throws(() => store.resolveUncertain({ ...resolution, expectedVersion: 1 }), errorIs('conflict'));
  const resumed = store.resolveUncertain(resolution); assert.deepEqual(store.resolveUncertain(resolution), resumed);
  assert.throws(() => store.resolveUncertain({ ...resolution, reason: 'changed' }), errorIs('conflict'));
  const next = store.claimNext()!; store.beginParse(next.claim, { attemptId: 'parse-2' });
  const old = store.listAttempts(job.id).find(item => item.id === 'parse-1')!; assert.equal(old.released, true); assert.equal(old.resolutions.length, 1);
});

test('storage: сбой COMMIT перед отправкой даёт ноль платных POST', async t => {
  const f = await fixture(t), store = f.open(), current = setup(store); let posts = 0, armed = false;
  const original = DatabaseSync.prototype.exec;
  const fault = t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
    if (armed && sql === 'COMMIT') { armed = false; throw Error('synthetic commit failure'); } return original.call(this, sql);
  });
  const result = await analyze(store, current.claim, { onPost: () => posts++, beforeSend: async value => { armed = true; store.startAnalysis(current.claim, value.attemptId, value); } });
  fault.mock.restore(); assert.equal(posts, 0); assert.equal(result.attempt.requestSent, false);
  assert.equal(store.listAttempts(current.job.id)[0].state, 'prepared'); store.saveAnalysisOutcome(result.attemptId, result.attempt);
  assert.deepEqual(store.getBillingSummary(), { knownCostUsd: 0, unknownCount: 0, unfinishedEstimatedCostUsd: 0, reservedCostUsd: 0, uncoveredUnknownCount: 0 });
});

test('storage: отказ повторному beforeSend не отменяет ранее допущенный запрос', async t => {
  const f = await fixture(t), store = f.open(), current = setup(store), start = started(store, current.claim), artifacts = store.getJobArtifacts(current.job.id, 'legacy'); let posts = 0;
  assert.throws(() => store.startAnalysis(current.claim, start.attemptId, start), errorIs('attempt-already-started'));
  assert.throws(() => store.reserveAnalysis(current.claim, { attemptId: randomUUID(), preparedRef: current.refs.prepared! }), errorIs('conflict'));
  const rejected = await analyzeMatch(artifacts.prepared!, artifacts.bundle!, { attemptId: start.attemptId, maxEstimatedCostUsd: 1 }, {
    apiKey: 'synthetic-storage-key', beforeSend: async value => store.startAnalysis(current.claim, start.attemptId, value),
    fetcher: async (_url, init) => { if (init?.method === 'POST') posts++; return Response.json(metadata()); },
  });
  assert.equal(rejected.requestSent, false); assert.equal(posts, 0);
  assert.throws(() => store.saveAnalysisOutcome(start.attemptId, rejected), errorIs('conflict')); assert.equal(store.getBillingSummary().unknownCount, 1);
  store.saveAnalysisOutcome(start.attemptId, invalidAttempt(start)); assert.equal(store.getBillingSummary().knownCostUsd, 0.01);
});

test('storage: final валидируется, повторяется идемпотентно и не публикует результат сам', async t => {
  const f = await fixture(t), store = f.open(), current = setup(store), result = await analyze(store, current.claim);
  for (const changed of [
    { ...result.attempt, responseDigest: '0'.repeat(64) }, { ...result.attempt, identity: { ...result.attempt.identity!, calibration: 'candidate' as const } },
    { ...result.attempt, usage: { ...result.attempt.usage, costUsd: -1 } }, { ...result.attempt, analysis: { ...result.attempt.analysis!, selectedPlayers: [] } },
    { ...result.attempt, authorization: 'private-sentinel' },
  ]) assert.throws(() => store.saveAnalysisOutcome(result.attemptId, changed));
  const saved = store.saveAnalysisOutcome(result.attemptId, result.attempt);
  assert.deepEqual(store.saveAnalysisOutcome(result.attemptId, structuredClone(result.attempt)), saved);
  assert.equal(store.getLatestResult(101, 'radiant', 'legacy'), null);
  assert.throws(() => store.saveAnalysisOutcome(result.attemptId, { ...result.attempt, generationId: 'different' }), errorIs('conflict'));
  assert.throws(() => store.reserveAnalysis(current.claim, { attemptId: randomUUID(), preparedRef: current.refs.prepared! }), errorIs('conflict'));
  store.checkpoint(current.claim, { step: 'publish', resultAttemptId: result.attemptId }); assert.equal(store.getLatestResult(101, 'radiant', 'legacy')!.attempt.status, 'valid');
});

test('storage: preflight с null сохраняется без выдуманной идентичности и оплаты', async t => {
  const f = await fixture(t), store = f.open(), current = setup(store), attemptId = randomUUID(), values = store.getJobArtifacts(current.job.id, 'legacy');
  store.reserveAnalysis(current.claim, { attemptId, preparedRef: current.refs.prepared! });
  const attempt = await analyzeMatch(values.prepared!, values.bundle!, { attemptId, maxEstimatedCostUsd: 1 }, { apiKey: '', beforeSend: async () => { throw Error('unexpected callback'); } });
  assert.equal(attempt.identity, null); assert.equal(attempt.attemptId, null);
  assert.equal((store.saveAnalysisOutcome(attemptId, attempt).outcome as AnalysisAttempt).version, 1);
  assert.equal(store.getBillingSummary().unknownCount, 0); assert.equal(store.getLatestResult(101, 'radiant', 'legacy'), null);
});

test('storage: recover трогает просроченные задачи, prepared без POST не становится расходом', async t => {
  const f = await fixture(t), store = f.open(), current = setup(store), other = f.open();
  store.reserveAnalysis(current.claim, { attemptId: 'not-started', preparedRef: current.refs.prepared! });
  assert.throws(() => store.defer(current.claim, { nextRunAt: 2000, reason: 'reservation still active' }), errorIs('conflict'));
  assert.throws(() => store.finish(current.claim, { state: 'failed', reason: 'reservation still active' }), errorIs('conflict'));
  assert.deepEqual(other.recoverInterrupted(), { resumed: 0, attention: 0 }); f.advance();
  assert.deepEqual(other.recoverInterrupted(), { resumed: 1, attention: 0 }); assert.deepEqual(store.recoverInterrupted(), { resumed: 0, attention: 0 });
  assert.equal(store.listAttempts(current.job.id)[0].state, 'finished'); assert.equal(store.getBillingSummary().unknownCount, 0);
  assert.throws(() => store.startAnalysis(current.claim, 'not-started', {} as never), errorIs('invalid-input'));
  const next = store.claimNext()!; started(store, next.claim); f.advance();
  assert.deepEqual(store.recoverInterrupted(), { resumed: 0, attention: 1 }); assert.equal(store.claimNext(), null);
  assert.throws(() => store.checkpoint(next.claim, { step: 'publish' }), errorIs('lease-lost'));
});

test('storage: поздний ответ сохраняется после lease, новый владелец принимает его явно', async t => {
  const f = await fixture(t), store = f.open(), current = setup(store), result = await analyze(store, current.claim); f.advance(); store.recoverInterrupted();
  const attention = store.getJob(current.job.id); store.saveAnalysisOutcome(result.attemptId, result.attempt);
  assert.equal(store.getJob(current.job.id).version, attention.version); assert.equal(store.getLatestResult(101, 'radiant', 'legacy'), null);
  assert.throws(() => store.checkpoint(current.claim, { step: 'publish', resultAttemptId: result.attemptId }), errorIs('lease-lost'));
  store.resolveUncertain({ resolutionId: 'accept', jobId: current.job.id, expectedVersion: attention.version, attemptId: result.attemptId,
    decision: 'accept-outcome', state: 'waiting', reason: 'late saved response', evidenceRef: 'test:response' });
  store.checkpoint(store.claimNext()!.claim, { step: 'publish', resultAttemptId: result.attemptId }); assert.ok(store.getLatestResult(101, 'radiant', 'legacy'));
});

test('storage: явное принятие not-sent сохраняет аудит и не меняет StartedAttempt', async t => {
  const f = await fixture(t), store = f.open(), current = setup(store), start = started(store, current.claim), bad = invalidAttempt(start);
  const notSent: AnalysisAttempt = { ...bad, requestSent: false, status: 'aborted', billingState: 'not-sent', usage: { ...bad.usage, costUsd: null }, error: { code: 'aborted' } };
  assert.throws(() => store.saveAnalysisOutcome(start.attemptId, notSent), errorIs('conflict'));
  const attention = store.finish(current.claim, { state: 'needs-attention', reason: 'cancelled before POST' });
  store.resolveUncertain({ resolutionId: 'no-send', jobId: current.job.id, expectedVersion: attention.version, attemptId: start.attemptId,
    decision: 'accept-outcome', state: 'waiting', reason: 'verified invocation cancellation', evidenceRef: 'test:invocation', notSentOutcome: notSent });
  assert.deepEqual(store.listAttempts(current.job.id)[0].started, start); assert.equal(store.getBillingSummary().unknownCount, 0);
  assert.throws(() => store.saveAnalysisOutcome(start.attemptId, bad), errorIs('conflict'));
});

test('storage: журнал считает invalid-output, unknown и unfinished отдельно от оценки', async t => {
  const f = await fixture(t), store = f.open(), current = setup(store);
  const one = started(store, current.claim); store.saveAnalysisOutcome(one.attemptId, invalidAttempt(one, 0));
  const two = started(store, current.claim); store.saveAnalysisOutcome(two.attemptId, invalidAttempt(two, 0.01));
  const three = started(store, current.claim); store.saveAnalysisOutcome(three.attemptId, invalidAttempt(three, null));
  const four = started(store, current.claim);
  assert.deepEqual(store.getBillingSummary(), { knownCostUsd: 0.01, unknownCount: 2, unfinishedEstimatedCostUsd: four.estimatedCostUsd, reservedCostUsd: 0, uncoveredUnknownCount: 2 });
  assert.deepEqual(store.getBillingSummary({ jobId: current.job.id }), store.getBillingSummary());
  f.advance(); store.recoverInterrupted(); const attention = store.getJob(current.job.id);
  store.resolveUncertain({ resolutionId: 'explicit-repeat', jobId: current.job.id, expectedVersion: attention.version, attemptId: four.attemptId,
    decision: 'allow-new-attempt', state: 'waiting', reason: 'explicit test choice', evidenceRef: 'test:review' });
  assert.equal(store.getBillingSummary().unknownCount, 2);
  const claim = store.claimNext()!.claim, five = started(store, claim);
  store.saveAnalysisOutcome(four.attemptId, invalidAttempt(four, 0.02));
  assert.equal(store.getBillingSummary().knownCostUsd, 0.03); assert.equal(store.getBillingSummary().unknownCount, 2);
  assert.equal(store.listAttempts(current.job.id).find(item => item.id === five.attemptId)!.unresolved, true);
});

test('storage: публикация сохраняет точную цель, payload и uint64 message ID', async t => {
  const f = await fixture(t), store = f.open(), current = setup(store), result = await analyze(store, current.claim);
  store.saveAnalysisOutcome(result.attemptId, result.attempt); const accepted = store.checkpoint(current.claim, { step: 'publish', resultAttemptId: result.attemptId });
  const publication = { attemptId: 'publication-1', analysisAttemptId: result.attemptId, message: JSON.stringify({ embeds: [{ description: 'synthetic' }], allowed_mentions: { parse: [] } }) };
  const receipt = store.beginPublication(accepted.claim, publication);
  assert.deepEqual(receipt.input, { version: 1, guildId: settings.guildId, channelId: settings.channelId, analysisAttemptId: result.attemptId, message: publication.message });
  assert.throws(() => store.beginPublication(accepted.claim, { ...publication, attemptId: 'publication-2' }), errorIs('conflict'));
  const saved = store.savePublicationOutcome(publication.attemptId, { messageId: '18446744073709551615' });
  assert.deepEqual(store.savePublicationOutcome(publication.attemptId, { messageId: '18446744073709551615' }), saved);
  assert.throws(() => store.savePublicationOutcome(publication.attemptId, { messageId: '1' }), errorIs('conflict'));
  assert.throws(() => store.beginPublication(accepted.claim, { ...publication, attemptId: 'publication-2' }), errorIs('conflict'));
  store.close(); const reopened = f.open(); assert.deepEqual(reopened.getLatestResult(101, 'radiant', 'legacy')!.publications[0].outcome, { messageId: '18446744073709551615' });
});

test('storage: unknown публикация после reopen не даёт автоматического дубля', async t => {
  const f = await fixture(t), store = f.open(), current = setup(store), result = await analyze(store, current.claim);
  store.saveAnalysisOutcome(result.attemptId, result.attempt); const accepted = store.checkpoint(current.claim, { step: 'publish', resultAttemptId: result.attemptId });
  store.beginPublication(accepted.claim, { attemptId: 'publication-1', analysisAttemptId: result.attemptId, message: '{}' });
  store.savePublicationOutcome('publication-1', { state: 'unknown', code: 'timeout' }); f.advance(); store.close(); const reopened = f.open();
  assert.deepEqual(reopened.recoverInterrupted(), { resumed: 0, attention: 1 }); assert.equal(reopened.claimNext(), null);
  assert.equal(reopened.listAttempts(current.job.id).find(item => item.id === 'publication-1')!.unresolved, true);
});

test('storage: insufficient-evidence допустим, неудачная ревизия не стирает результат', async t => {
  const f = await fixture(t), store = f.open(), current = setup(store), response = payload(inputs().bundle);
  const value = JSON.parse(response.choices[0].message.content);
  Object.assign(value, { status: 'insufficient-evidence', selectedPlayers: [], comparison: null, closestAlternative: null });
  response.choices[0].message.content = JSON.stringify(value);
  const first = await analyze(store, current.claim, { response }); store.saveAnalysisOutcome(first.attemptId, first.attempt);
  const accepted = store.checkpoint(current.claim, { step: 'publish', resultAttemptId: first.attemptId }); store.finish(accepted.claim, { state: 'succeeded' });
  store.createRevision({ requestId: 'revision-2', matchId: 101, side: 'radiant', settings });
  const claim = store.claimNext()!.claim, saved = store.saveInputs(claim, inputs());
  const second = started(store, saved.claim); store.saveAnalysisOutcome(second.attemptId, invalidAttempt(second)); store.finish(saved.claim, { state: 'failed', reason: 'invalid output' });
  assert.equal(store.getLatestJob(101, 'radiant')!.revision, 2);
  const last = store.getLatestResult(101, 'radiant', 'legacy')!; assert.equal(last.job.revision, 1); assert.equal(last.attempt.analysis!.status, 'insufficient-evidence');
});

test('storage: пример API компилируется и выполняется без настоящей сети', async t => {
  const f = await fixture(t), store = f.open(), current = setup(store); let posts = 0;
  const result = await analyzeStored(store, current.claim, 1, { apiKey: 'synthetic-storage-key', fetcher: async (_url, init) => {
    if (init?.method !== 'POST') return Response.json(metadata()); posts++; return Response.json(payload(inputs().bundle));
  } });
  assert.equal(result.attempt.status, 'valid'); assert.equal(posts, 1); assert.ok(store.getLatestResult(101, 'radiant', 'legacy'));
});

test('storage: sent-исход без допуска и попытка другого job не принимаются', async t => {
  const f = await fixture(t), store = f.open(), current = setup(store), start = started(store, current.claim), value = invalidAttempt(start);
  store.saveAnalysisOutcome(start.attemptId, value);
  const nextId = randomUUID(); store.reserveAnalysis(current.claim, { attemptId: nextId, preparedRef: current.refs.prepared! });
  assert.throws(() => store.saveAnalysisOutcome(nextId, { ...value, attemptId: nextId }), errorIs('integrity-error'));
  const other = store.enqueueInitial(jobInput(102)), otherClaim = store.claimNext()!.claim;
  assert.equal(otherClaim.jobId, other.id);
  assert.throws(() => store.startAnalysis(otherClaim, nextId, { ...start, attemptId: nextId }), errorIs('conflict'));
});

test('storage: решение не обходит другой unresolved и откатывается целиком', async t => {
  const f = await fixture(t), store = f.open(), current = setup(store), start = started(store, current.claim);
  const other = store.enqueueInitial(jobInput(101, 'dire')), otherClaim = store.claimNext()!.claim;
  assert.equal(otherClaim.jobId, other.id); store.beginParse(otherClaim, { attemptId: 'parallel-parse' });
  const db = new DatabaseSync(f.path); db.prepare('UPDATE external_attempts SET job_id=? WHERE id=?').run(current.job.id, 'parallel-parse'); db.close();
  const attention = store.finish(current.claim, { state: 'needs-attention', reason: 'two stored unknown actions' });
  assert.throws(() => store.resolveUncertain({ resolutionId: 'cannot-bypass', jobId: current.job.id, expectedVersion: attention.version, attemptId: start.attemptId,
    decision: 'allow-new-attempt', state: 'waiting', reason: 'must not bypass parse', evidenceRef: 'test:guard' }), errorIs('conflict'));
  const unchanged = store.listAttempts(current.job.id).find(item => item.id === start.attemptId)!;
  assert.equal(unchanged.released, false); assert.equal(unchanged.unresolved, true); assert.equal(unchanged.resolutions.length, 0);
});

test('storage: поздняя публикация после явного разрешения повтора сохраняет обе записи', async t => {
  const f = await fixture(t), store = f.open(), current = setup(store), result = await analyze(store, current.claim);
  store.saveAnalysisOutcome(result.attemptId, result.attempt); const accepted = store.checkpoint(current.claim, { step: 'publish', resultAttemptId: result.attemptId });
  store.beginPublication(accepted.claim, { attemptId: 'publication-old', analysisAttemptId: result.attemptId, message: '{}' });
  const attention = store.finish(accepted.claim, { state: 'needs-attention', reason: 'no confirmation' });
  store.resolveUncertain({ resolutionId: 'repeat-publication', jobId: current.job.id, expectedVersion: attention.version, attemptId: 'publication-old',
    decision: 'allow-new-attempt', state: 'waiting', reason: 'explicit repeat with risk of duplicate', evidenceRef: 'test:decision' });
  const next = store.claimNext()!; store.beginPublication(next.claim, { attemptId: 'publication-new', analysisAttemptId: result.attemptId, message: '{}' });
  store.savePublicationOutcome('publication-old', { messageId: '1' }); store.savePublicationOutcome('publication-new', { messageId: '2' });
  assert.equal(store.getJob(current.job.id).version, next.job.version);
  const publications = store.getLatestResult(101, 'radiant', 'legacy')!.publications;
  assert.equal(publications.length, 2); assert.ok(publications.some(item => item.released && 'messageId' in item.outcome! && item.outcome.messageId === '1'));
});
