import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMatchPipeline, type PipelineDependencies, type PipelineOptions, type MatchRequestResult } from '../src/match-pipeline/index.js';
import { fixture, settings, data, drive, queued, live, pipelineError, dictionary, prompt } from './match-pipeline-helpers.js';
import { deferred, flush } from './opendota-helpers.js';
import { classify, endAt } from '../src/match-pipeline/classify.js';

test('pipeline creation is inert, prepare-only by default, copies configuration and rejects invalid inputs', async t => {
  const fx = await fixture(t), options = { pageSize: 3 }, config = structuredClone(settings), packageCopy = structuredClone(prompt);
  const pipeline = fx.pipe(options, { settings: config, prompt: packageCopy, apiKey: undefined });
  options.pageSize = 99; config.channelId = '123'; config.steamAccountIds.push(900000);
  packageCopy.profile.calibration = 'candidate';
  assert.equal(pipeline.config.mode, 'prepare-only'); assert.equal(pipeline.config.pageSize, 3); assert.ok(Object.isFrozen(pipeline.config)); assert.equal(fx.calls.length, 0);
  const job = await fx.request(pipeline); assert.deepEqual(job.settings, settings);
  const prepared = await fx.process(pipeline); assert.equal(prepared.reason, 'live-disabled');
  assert.equal(fx.storage.getJobArtifacts(job.id).prepared!.calibration, 'experimental');
  const deps: PipelineDependencies = { settings, storage: fx.storage, opendota: fx.opendota, facts: { dictionary }, prompt, clock: fx.clock };
  for (const bad of [null, [], { extra: true }, { pageSize: 0 }, { pageSize: 101 }, { maxPagesPerAccount: 11 }, { maxCandidatesPerScan: 1001 },
    { automaticSince: '123' }, { automaticSince: fx.clock.now() + 1 }, { pollIntervalMs: 59999 }, { workerIdleMs: 0 }, { pauseMs: 59999 },
    { parseTimeoutMs: 1000 }, { parsePollMs: 14999 }, { analysisTimeoutMs: 2147483648 }, { publicationTimeoutMs: 0 }, { allowExperimental: 1 },
    { mode: 'other' }, { mode: 'live' }, { ...live, maxTotalCostUsd: Infinity }, { ...live, maxEstimatedCostPerAttemptUsd: 0 }, { pageSize: undefined }]) {
    assert.throws(() => createMatchPipeline(bad as PipelineOptions, deps), pipelineError('invalid-config'));
  }
  for (const bad of [{ settings: { ...settings, steamAccountIds: [1, 1] } }, { settings: { ...settings, channelId: '01' } }, { facts: { dictionary, roleOverrides: [] } },
    { storage: {} }, { opendota: {} }, { clock: { now: 1 } }, { publisher: {} }, { onEvent: 1 }, { fetcher: 1 }]) {
    assert.throws(() => createMatchPipeline({}, { ...deps, ...bad } as unknown as PipelineDependencies), pipelineError('invalid-config'));
  }
  for (const file of ['index', 'types', 'config', 'classify', 'pipeline']) {
    const source = await readFile(`src/match-pipeline/${file}.ts`, 'utf8'); assert.doesNotMatch(source, /process\.env|node:fs|console\./);
  }
  assert.equal(fx.posts('analysis').length + fx.posts('parse').length, 0);
});

test('manual boundary validates numbers and side before network; explicit side works without friends', async t => {
  const fx = await fixture(t), pipeline = fx.pipe();
  for (const input of [{ matchId: '101' }, { matchId: 0 }, { matchId: NaN }, { matchId: 1.5 }, { matchId: Number.MAX_SAFE_INTEGER + 1 }, { matchId: 101, side: 'unknown' }, { matchId: 101, extra: true }]) {
    await assert.rejects(pipeline.requestMatch(input as { matchId: number }), pipelineError('invalid-input'));
  }
  assert.equal(fx.calls.length, 0);
  for (const method of ['requestMatch', 'processNext', 'discoverOnce', 'run'] as const) {
    await assert.rejects(method === 'requestMatch' ? pipeline.requestMatch({ matchId: 101 }, { signal: 'bad' } as never) : pipeline[method]({ signal: 'bad' } as never), pipelineError('invalid-input'));
  }
  await assert.rejects(pipeline.requestReanalysis({ matchId: 101, side: 'radiant', requestId: 'unsupported:key' }), pipelineError('invalid-input'));
  await assert.rejects(pipeline.requestReanalysis({ matchId: 101, side: undefined, requestId: 'valid-key' } as never), pipelineError('invalid-input'));
  fx.matches.get(101)!.players.forEach(player => { delete player.account_id; });
  assert.equal((await drive(pipeline.requestMatch({ matchId: 101 }), fx.clock)).status, 'requires-side');
  const job = await fx.request(pipeline); assert.equal(job.side, 'radiant');
  const before = fx.calls.length; assert.equal(queued(await pipeline.requestMatch({ matchId: 101, side: 'radiant' })).id, job.id); assert.equal(fx.calls.length, before);
  assert.equal(fx.storage.listAttempts(job.id).length, 0);
});

