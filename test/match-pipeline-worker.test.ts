import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { verifyFactsBundle } from '../src/match-facts/index.js';
import { createPromptPackage, type AnalysisAttempt, type PreparedAnalysis } from '../src/match-analysis/index.js';
import { type Storage, StorageError } from '../src/storage/index.js';
import { fixture, data, drive, live, response, prompt, settings, intercepted, dictionary } from './match-pipeline-helpers.js';
import { deferred } from './opendota-helpers.js';
import { metadata } from './match-analysis-helpers.js';
import { started, invalidAttempt } from './storage-helpers.js';

test('prepare-only basic stores snapshot without admission; parsed stores facts/quality/request without result', async t => {
  const fx = await fixture(t); fx.matches.set(101, data(101, false)); const pipeline = fx.pipe();
  const job = await fx.request(pipeline); const waiting = await fx.process(pipeline);
  assert.equal(waiting.reason, 'parse-disabled'); assert.equal(waiting.step, 'wait-parse');
  assert.equal(fx.storage.listAttempts(job.id).length, 0); assert.equal(fx.storage.getJobArtifacts(job.id, 'legacy').snapshot!.parseState, 'basic');
  fx.matches.set(101, data()); await fx.clock.tick(300000);
  const preparedJob = await fx.process(pipeline), artifacts = fx.storage.getJobArtifacts(job.id, 'legacy');
  assert.equal(preparedJob.reason, 'live-disabled'); assert.equal(preparedJob.resultAttemptId, null);
  assert.equal(artifacts.bundle!.context.allies.length, 5); assert.ok(artifacts.bundle!.facts.quality); assert.ok(artifacts.bundle!.context.coverage);
  assert.deepEqual(verifyFactsBundle(artifacts.bundle, { matchId: 101, side: 'radiant', data: artifacts.snapshot!.data }, { dictionary }), artifacts.bundle);
  assert.equal(artifacts.prepared!.body, (fx.storage.getJobArtifacts(job.id, 'legacy').prepared as PreparedAnalysis).body);
  assert.equal(fx.posts('analysis').length + fx.posts('parse').length, 0);
});

test('basic parse is admitted once before two minutes; job ID persists and missing job does not mean parsed', async t => {
  const fx = await fixture(t); fx.matches.set(101, data(101, false)); const pipeline = fx.pipe(live);
  const job = await fx.request(pipeline);
  fx.hooks.opendota = (_url, init) => { if (init.method === 'POST') { const receipts = fx.storage.listAttempts(job.id); assert.equal(receipts.length, 1); assert.equal(receipts[0].state, 'started'); } return undefined; };
  let state = await fx.process(pipeline); assert.equal(state.reason, 'parse-pending'); assert.equal(fx.posts('parse').length, 1);
  const receipt = fx.storage.listAttempts(job.id)[0]; assert.deepEqual(receipt.outcome, { jobId: '12345' });
  await pipeline.stop(); fx.reopen(); const resumed = fx.pipe(live);
  await fx.clock.tick(15000); state = await fx.process(resumed); assert.equal(state.reason, 'parse-pending'); assert.equal(fx.posts('parse').length, 1);
  fx.matches.set(101, data()); await fx.clock.tick(15000); state = await fx.process(resumed);
  assert.equal(state.reason, 'publisher-unavailable'); assert.equal(state.step, 'publish'); assert.equal(fx.posts('analysis').length, 1);
});

test('parse deadline survives reopen and never sends basic data to MiMo', async t => {
  const fx = await fixture(t); fx.matches.set(101, data(101, false)); let pipeline = fx.pipe({ ...live, parseTimeoutMs: 30000 });
  const job = await fx.request(pipeline); await fx.process(pipeline); const created = fx.storage.listAttempts(job.id)[0].createdAt;
  await pipeline.stop(); fx.reopen(); pipeline = fx.pipe({ ...live, parseTimeoutMs: 30000 });
  await fx.clock.tick(created + 30000 - fx.clock.now()); const failed = await fx.process(pipeline);
  assert.equal(failed.state, 'failed'); assert.equal(failed.reason, 'parse-timeout'); assert.equal(fx.posts('parse').length, 1); assert.equal(fx.posts('analysis').length, 0);
});

