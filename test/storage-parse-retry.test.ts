import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, jobInput, errorIs, settings } from './storage-helpers.js';

test('storage: parse retry requires 120 seconds, preserves its parent and cannot be repeated or chained', async t => {
  const fx = await fixture(t), store = fx.open(), job = store.enqueueInitial(jobInput()), claim = store.claimNext()!.claim;
  const first = store.beginParse(claim, { attemptId: 'first' }); store.saveParseOutcome(first.id, { jobId: '12345' });
  assert.throws(() => store.beginParse(claim, { attemptId: 'early', retryOf: first.id }), errorIs('conflict'));
  store.defer(claim, { nextRunAt: 0, reason: 'parse-pending' }); fx.advance(119999);
  const current = store.claimNext()!.claim;
  assert.throws(() => store.beginParse(current, { attemptId: 'early', retryOf: first.id }), errorIs('conflict'));
  fx.advance(1); const retry = store.beginParse(current, { attemptId: 'retry', retryOf: first.id });
  assert.deepEqual(retry.input, { version: 1, matchId: 101, retryOf: { attemptId: first.id, createdAt: first.createdAt } });
  assert.equal(retry.state, 'started'); assert.equal(retry.unresolved, true);
  store.saveParseOutcome(retry.id, { jobId: '12346' });
  assert.throws(() => store.beginParse(current, { attemptId: 'third', retryOf: first.id }), errorIs('conflict'));
  assert.throws(() => store.beginParse(current, { attemptId: 'third', retryOf: retry.id }), errorIs('conflict'));
  store.close(); const reopened = fx.open();
  assert.deepEqual(reopened.listAttempts(job.id)[1].input, retry.input);
  assert.throws(() => reopened.beginParse(current, { attemptId: 'third', retryOf: first.id }), errorIs('conflict'));
  assert.equal(reopened.listAttempts(job.id).length, 2);
});

test('storage: opposite sides and two connections share one retry; interrupted admission remains spent', async t => {
  const fx = await fixture(t), store = fx.open(), root = store.enqueueInitial(jobInput()), claim = store.claimNext()!.claim;
  const first = store.beginParse(claim, { attemptId: 'first' }); store.saveParseOutcome(first.id, { jobId: '12345' });
  store.finish(claim, { state: 'failed', reason: 'synthetic' }); fx.advance(120000);
  const other = store.enqueueInitial(jobInput(101, 'dire')), second = fx.open(), otherClaim = second.claimNext()!.claim;
  const retry = second.beginParse(otherClaim, { attemptId: 'retry', retryOf: first.id });
  assert.equal(retry.jobId, other.id); assert.equal(store.listAttempts(other.id)[0].id, retry.id);
  fx.advance(); second.recoverInterrupted(); assert.equal(second.getJob(other.id).state, 'needs-attention');
  store.createRevision({ requestId: 'revision', matchId: root.matchId, side: root.side, settings });
  const next = store.claimNext()!.claim;
  assert.throws(() => store.beginParse(next, { attemptId: 'duplicate', retryOf: first.id }), errorIs('conflict'));
  assert.equal(store.listAttempts(root.id).length + store.listAttempts(other.id).length, 2);
});

test('storage: unknown, released and other-match parents cannot authorize a parse retry', async t => {
  const fx = await fixture(t), store = fx.open(); store.enqueueInitial(jobInput()); const claim = store.claimNext()!.claim;
  const first = store.beginParse(claim, { attemptId: 'first' });
  store.saveParseOutcome(first.id, { error: { code: 'timeout', operation: 'requestParse', requestMayHaveSucceeded: true } });
  const attention = store.finish(claim, { state: 'needs-attention', reason: 'unknown' }); fx.advance(120000);
  store.enqueueInitial(jobInput(101, 'dire')); const otherClaim = store.claimNext()!.claim;
  assert.throws(() => store.beginParse(otherClaim, { attemptId: 'unknown-retry', retryOf: first.id }), errorIs('conflict'));
  store.resolveUncertain({ resolutionId: 'release', jobId: attention.id, expectedVersion: attention.version, attemptId: first.id,
    decision: 'allow-new-attempt', state: 'waiting', reason: 'synthetic', evidenceRef: 'test:parse-retry' });
  assert.throws(() => store.beginParse(otherClaim, { attemptId: 'released-retry', retryOf: first.id }), errorIs('conflict'));
  store.defer(otherClaim, { nextRunAt: Number.MAX_SAFE_INTEGER, reason: 'synthetic' });
  const parentClaim = store.claimNext()!.claim, known = store.beginParse(parentClaim, { attemptId: 'known' });
  store.saveParseOutcome(known.id, { jobId: '12345' }); store.finish(parentClaim, { state: 'failed', reason: 'synthetic' }); fx.advance(120000);
  store.enqueueInitial(jobInput(102)); const wrongMatch = store.claimNext()!.claim;
  assert.throws(() => store.beginParse(wrongMatch, { attemptId: 'wrong-match', retryOf: known.id }), errorIs('conflict'));
});