test('shared classifier accepts exactly the supported ranked modes and rejects unfinished/normal/turbo/unknown matches', async t => {
  const fx = await fixture(t), pipeline = fx.pipe(); let matchId = 200;
  for (const lobby of [5, 6, 7]) for (const mode of [1, 2, 3, 4, 5, 12, 16, 17, 22]) {
    const raw = data(++matchId); raw.lobby_type = lobby; raw.game_mode = mode; fx.matches.set(matchId, raw);
    assert.equal((await drive(pipeline.requestMatch({ matchId, side: 'radiant' }), fx.clock)).status, 'queued');
  }
  for (const change of [{ lobby_type: 0 }, { lobby_type: 8 }, { game_mode: 23 }, { game_mode: 15 }, { game_mode: 999 }, { radiant_win: null }, { duration: 0 }]) {
    const raw = Object.assign(data(++matchId), change); fx.matches.set(matchId, raw);
    const result = await drive(pipeline.requestMatch({ matchId, side: 'radiant' }), fx.clock); assert.equal(result.status, 'rejected');
  }
  assert.equal(fx.posts('parse').length, 0);
});

test('classifier uses distinct numeric accounts, canonical slots and all five allies; opponents may be incomplete', async t => {
  const fx = await fixture(t), pipeline = fx.pipe(); let matchId = 300;
  async function request(edit: (raw: ReturnType<typeof data>) => void, side?: 'radiant' | 'dire'): Promise<MatchRequestResult> {
    const raw = data(++matchId); edit(raw); fx.matches.set(matchId, raw); return drive(pipeline.requestMatch({ matchId, ...(side ? { side } : {}) }), fx.clock);
  }
  assert.equal(queued(await request(raw => { delete raw.players[2].account_id; })).side, 'radiant');
  for (const value of [null, undefined, 0, 4294967295, '100000']) {
    assert.equal((await request(raw => { raw.players.forEach(player => { player.account_id = value; }); })).status, 'requires-side');
  }
  assert.equal((await request(raw => { raw.players[5].account_id = 100002; raw.players[2].account_id = null; })).status, 'requires-side');
  assert.equal((await request(raw => { raw.players[5].account_id = 100000; })).status, 'requires-side');
  assert.equal((await request(raw => { raw.players[4].player_slot = 127; }, 'radiant')).status, 'rejected');
  const duplicate = data(); duplicate.players[4].player_slot = 3; assert.equal(classify(duplicate, settings, 'manual', 'radiant').status, 'rejected');
  await assert.rejects(request(raw => { raw.players[4].player_slot = 3; }, 'radiant'), pipelineError('opendota-failure'));
  assert.equal((await request(raw => { raw.players.splice(4, 1); }, 'radiant')).status, 'rejected');
  assert.equal((await request(raw => { raw.players = raw.players.slice(0, 5); }, 'radiant')).status, 'queued');
  assert.equal((await request(raw => { raw.players = raw.players.slice(5); }, 'dire')).status, 'queued');
});

test('automatic discovery deduplicates accounts/pages, uses strict persistent end cutoff and shares initial manual job', async t => {
  const fx = await fixture(t), cutoff = 1799999000000;
  for (const [matchId, start, duration] of [[102, 1799997000, 2000], [103, 1799997000, 2001], [104, 1900000000, 1], [105, Number.MAX_SAFE_INTEGER, 1500]]) {
    const raw = data(matchId); raw.start_time = start; raw.duration = duration; fx.matches.set(matchId, raw);
  }
  for (const account of settings.steamAccountIds) fx.history.set(account, [...fx.matches.values()]);
  const pipeline = fx.pipe({ automaticSince: cutoff });
  const report = await drive(pipeline.discoverOnce(), fx.clock); assert.equal(report.queued.length, 2); assert.equal(report.candidates, 5); assert.equal(report.partial, false);
  assert.deepEqual(report.rejected.map(row => row.matchId), [102, 104, 105]);
  const auto = fx.storage.getLatestJob(101, 'radiant')!; assert.equal(auto.origin, 'automatic');
  assert.equal(queued(await pipeline.requestMatch({ matchId: 101, side: 'radiant' })).id, auto.id);
  await pipeline.stop(); fx.reopen();
  const restarted = fx.pipe({ automaticSince: cutoff }); const repeated = await drive(restarted.discoverOnce(), fx.clock);
  assert.deepEqual(repeated.existing.sort(), report.queued.sort()); assert.equal(repeated.queued.length, 0); assert.equal(restarted.config.automaticSince, cutoff);
  const manual = await fx.request(restarted, 102); assert.equal(manual.matchId, 102);
  const noCutoff = fx.pipe(); await assert.rejects(noCutoff.discoverOnce(), pipelineError('automatic-since-required')); assert.equal(fx.posts('analysis').length, 0);
  assert.equal(endAt({ ...data(), start_time: 1.5 }, fx.clock.now()), null); assert.equal(endAt({ ...data(), duration: 1.5 }, fx.clock.now()), null);
});