test('opposite sides share a known parse and its original deadline', async t => {
  const fx = await fixture(t); fx.matches.set(101, data(101, false)); const pipeline = fx.pipe({ ...live, parseTimeoutMs: 30000 });
  const radiant = await fx.request(pipeline); await fx.process(pipeline); await fx.clock.tick(1);
  const dire = await fx.request(pipeline, 101, 'dire'); const waiting = await fx.process(pipeline);
  assert.equal(waiting.id, dire.id); assert.equal(waiting.reason, 'parse-pending'); assert.equal(fx.storage.listAttempts(dire.id).length, 0); assert.equal(fx.posts('parse').length, 1);
  const parse = fx.storage.listAttempts(radiant.id)[0]; await fx.clock.tick(parse.createdAt + 30000 - fx.clock.now());
  const failed = [await fx.process(pipeline), await fx.process(pipeline)]; assert.ok(failed.every(job => job.reason === 'parse-timeout'));
  assert.deepEqual(fx.storage.listAttempts(radiant.id)[0].outcome, { jobId: '12345' }); assert.equal(fx.posts('analysis').length, 0);
});

test('unknown parse is not retried; other side only checks fresh and can use later parsed without touching receipt', async t => {
  const fx = await fixture(t); fx.matches.set(101, data(101, false)); const pipeline = fx.pipe(live);
  const first = await fx.request(pipeline); fx.hooks.opendota = (_url, init) => { if (init.method === 'POST') throw new Error('private API response'); return undefined; };
  assert.equal((await fx.process(pipeline)).state, 'needs-attention');
  const second = await fx.request(pipeline, 101, 'dire'); let waiting = await fx.process(pipeline); assert.equal(waiting.reason, 'shared-parse-unknown'); assert.equal(fx.posts('parse').length, 1);
  await fx.clock.tick(120000); assert.equal((await fx.process(pipeline)).reason, 'shared-parse-unknown'); assert.equal(fx.posts('parse').length, 1);
  fx.matches.set(101, data()); await fx.clock.tick(15000); waiting = await fx.process(pipeline);
  assert.equal(waiting.id, second.id); assert.equal(waiting.reason, 'publisher-unavailable'); assert.equal(fx.storage.listAttempts(first.id)[0].unresolved, true);
  assert.equal(fx.posts('parse').length, 1); assert.equal(fx.posts('analysis').length, 1);
});

test('GET cooldown defers without a new parse admission and permanent failures safely terminate', async t => {
  const fx = await fixture(t), pipeline = fx.pipe(live); const job = await fx.request(pipeline);
  let attempts = 0;
  fx.hooks.opendota = url => url.pathname.includes('/matches/') ? (attempts++, Response.json({ token: 'secret' }, { status: 429, headers: { 'Retry-After': '120' } })) : undefined;
  const waiting = await fx.process(pipeline); assert.equal(waiting.state, 'waiting'); assert.equal(waiting.reason, 'opendota-rate_limited'); assert.ok(waiting.nextRunAt >= fx.clock.now() + 60000); assert.equal(fx.storage.listAttempts(job.id).length, 0);
  await fx.clock.tick(waiting.nextRunAt - fx.clock.now()); fx.hooks.opendota = url => url.pathname.includes('/matches/') ? Response.json({}, { status: 403 }) : undefined;
  const failed = await fx.process(pipeline); assert.equal(failed.reason, 'opendota-forbidden'); assert.equal(failed.state, 'failed'); assert.ok(attempts >= 1);
});

test('prepared body and package survive reopen/current instruction changes and optional data enrichment', async t => {
  const fx = await fixture(t), preparation = fx.pipe(); const job = await fx.request(preparation); await fx.process(preparation);
  const saved = fx.storage.getJobArtifacts(job.id, 'legacy'), body = saved.prepared!.body, snapshot = saved.snapshot;
  await preparation.stop(); fx.reopen();
  const files = { ...prompt.files, 'instruction.md': prompt.files['instruction.md'] + '\nДругая инструкция.' }; const changedPrompt = createPromptPackage(files, prompt.calibrationEvidence);
  const pipeline = fx.pipe(live, { prompt: changedPrompt }); fx.matches.get(101)!.players[0].hero_damage = 90000;
  await fx.clock.tick(300000); const result = await fx.process(pipeline);
  assert.equal(result.reason, 'publisher-unavailable'); assert.equal(fx.posts('analysis')[0].body, body); assert.deepEqual(fx.storage.getJobArtifacts(job.id, 'legacy').snapshot, snapshot);
  assert.equal(fx.storage.getLatestResult(101, 'radiant', 'legacy')!.attempt.status, 'valid');
});

