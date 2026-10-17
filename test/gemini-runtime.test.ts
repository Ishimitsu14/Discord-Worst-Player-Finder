import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { validateCompactDictionaries, prepareCompactMatchFacts } from '../src/match-facts/index.js';
import { renderAnalysis } from '../src/discord-interface/index.js';
import { commands, interaction } from './discord-interface-helpers.js';
import { drive, flush, pipelineError } from './match-pipeline-helpers.js';
import { setup, started, invalidAttempt } from './storage-helpers.js';
import { geminiFixture, compactOptions, geminiPrompt, geminiPromptV2, live, settings, geminiStreamResponse, geminiEvents, geminiAnswerV2, geminiMetadata, brokenConnection, storeGemini, storedGeminiAttempt, recovery } from './gemini-runtime-helpers.js';

test('dictionary validator performs no environment, filesystem or network access', t => {
  const env = process.env, network = globalThis.fetch;
  const read = t.mock.method(fs, 'readFileSync', () => { throw Error('unexpected filesystem'); });
  try {
    process.env = new Proxy({}, { get() { throw Error('unexpected env'); } }); globalThis.fetch = async () => { throw Error('unexpected network'); };
    validateCompactDictionaries(compactOptions);
  } finally { process.env = env; globalThis.fetch = network; read.mock.restore(); }
});

test('runtime materials: pure pinned validation, unchanged bundle, strict config before any IO', async t => {
  const fx = await geminiFixture(t), input = { matchId: 101, side: 'radiant' as const, data: fx.matches.get(101)! };
  const before = prepareCompactMatchFacts(input, compactOptions); validateCompactDictionaries(compactOptions);
  assert.deepEqual(prepareCompactMatchFacts(input, compactOptions), before);
  for (const key of ['dictionary', 'heroMetricsDictionary'] as const) {
    const bad = structuredClone(compactOptions); (bad[key] as Record<string, unknown>).version = 999;
    assert.throws(() => validateCompactDictionaries(bad));
    assert.throws(() => fx.geminiPipe({}, { heroMetricsDictionary: bad.heroMetricsDictionary, facts: { dictionary: bad.dictionary } }), pipelineError('invalid-config'));
  }
  for (const overrides of [{ geminiPrompt: undefined }, { heroMetricsDictionary: undefined }, { managementKey: 'sk-synthetic-pipeline-secret' }, { geminiPrompt: { ...geminiPromptV2, digest: 'x' } }]) {
    assert.throws(() => fx.geminiPipe({}, overrides), pipelineError('invalid-config'));
  }
  assert.equal(fx.pipe().config.analysisProfile, 'legacy'); assert.equal(fx.calls.length, 0);
});

for (const side of ['radiant', 'dire'] as const) for (const won of [true, false]) for (const version of [1, 2]) {
  test(`Gemini runtime: ${side} won=${won} v${version} prepare/live/SSE/publication/reopen/cache`, async t => {
    const fx = await geminiFixture(t); fx.matches.get(101)!.radiant_win = won === (side === 'radiant');
    const materials = { geminiPrompt: version === 1 ? geminiPrompt : geminiPromptV2 };
    const dry = fx.geminiPipe({}, materials), job = await fx.request(dry, 101, side), waiting = await fx.process(dry);
    assert.equal(waiting.reason, 'live-disabled'); assert.equal(fx.posts('analysis').length + fx.management.length + fx.sends(), 0);
    const artifacts = fx.storage.getJobArtifacts(job.id, 'gemini'); assert.equal(artifacts.bundle!.context.players.length, 5);
    const frozen = artifacts.prepared!.body; await dry.stop(); await fx.clock.tick(300000); fx.reopen();
    const pipeline = fx.geminiPipe(live, { geminiPrompt: version === 1 ? geminiPromptV2 : geminiPrompt });
    const result = await fx.process(pipeline); assert.equal(result.state, 'succeeded'); assert.equal(fx.posts('analysis').length, 1); assert.equal(fx.sends(), 1);
    assert.equal(fx.posts('analysis')[0].body, frozen); const stored = fx.storage.getLatestResult(101, side, 'gemini')!;
    assert.equal(stored.attempt.analysis!.version, version); assert.equal(stored.attempt.responseReceived, true); assert.ok(stored.attempt.streamBytes > 0);
    const embed = renderAnalysis({ analysisProfile: 'gemini', job: stored.job, analysis: stored.attempt, bundle: artifacts.bundle!, snapshot: artifacts.snapshot! });
    assert.match(embed.title!, won ? /победа/ : /поражение/); assert.equal(embed.fields!.filter(row => row.name.startsWith('Основание')).length, 3);
    if (side === 'dire') assert.match(embed.fields!.find(row => row.name.startsWith('Его чат'))!.name, /20:00/);
    if (version === 2) { assert.equal(embed.fields!.slice(-3).length, 3); embed.fields!.slice(-3).forEach((row, index) => assert.match(row.name, new RegExp(`${index + 1}/3`))); assert.match(embed.fields!.at(-1)!.name, won ? /Слабые места/ : /Почему проебали/); }
    else assert.equal(embed.fields!.some(row => /1\/3/.test(row.name)), false);
    const calls = fx.calls.length, ui = commands(fx, pipeline), first = interaction({ matchId: '101', side }), status = interaction({ name: 'worst-status', jobId: job.id });
    await ui.handle(first); await ui.handle(status); await ui.ui.stop();
    assert.equal(fx.calls.length, calls); assert.equal(fx.sends(), 1); assert.equal(first.responses.at(-1)!.body.embeds instanceof Array, true);
    await pipeline.stop(); fx.reopen(); assert.equal(fx.storage.getLatestResult(101, side)!.attempt.status, 'valid');
  });
}

