import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture, data, live, drive, response, intercepted, prompt } from './match-pipeline-helpers.js';
import { started, invalidAttempt } from './storage-helpers.js';
import { analysis } from './match-analysis-helpers.js';
import { StorageError, type Storage } from '../src/storage/index.js';

for (const origin of ['manual', 'automatic'] as const) {
  test(`pipeline end-to-end ${origin}: basic -> parse -> parsed -> facts -> real analyzer with fake HTTP -> publication -> reopen`, async t => {
    const fx = await fixture(t); fx.matches.set(101, data(101, false)); let sends = 0;
    const pipeline = fx.pipe({ ...live, automaticSince: 1799999000000 }, { publisher: { prepare: fx.publisher.prepare, send: async (...args) => { sends++; return fx.publisher.send(...args); } } });
    const job = origin === 'manual' ? await fx.request(pipeline) : fx.storage.getJob((await drive(pipeline.discoverOnce(), fx.clock)).queued[0]);
    const pending = await fx.process(pipeline); assert.equal(pending.step, 'wait-parse'); assert.equal(pending.reason, 'parse-pending');
    fx.matches.set(101, data()); await fx.clock.tick(15000); const final = await fx.process(pipeline);
    assert.equal(final.state, 'succeeded'); assert.equal(final.origin, origin); assert.equal(sends, 1);
    const receipts = fx.storage.listAttempts(job.id); assert.deepEqual(receipts.map(item => item.kind).sort(), ['analysis', 'parse', 'publication']); assert.ok(receipts.every(item => item.state === 'finished' && !item.unresolved));
    assert.equal(fx.posts('parse').length, 1); assert.equal(fx.posts('analysis').length, 1); assert.equal(fx.storage.getBillingSummary().knownCostUsd, 0.001);
    const prepared = fx.storage.getJobArtifacts(job.id).prepared!; assert.equal(fx.posts('analysis')[0].body, prepared.body);
    const body = JSON.parse(prepared.body); assert.equal(body.model, prompt.profile.model); assert.equal(body.max_tokens, prompt.profile.maxTokens); assert.deepEqual(body.provider, prompt.profile.provider);
    await pipeline.stop(); fx.reopen(); const next = fx.pipe({ ...live, automaticSince: 1799999000000 }, { publisher: { prepare: () => assert.fail('no repeated preparation'), send: async () => assert.fail('no repeated publication') } });
    assert.equal((await next.processNext()).status, 'idle'); assert.equal((await next.requestMatch({ matchId: 101, side: 'radiant' })).status, 'existing'); assert.ok(next.getStatus({ jobId: job.id }).result);
    if (origin === 'automatic') assert.equal((await drive(next.discoverOnce(), fx.clock)).existing[0], job.id);
    assert.equal(fx.posts('parse').length + fx.posts('analysis').length + sends, 3);
  });
}

test('released late valid analysis remains history and cannot become current result automatically', async t => {
  const fx = await fixture(t), preparation = fx.pipe(); const job = await fx.request(preparation); await fx.process(preparation); await preparation.stop(); await fx.clock.tick(300000);
  const claim = fx.storage.claimNext()!.claim, start = started(fx.storage, claim), bundle = fx.storage.getJobArtifacts(job.id).bundle!;
  const attention = fx.storage.finish(claim, { state: 'needs-attention', reason: 'unknown' });
  fx.storage.resolveUncertain({ resolutionId: 'release', jobId: job.id, expectedVersion: attention.version, attemptId: start.attemptId, decision: 'allow-new-attempt', state: 'waiting', reason: 'explicit', evidenceRef: 'audit' });
  const content = JSON.stringify(analysis(bundle));
  fx.storage.saveAnalysisOutcome(start.attemptId, { ...invalidAttempt(start, 0.001), status: 'valid', finishReason: 'stop', analysis: analysis(bundle), error: null, content, responseDigest: createHash('sha256').update(content).digest('hex') });
  const pipeline = fx.pipe(live); const failed = await fx.process(pipeline); assert.equal(failed.reason, 'released-analysis-present'); assert.equal(failed.resultAttemptId, null); assert.equal(pipeline.getStatus({ jobId: job.id }).result, null); assert.equal(fx.posts('analysis').length, 0);
});