test('essential prepared input changes fail before any paid request; automatic eligibility is checked again', async t => {
  for (const change of ['duration', 'outcome', 'hero', 'mode'] as const) {
    const fx = await fixture(t), preparation = fx.pipe(); const job = await fx.request(preparation); await fx.process(preparation); await preparation.stop();
    const raw = fx.matches.get(101)!; if (change === 'duration') raw.duration++; if (change === 'outcome') raw.radiant_win = false; if (change === 'hero') raw.players[0].hero_id = 20; if (change === 'mode') raw.game_mode = 23;
    await fx.clock.tick(300000); const failed = await fx.process(fx.pipe(live)); assert.equal(failed.reason, 'input-changed'); assert.equal(fx.storage.listAttempts(job.id).length, 0);
  }
  const fx = await fixture(t), pipeline = fx.pipe({ ...live, automaticSince: 0 }); const scan = await drive(pipeline.discoverOnce(), fx.clock);
  fx.matches.get(101)!.players[2].account_id = null; const failed = await fx.process(pipeline); assert.equal(failed.id, scan.queued[0]); assert.equal(failed.reason, 'eligibility-changed'); assert.equal(fx.posts('analysis').length, 0);
});

test('bad dictionary or oversized facts fail before MiMo; experimental gate waits without preflight', async t => {
  const fx = await fixture(t), pipeline = fx.pipe(live, { facts: { dictionary: {} } }); await fx.request(pipeline); assert.equal((await fx.process(pipeline)).reason, 'facts-invalid'); assert.equal(fx.posts('analysis').length, 0);
  const second = await fixture(t), blocked = second.pipe({ ...live, allowExperimental: false }); const job = await second.request(blocked);
  assert.equal((await second.process(blocked)).reason, 'experimental-disabled'); assert.equal(second.storage.listAttempts(job.id).length, 0); assert.equal(second.calls.filter(call => call.url.endsWith('/endpoints')).length, 0);
  const third = await fixture(t), oversized = third.pipe(live); const raw = third.matches.get(101)!;
  raw.teamfights = Array.from({ length: 10000 }, (_, i) => ({ start: i, end: i + 1, deaths: 1, players: [] }));
  await third.request(oversized); assert.equal((await third.process(oversized)).reason, 'facts-invalid'); assert.equal(third.posts('analysis').length, 0);
});

test('one worker, heartbeat updates Claim during metadata and beforeSend observes latest version', async t => {
  const fx = await fixture(t), pipeline = fx.pipe(live), job = await fx.request(pipeline), pending = deferred<Response>();
  fx.hooks.analysis = url => url.endsWith('/endpoints') ? pending.promise : undefined;
  const processing = pipeline.processNext(); await fx.clock.tick(3000); assert.equal((await pipeline.processNext()).status, 'busy');
  const old = fx.storage.getJob(job.id); await fx.clock.tick(80000); const current = fx.storage.getJob(job.id);
  assert.ok(current.version > old.version); assert.ok(current.leaseUntil! > fx.clock.now());
  assert.throws(() => fx.storage.renewClaim({ jobId: old.id, token: old.leaseToken!, version: old.version }), (error: unknown) => error instanceof StorageError && error.code === 'lease-lost');
  pending.resolve(Response.json(metadata())); const result = await drive(processing, fx.clock); assert.equal(result.status, 'processed'); assert.equal(fx.posts('analysis').length, 1);
  assert.equal(fx.clock.timers.size, 0); assert.equal(fx.storage.listAttempts(job.id)[0].state, 'finished');
});