test('automatic sides require two distinct accounts from full snapshot, never two jobs for ambiguity', async t => {
  const fx = await fixture(t), ids = [100000, 100002, 100005, 100006];
  const pipeline = fx.pipe({ automaticSince: 0 }, { settings: { ...settings, steamAccountIds: ids } });
  let report = await drive(pipeline.discoverOnce(), fx.clock); assert.deepEqual(report.requiresSide, [101]); assert.equal(fx.storage.getLatestJob(101, 'radiant'), null); assert.equal(fx.storage.getLatestJob(101, 'dire'), null);
  fx.matches.get(101)!.players[5].account_id = null; fx.matches.get(101)!.players[6].account_id = null;
  fx.matches.get(101)!.players[2].account_id = 100000;
  report = await drive(pipeline.discoverOnce(), fx.clock); assert.equal(report.rejected[0].code, 'not-group-match');
  fx.matches.get(101)!.players[2].account_id = '100002';
  report = await drive(pipeline.discoverOnce(), fx.clock); assert.equal(report.queued.length, 0);
  fx.matches.get(101)!.players[2].account_id = 100002;
  report = await drive(pipeline.discoverOnce(), fx.clock); assert.equal(report.queued.length, 1);
});

test('discovery reports bounded pages/candidates, contradictory rows and safe isolated history/detail failures', async t => {
  const fx = await fixture(t), raw102 = data(102); fx.matches.set(102, raw102);
  fx.hooks.opendota = url => {
    if (url.pathname.includes('/players/100000/')) return Response.json({ secret: 'do not report' }, { status: 403 });
    if (url.pathname.includes('/players/100002/')) return Response.json([
      { ...data(), start_time: 0, player_slot: 0, hero_id: 1 }, { ...data(), player_slot: 0, hero_id: 1 }, { ...raw102, player_slot: 0, hero_id: 1 },
    ]);
    if (url.pathname.endsWith('/matches/102')) return Response.json({}, { status: 404 });
  };
  const pipeline = fx.pipe({ automaticSince: 1799999000000, pageSize: 3, maxPagesPerAccount: 2, maxCandidatesPerScan: 2 });
  const report = await drive(pipeline.discoverOnce(), fx.clock);
  assert.equal(report.pages, 2); assert.equal(report.candidates, 2); assert.equal(report.queued.length, 1); assert.equal(report.partial, true);
  assert.equal(report.errors.length, 2); assert.doesNotMatch(JSON.stringify(report), /secret|do not report/);
  const capped = fx.pipe({ automaticSince: 0, maxCandidatesPerScan: 1 }); const capReport = await drive(capped.discoverOnce(), fx.clock); assert.equal(capReport.candidates, 1); assert.ok(capReport.partial);
});

test('manual job on the other side is not automatic side proof; concurrent discovery reports busy', async t => {
  const fx = await fixture(t), pipeline = fx.pipe({ automaticSince: 0 });
  const manual = await fx.request(pipeline, 101, 'dire');
  const pending = deferred<Response>(); fx.hooks.opendota = url => url.pathname.includes('/players/') ? pending.promise : undefined;
  const discovering = pipeline.discoverOnce(); await flush(); assert.equal((await pipeline.discoverOnce()).status, 'busy');
  pending.resolve(Response.json([{ ...data(), player_slot: 0, hero_id: 1 }]));
  const report = await drive(discovering, fx.clock); assert.equal(report.queued.length, 1); assert.notEqual(report.queued[0], manual.id);
});

test('reanalysis requires explicit side and persistent request ID, preserves initial task and prior result', async t => {
  const fx = await fixture(t), pipeline = fx.pipe(live, { publisher: fx.publisher });
  const initial = await fx.request(pipeline); assert.equal((await fx.process(pipeline)).state, 'succeeded');
  await assert.rejects(pipeline.requestReanalysis({ matchId: 101, requestId: 'no-side' } as never), pipelineError('invalid-input'));
  const first = queued(await drive(pipeline.requestReanalysis({ matchId: 101, side: 'radiant', requestId: 'command-1' }), fx.clock)); assert.equal(first.revision, 2);
  const repeated = queued(await drive(pipeline.requestReanalysis({ matchId: 101, side: 'radiant', requestId: 'command-1' }), fx.clock)); assert.equal(repeated.id, first.id);
  await assert.rejects(drive(pipeline.requestReanalysis({ matchId: 101, side: 'radiant', requestId: 'command-2' }), fx.clock), pipelineError('conflict'));
  assert.equal(queued(await pipeline.requestMatch({ matchId: 101, side: 'radiant' })).id, initial.id);
  fx.hooks.analysis = (url, init) => url.endsWith('/endpoints') ? undefined : Response.json({ model: prompt.profile.model, usage: { cost: 0.002 }, choices: [] });
  assert.equal((await fx.process(pipeline)).state, 'failed'); assert.equal(pipeline.getStatus({ jobId: first.id }).result!.job.id, initial.id);
  await pipeline.stop(); fx.reopen(); const next = fx.pipe();
  assert.equal(queued(await drive(next.requestReanalysis({ matchId: 101, side: 'radiant', requestId: 'command-1' }), fx.clock)).id, first.id);
});