test('parse poll cooldown preserves original deadline and unknown shared parse expires without another POST', async t => {
  const fx = await fixture(t); fx.matches.set(101, data(101, false)); const pipeline = fx.pipe({ ...live, parseTimeoutMs: 180000 });
  const job = await fx.request(pipeline); await fx.process(pipeline); await fx.clock.tick(15000);
  fx.hooks.opendota = url => url.pathname.endsWith('/request/12345') ? Response.json({}, { status: 429, headers: { 'Retry-After': '120' } }) : undefined;
  const delayed = await fx.process(pipeline); assert.equal(delayed.reason, 'opendota-rate_limited'); assert.ok(delayed.nextRunAt >= fx.clock.now() + 60000);
  const created = fx.storage.listAttempts(job.id)[0].createdAt; await fx.clock.tick(created + 180001 - fx.clock.now());
  assert.equal((await fx.process(pipeline)).reason, 'parse-timeout'); assert.equal(fx.posts('parse').length, 1); assert.equal(fx.posts('analysis').length, 0);
  const second = await fixture(t); second.matches.set(101, data(101, false)); const unknown = second.pipe({ ...live, parseTimeoutMs: 30000 });
  const first = await second.request(unknown); second.hooks.opendota = (_url, init) => { if (init.method === 'POST') throw Error('unknown'); return undefined; };
  await second.process(unknown); await second.request(unknown, 101, 'dire'); await second.process(unknown); await second.clock.tick(30000);
  assert.equal((await second.process(unknown)).reason, 'parse-timeout'); assert.equal(second.storage.getJob(first.id).state, 'needs-attention'); assert.equal(second.posts('parse').length, 1);
});

test('recovered prepared input does not allow basic fallback, and failure to persist final stops automatic run', async t => {
  const fx = await fixture(t), preparation = fx.pipe(); await fx.request(preparation); await fx.process(preparation); await preparation.stop(); await fx.clock.tick(300000);
  fx.matches.set(101, data(101, false)); const pipeline = fx.pipe(live); assert.equal((await fx.process(pipeline)).reason, 'parse-pending'); assert.equal(fx.posts('analysis').length, 0);
  const second = await fixture(t), storage = intercepted(second.storage, { saveAnalysisOutcome: (() => { throw new StorageError('io-error', 'COMMIT'); }) as never });
  const faulty = second.pipe({ ...live, automaticSince: 0 }, { storage }); const running = faulty.run();
  await second.clock.tick(10000); await assert.rejects(running, (error: unknown) => (error as { code: string }).code === 'storage-failure');
  const calls = second.calls.length; await second.clock.tick(1000000); assert.equal(second.calls.length, calls); assert.equal(second.posts('analysis').length, 1); assert.equal(second.clock.timers.size, 0);
});

test('late known parse ID is reused even after explicit release and does not cause another admission', async t => {
  const fx = await fixture(t); fx.matches.set(101, data(101, false)); const pipeline = fx.pipe(live), job = await fx.request(pipeline);
  const claim = fx.storage.claimNext()!.claim, receipt = fx.storage.beginParse(claim, { attemptId: 'released-parse' });
  const attention = fx.storage.finish(claim, { state: 'needs-attention', reason: 'unknown' });
  fx.storage.resolveUncertain({ resolutionId: 'allow-parse', jobId: job.id, expectedVersion: attention.version, attemptId: receipt.id, decision: 'allow-new-attempt', state: 'waiting', reason: 'explicit', evidenceRef: 'audit' });
  fx.storage.saveParseOutcome(receipt.id, { jobId: '12345' });
  assert.equal((await fx.process(pipeline)).reason, 'parse-pending'); assert.equal(fx.posts('parse').length, 0); assert.equal(fx.storage.listAttempts(job.id).length, 1);
});