test('Gemini basic waits for parse; saved profile survives switch and legacy-only caller defers before OpenDota', async t => {
  const fx = await geminiFixture(t), dry = fx.geminiPipe({}); fx.matches.get(101)!.version = null;
  const job = await fx.request(dry); assert.equal((await fx.process(dry)).reason, 'parse-disabled'); assert.equal(fx.storage.getJobArtifacts(job.id).prepared, null);
  await dry.stop(); await fx.clock.tick(300000); const old = fx.pipe(); const before = fx.calls.length;
  assert.equal((await fx.process(old)).reason, 'analysis-profile-unavailable'); assert.equal(fx.calls.length, before);
  await old.stop(); await fx.clock.tick(300000); fx.matches.get(101)!.version = 1;
  const compatible = fx.geminiPipe(live), completed = await fx.process(compatible); assert.equal(completed.analysisProfile, 'gemini'); assert.equal(completed.state, 'succeeded');
  assert.equal((await fx.request(fx.pipe(live), 101)).id, job.id); assert.equal(fx.posts('analysis').length, 1);
});

test('Gemini recovery: exact session checks at 10/30/60, reserved original, one child, cache and reopen', async t => {
  const fx = await geminiFixture(t); let posts = 0; fx.controls.inference = () => { if (++posts === 1) brokenConnection(); return undefined; };
  const pipeline = fx.geminiPipe(), job = await fx.request(pipeline), start = fx.clock.now();
  const completed = await fx.process(pipeline); assert.equal(completed.state, 'succeeded'); assert.equal(posts, 2); assert.equal(fx.sends(), 1);
  const receipts = fx.storage.listAttempts(job.id).filter(item => item.kind === 'analysis'), parent = receipts.find(item => item.released)!;
  const audit = fx.storage.getGeminiRecovery(parent.id)!; assert.equal(audit.retryAttemptId, receipts.find(item => !item.released)!.id);
  assert.equal(fx.management.length, 3); assert.deepEqual(fx.management.map(row => row.time - start), [10000, 30000, 60000]);
  fx.management.forEach(row => { assert.equal(row.key, 'Bearer synthetic-management-key'); assert.deepEqual(row.body.filters, [{ field: 'session_id', operator: 'eq', value: parent.id }]); });
  const billing = fx.storage.getBillingSummary(); assert.equal(billing.knownCostUsd, 0.001); assert.equal(billing.unknownCount, 1); assert.equal(billing.uncoveredUnknownCount, 0); assert.ok(billing.reservedCostUsd > 0);
  await pipeline.stop(); fx.reopen(); assert.deepEqual(fx.storage.getBillingSummary(), billing); assert.equal((await fx.request(fx.geminiPipe())).id, job.id); assert.equal(posts, 2);
});