test('lease loss before send blocks POST and closes not-sent reservation; after POST known late outcome persists', async t => {
  for (const phase of ['preflight', 'post'] as const) {
    const fx = await fixture(t); let lose = false;
    const storage = intercepted(fx.storage, { renewClaim: ((claim: Parameters<Storage['renewClaim']>[0]) => { if (lose) throw new StorageError('lease-lost', 'renewClaim'); return fx.storage.renewClaim(claim); }) as never });
    const pipeline = fx.pipe(live, { storage }), job = await fx.request(pipeline), pending = deferred<Response>();
    fx.hooks.analysis = (url, init) => phase === 'preflight' && url.endsWith('/endpoints') || phase === 'post' && init.method === 'POST' ? pending.promise : undefined;
    const processing = pipeline.processNext(); await fx.clock.tick(3000); lose = true; await fx.clock.tick(20000);
    pending.resolve(phase === 'preflight' ? Response.json(metadata()) : response(fx.posts('analysis')[0].body));
    await drive(processing, fx.clock); const receipts = fx.storage.listAttempts(job.id);
    assert.equal(fx.posts('analysis').length, phase === 'preflight' ? 0 : 1); assert.equal(receipts[0].state, 'finished'); assert.equal(fx.storage.getJob(job.id).state, 'running');
    // Аналитик фиксирует отмену отправленного запроса; поздний HTTP payload не заменяет его финал.
    if (phase === 'post') assert.equal((receipts[0].outcome as AnalysisAttempt).billingState, 'unknown');
    await fx.clock.tick(60000); fx.storage.recoverInterrupted(); assert.equal(fx.clock.timers.size, 0);
  }
});

test('analysis preflight estimate limit/not-sent/null identity waits without paid POST or leaked reservation', async t => {
  const fx = await fixture(t), pipeline = fx.pipe({ ...live, maxEstimatedCostPerAttemptUsd: 0.00000001 }); const job = await fx.request(pipeline);
  assert.equal((await fx.process(pipeline)).reason, 'analysis-estimated-cost-exceeded'); assert.equal(fx.posts('analysis').length, 0); assert.equal(fx.storage.listAttempts(job.id)[0].state, 'finished');
  const second = await fixture(t), early = second.pipe(live, { apiKey: 'match-analysis-v1' }); const earlyJob = await second.request(early);
  await second.process(early); const result = second.storage.listAttempts(earlyJob.id)[0].outcome as AnalysisAttempt;
  assert.equal(result.attemptId, null); assert.equal(result.identity, null); assert.equal(result.billingState, 'not-sent'); assert.equal(second.posts('analysis').length, 0);
});

test('budget charges zero/invalid/actual overrun, unknown blocks all preflight and operator release cannot bypass it', async t => {
  for (const cost of [0, 0.002, null, 20] as const) {
    const fx = await fixture(t), pipeline = fx.pipe(live, { publisher: fx.publisher });
    fx.hooks.analysis = (url, init) => url.endsWith('/endpoints') ? undefined : cost === 0 ? response(init.body, cost) : Response.json({ model: prompt.profile.model, choices: [], usage: cost === null ? {} : { cost } });
    const first = await fx.request(pipeline); await fx.process(pipeline);
    const billing = fx.storage.getBillingSummary(); assert.equal(billing.knownCostUsd, cost ?? 0); assert.equal(billing.unknownCount, cost === null ? 1 : 0);
    fx.matches.set(102, data(102)); await fx.request(pipeline, 102); const preflights = fx.calls.filter(call => call.url.endsWith('/endpoints')).length;
    const second = await fx.process(pipeline);
    if (cost === null || cost === 20) {
      assert.equal(second.reason, cost === null ? 'budget-unknown' : 'budget-exhausted'); assert.equal(fx.calls.filter(call => call.url.endsWith('/endpoints')).length, preflights);
    } else assert.equal(fx.posts('analysis').length, 2);
    assert.equal(pipeline.getStatus({ jobId: first.id }).billingUnknown, cost === null);
  }
  const fx = await fixture(t), preparation = fx.pipe(); const job = await fx.request(preparation); await fx.process(preparation); await preparation.stop();
  await fx.clock.tick(300000); const claim = fx.storage.claimNext()!.claim; const admitted = started(fx.storage, claim);
  fx.storage.finish(claim, { state: 'needs-attention', reason: 'operator-check' });
  fx.storage.resolveUncertain({ resolutionId: 'review-1', jobId: job.id, expectedVersion: fx.storage.getJob(job.id).version, attemptId: admitted.attemptId, decision: 'allow-new-attempt', state: 'waiting', reason: 'explicit', evidenceRef: 'review' });
  const pipeline = fx.pipe(live); assert.equal((await fx.process(pipeline)).reason, 'budget-unknown'); assert.equal(fx.posts('analysis').length, 0);
});

test('beforeSend rereads budget after metadata; start COMMIT failure gives zero POST and stops further work', async t => {
  const fx = await fixture(t), preparation = fx.pipe(); await fx.request(preparation); await fx.process(preparation); await preparation.stop(); await fx.clock.tick(300000);
  const other = fx.storage.enqueueInitial({ matchId: 102, side: 'radiant', origin: 'manual', settings });
  let reads = 0; const original = fx.storage.getBillingSummary.bind(fx.storage);
  const storage = intercepted(fx.storage, { getBillingSummary: (() => { const summary = original(); return ++reads >= 2 ? { ...summary, knownCostUsd: 10 } : summary; }) as never });
  const pipeline = fx.pipe(live, { storage }); assert.equal((await fx.process(pipeline)).reason, 'budget-exhausted'); assert.equal(fx.posts('analysis').length, 0); assert.equal(fx.storage.getJob(other.id).state, 'queued');
  const second = await fixture(t), faulty = second.pipe(live, { storage: intercepted(second.storage, { startAnalysis: ((...args: Parameters<Storage['startAnalysis']>) => {
    const original = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) { if (sql === 'COMMIT') throw new Error('synthetic disk failure'); return original.call(this, sql); };
    try { return second.storage.startAnalysis(...args); } finally { DatabaseSync.prototype.exec = original; }
  }) as never }) });
  const job = await second.request(faulty); await assert.rejects(drive(faulty.processNext(), second.clock), (error: unknown) => (error as { code: string }).code === 'storage-failure');
  assert.equal(second.posts('analysis').length, 0); assert.equal(second.storage.listAttempts(job.id)[0].state, 'finished');
  await assert.rejects(faulty.processNext(), (error: unknown) => (error as { code: string }).code === 'storage-failure');
});

test('started followed by requestSent=false stays uncertain; paid errors never retry', async t => {
  const fx = await fixture(t), controller = new AbortController();
  const storage = intercepted(fx.storage, { startAnalysis: ((...args: Parameters<Storage['startAnalysis']>) => { fx.storage.startAnalysis(...args); controller.abort(); }) as never });
  const pipeline = fx.pipe(live, { storage }); const job = await fx.request(pipeline);
  const result = await drive(pipeline.processNext({ signal: controller.signal }), fx.clock); assert.equal(result.status, 'processed');
  assert.equal(fx.storage.getJob(job.id).reason, 'analysis-not-sent-after-start'); assert.equal(fx.storage.listAttempts(job.id)[0].outcome, null); assert.equal(fx.posts('analysis').length, 0);
  for (const failure of ['length', '429', 'network', 'model', 'invalid', 'timeout'] as const) {
    const next = await fixture(t), run = next.pipe({ ...live, analysisTimeoutMs: failure === 'timeout' ? 5 : 180000 }); await next.request(run);
    next.hooks.analysis = (url, init) => {
      if (url.endsWith('/endpoints')) return undefined;
      if (failure === 'network') throw new Error('secret transport');
      if (failure === 'timeout') return new Promise(() => {});
      if (failure === '429') return Response.json({ usage: { cost: 0.002 } }, { status: 429, headers: { 'Retry-After': '60' } });
      return Response.json({ model: failure === 'model' ? 'other' : prompt.profile.model, choices: [{ finish_reason: failure === 'length' ? 'length' : 'stop', message: { role: 'assistant', content: '{}' } }], usage: { cost: 0.003 } });
    };
    // Таймаут аналитика использует настоящий короткий таймер, остальные ожидания — управляемые часы.
    const job = failure === 'timeout' ? await (async () => { const pending = run.processNext(); await next.clock.tick(3000); await new Promise(resolve => setTimeout(resolve, 15)); const result = await pending; assert.equal(result.status, 'processed'); return result.status === 'processed' ? result.job : assert.fail(); })() : await next.process(run);
    assert.equal(job.state, 'failed'); assert.equal(next.posts('analysis').length, 1); await next.clock.tick(400000); assert.equal((await run.processNext()).status, 'idle'); assert.equal(next.posts('analysis').length, 1);
  }
});