for (const scenario of ['missing-key', 'http-response', 'partial', 'recorded', 'recorded-no-price', 'malformed', 'truncated', 'stale', 'wrong-session', 'child-unknown'] as const) {
  test(`Gemini recovery refuses unsafe repeat: ${scenario}`, async t => {
    const fx = await geminiFixture(t); let posts = 0;
    fx.controls.inference = () => { posts++;
      if (scenario === 'http-response') return Response.json({ error: { message: 'synthetic' } }, { status: 503 });
      if (scenario === 'partial') return geminiStreamResponse('data: {"choices":[{"delta":{"content":"{"}}]}\n\n');
      return brokenConnection();
    };
    fx.controls.analytics = init => {
      if (scenario === 'child-unknown') return undefined;
      const session = (JSON.parse(String(init.body)).filters as { value: string }[])[0].value;
      if (scenario === 'recorded' || scenario === 'recorded-no-price') {
        if (fx.management.length === 1) return undefined;
        return Response.json({ data: { data: [{ session_id: session, generation_id: 'gen-delayed', total_usage: 0.002, request_count: 1 }], metadata: { row_count: 1, truncated: false } } });
      }
      if (scenario === 'wrong-session') return Response.json({ data: { data: [{ session_id: 'other', generation_id: 'gen-wrong', total_usage: 0, request_count: 1 }], metadata: { row_count: 1, truncated: false } } });
      if (scenario === 'stale') return Response.json({ data: { data: [], metadata: { row_count: 0, truncated: false }, cachedAt: 0 } });
      return Response.json({ data: { data: [], metadata: { row_count: scenario === 'malformed' ? 1 : 0, truncated: scenario === 'truncated' } } });
    };
    if (scenario === 'recorded-no-price') {
      const original = fx.hooks.analysis!; fx.hooks.analysis = (url, init) => url.includes('/generation?') ? new Response(null, { status: 503 }) : original(url, init);
    }
    const pipeline = fx.geminiPipe(live, scenario === 'missing-key' ? { managementKey: undefined } : {}), job = await fx.request(pipeline);
    assert.equal((await fx.process(pipeline)).state, 'needs-attention'); assert.equal(posts, scenario === 'child-unknown' ? 2 : 1); assert.equal(fx.sends(), 0);
    assert.equal(fx.storage.getLatestResult(101, 'radiant'), null);
    if (['missing-key', 'partial', 'http-response'].includes(scenario)) assert.equal(fx.management.length, 0);
    if (scenario === 'recorded') { assert.equal(fx.management.length, 2); assert.equal(fx.storage.getBillingSummary().knownCostUsd, 0.002); assert.equal(fx.storage.getBillingSummary().unknownCount, 0); }
    else assert.ok(fx.storage.getBillingSummary().uncoveredUnknownCount > 0);
    assert.equal((await pipeline.processNext()).status, 'idle'); await fx.request(pipeline); assert.equal(posts, scenario === 'child-unknown' ? 2 : 1);
    assert.equal(pipeline.getStatus({ jobId: job.id }).result, null);
  });
}

test('Gemini recovery budget includes reserve and fresh retry tariffs, child preflight consumes its slot', async t => {
  for (const scenario of ['low-budget', 'changed-price', 'child-preflight'] as const) {
    const fx = await geminiFixture(t); let posts = 0, metadata = 0;
    fx.controls.inference = () => { posts++; return brokenConnection(); };
    fx.controls.metadata = () => {
      metadata++; const value = geminiMetadata();
      if (metadata > 1 && scenario === 'changed-price') value.data.endpoints[0].pricing.completion = '1';
      return metadata > 1 && scenario === 'child-preflight' ? new Response(null, { status: 503 }) : Response.json(value);
    };
    const pipeline = fx.geminiPipe({ ...live, maxTotalCostUsd: scenario === 'low-budget' ? 0.025 : 1 }), job = await fx.request(pipeline);
    const result = await fx.process(pipeline); assert.notEqual(result.state, 'succeeded'); assert.equal(posts, 1); assert.equal(fx.management.length, 3);
    const root = fx.storage.listAttempts(job.id).find(item => item.kind === 'analysis' && item.outcome && 'requestSent' in item.outcome && item.outcome.requestSent)!;
    assert.equal(fx.storage.getGeminiRecovery(root.id)!.retryAttemptId !== null, scenario !== 'low-budget');
    assert.equal((await pipeline.processNext()).status, 'idle'); assert.equal(posts, 1);
  }
});

for (const unknown of [false, true]) test(`Gemini beforeSend rereads ledger changed during metadata, unknown=${unknown}`, async t => {
  const fx = await geminiFixture(t); fx.controls.metadata = () => {
    const other = setup(fx.storage, 102), start = started(fx.storage, other.claim), final = invalidAttempt(start, unknown ? null : live.maxTotalCostUsd - 0.000001);
    fx.storage.saveAnalysisOutcome(start.attemptId, final); fx.storage.finish(other.claim, { state: 'failed', reason: 'synthetic' }); return Response.json(geminiMetadata());
  };
  const pipeline = fx.geminiPipe(), job = await fx.request(pipeline), result = await fx.process(pipeline);
  assert.equal(result.reason, unknown ? 'budget-unknown' : 'estimated-cost-exceeded'); assert.equal(fx.posts('analysis').length, 0);
  const receipt = fx.storage.listAttempts(job.id)[0]; assert.equal(receipt.started, null); assert.ok(receipt.outcome);
});

test('raising a Gemini recovery budget does not resume attention without explicit audited operator decision', async t => {
  const fx = await geminiFixture(t); let posts = 0; fx.controls.inference = () => { if (++posts === 1) brokenConnection(); return undefined; };
  const first = fx.geminiPipe({ ...live, maxTotalCostUsd: 0.025 }), job = await fx.request(first); await fx.process(first); await first.stop();
  const next = fx.geminiPipe(), attention = fx.storage.getJob(job.id); assert.equal(attention.state, 'needs-attention'); assert.equal((await next.processNext()).status, 'idle');
  const root = fx.storage.listAttempts(job.id).find(row => row.kind === 'analysis')!;
  fx.storage.resolveUncertain({ resolutionId: 'operator-budget-decision', jobId: job.id, expectedVersion: attention.version, attemptId: root.id,
    decision: 'allow-new-attempt', state: 'waiting', reason: 'operator-budget-approved', evidenceRef: 'local-budget-decision' });
  assert.equal((await fx.process(next)).state, 'succeeded'); assert.equal(posts, 2); assert.equal(fx.management.length, 3);
});

test('Gemini stop during management saves aborted audit, never retries or publishes', async t => {
  const fx = await geminiFixture(t); fx.controls.inference = brokenConnection;
  const pipeline = fx.geminiPipe(), job = await fx.request(pipeline), processing = pipeline.processNext();
  await flush(); const stopping = pipeline.stop(); await drive(Promise.all([processing, stopping]), fx.clock);
  assert.equal(fx.posts('analysis').length, 1); assert.equal(fx.sends(), 0); assert.equal(fx.storage.getJob(job.id).state, 'needs-attention');
});

for (const phase of ['valid-final', 'unknown-final', 'retry-decision'] as const) test(`Gemini pipeline resumes ${phase} without reloading frozen inputs or repeating completed effects`, async t => {
  const fx = await geminiFixture(t), saved = storeGemini(fx.storage), attempt = await storedGeminiAttempt(fx.storage, saved.claim, phase === 'valid-final' ? undefined : brokenConnection);
  fx.storage.saveAnalysisOutcome(attempt.attemptId!, attempt);
  if (phase === 'retry-decision') fx.storage.saveGeminiRecovery(attempt.attemptId!, recovery(attempt));
  await fx.clock.tick(61000); fx.reopen(); const before = fx.calls.length, pipeline = fx.geminiPipe();
  assert.equal((await fx.process(pipeline)).state, 'succeeded'); assert.equal(fx.sends(), 1);
  assert.equal(fx.calls.slice(before).some(row => row.url.startsWith('/api/')), false);
  assert.equal(fx.posts('analysis').length, phase === 'valid-final' ? 0 : 1); assert.equal(fx.management.length, phase === 'unknown-final' ? 3 : 0);
  const calls = fx.calls.length; assert.equal((await pipeline.processNext()).status, 'idle'); assert.equal(fx.calls.length, calls);
});

test('Gemini management lease loss saves safe audit and prevents retry admission', async t => {
  const fx = await geminiFixture(t); fx.controls.inference = brokenConnection;
  fx.controls.analytics = () => {
    const db = new DatabaseSync(fx.path); db.prepare("UPDATE jobs SET lease_until=?,version=version+1 WHERE state='running'").run(fx.clock.now() - 1); db.close(); return undefined;
  };
  const pipeline = fx.geminiPipe(), job = await fx.request(pipeline); await fx.process(pipeline);
  assert.equal(fx.posts('analysis').length, 1); assert.equal(fx.sends(), 0); fx.storage.recoverInterrupted(); assert.equal(fx.storage.getJob(job.id).state, 'needs-attention');
  assert.equal(fx.storage.listAttempts(job.id).filter(row => row.kind === 'analysis').length, 1);
});

test('Gemini recovery keeps discovery independent and awaiting-data commands free of external work', async t => {
  const fx = await geminiFixture(t), started = fx.clock.now(); let history = 0, posts = 0;
  fx.controls.inference = () => { if (++posts === 1) brokenConnection(); return undefined; };
  const pipeline = fx.geminiPipe({ ...live, historySource: 'steam', automaticSince: started - 600000 }, { steam: { getMatchHistory: async accountId => {
    history++; return { matches: [{ matchId: 102, startTime: 1799998000 }], nextStartAtMatchId: null };
  } } });
  const job = await fx.request(pipeline), processing = pipeline.processNext(); await flush();
  const scan = await drive(pipeline.discoverOnce(), fx.clock); assert.equal(scan.pending, 1); assert.equal(history, 2);
  const calls = fx.calls.length, request = await pipeline.requestMatch({ matchId: 102 }); assert.equal(request.status, 'awaiting-data'); assert.equal(fx.calls.length, calls);
  assert.equal((await pipeline.processNext()).status, 'busy'); await drive(processing, fx.clock); assert.equal(posts, 2); assert.equal(fx.storage.getJob(job.id).state, 'succeeded');
});
