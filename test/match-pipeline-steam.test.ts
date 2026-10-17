import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SteamHistoryClient } from '../src/steam/index.js';
import { OpenDotaError, type MatchData } from '../src/opendota/index.js';
import { StorageError } from '../src/storage/index.js';
import type { PipelineOptions, PipelineEvent } from '../src/match-pipeline/index.js';
import { fixture, settings, data, drive, queued, live, pipelineError, intercepted, flush } from './match-pipeline-helpers.js';
import { deferred } from './opendota-helpers.js';

function page(ids: number[], remaining = 0) {
  return Response.json({ result: { status: 1, num_results: ids.length, total_results: ids.length + remaining, results_remaining: remaining,
    matches: ids.map(match_id => ({ match_id, start_time: 1799998000 })) } });
}
async function steamFixture(t: TestContext, options: PipelineOptions = {}) {
  const fx = await fixture(t), histories = new Map<number, number[]>(settings.steamAccountIds.map(id => [id, [101]]));
  const steamCalls: { accountId: number; cursor: number | null }[] = [], events: PipelineEvent[] = [];
  const hooks: { steam?: (accountId: number, cursor: number | null) => Response | Promise<Response> | undefined } = {};
  const steam = new SteamHistoryClient({ apiKey: 'synthetic-steam-secret' }, { clock: fx.clock, random: () => 0, fetcher: async url => {
    const params = new URL(String(url)).searchParams, accountId = Number(params.get('account_id'));
    const cursor = params.has('start_at_match_id') ? Number(params.get('start_at_match_id')) : null;
    steamCalls.push({ accountId, cursor }); return hooks.steam?.(accountId, cursor) ?? page(histories.get(accountId) ?? []);
  } });
  const config = { historySource: 'steam', automaticSince: fx.clock.now() - 600000, ...options } as const;
  const pipeline = fx.pipe(config, { steam, onEvent: value => { events.push(value); } });
  return Object.assign(fx, { histories, steamCalls, steam, steamHooks: hooks, events, config, pipeline,
    scan: () => drive(pipeline.discoverOnce(), fx.clock),
    gets: () => fx.calls.filter(call => call.url.startsWith('/api/matches/')).length });
}

test('Steam pipeline: source defaults, strict options, inert construction and manual-only without dependency', async t => {
  const fx = await steamFixture(t); assert.equal(fx.pipeline.config.pollIntervalMs, 60000); assert.equal(fx.pipe().config.pollIntervalMs, 900000);
  assert.equal(fx.pipe({ historySource: 'steam', pollIntervalMs: 120000 }).config.pollIntervalMs, 120000);
  assert.equal(fx.calls.length + fx.steamCalls.length + fx.clock.timers.size, 0);
  for (const bad of [{ historySource: 'stratz' }, { historySource: undefined }, { discoveryRetryMs: 59999 }, { discoveryTimeoutMs: 59999 },
    { discoveryRetryMs: 120000, discoveryTimeoutMs: 60000 }, { maxDiscoveryChecksPerScan: 0 }, { maxDiscoveryChecksPerScan: 1001 }, { maxDiscoveryChecksPerScan: 1.5 }]) {
    assert.throws(() => fx.pipe(bad as PipelineOptions), pipelineError('invalid-config'));
  }
  const manual = fx.pipe({ historySource: 'steam', automaticSince: fx.config.automaticSince });
  await assert.rejects(manual.run(), pipelineError('invalid-config')); assert.equal(fx.calls.length, 0);
  assert.equal((await drive(manual.requestMatch({ matchId: 101 }), fx.clock)).status, 'queued');
});

test('Steam pipeline: private account and temporary failure are isolated, retried next cycle, no OpenDota history', async t => {
  const fx = await steamFixture(t); fx.steamHooks.steam = account => account === settings.steamAccountIds[0] ? Response.json({ result: { status: 15 } }) : undefined;
  let report = await fx.scan(); assert.equal(report.queued.length, 1); assert.equal(report.accountsChecked, 2);
  assert.equal(report.errors[0].code, 'steam-history-private'); assert.equal(report.partial, true);
  assert.equal(fx.calls.some(call => call.url.includes('/players/')), false);
  fx.steamHooks.steam = account => { if (account === settings.steamAccountIds[0]) throw new Error('https://secret.invalid/?key=synthetic-steam-secret'); return undefined; };
  report = await fx.scan(); assert.equal(report.errors[0].code, 'steam-network-error');
  assert.equal(fx.steamCalls.filter(call => call.accountId === settings.steamAccountIds[0]).length, 4);
  assert.doesNotMatch(JSON.stringify([report, fx.events]), /synthetic|https|key=/);
});

test('Steam pipeline: all private is partial and creates no task, never excludes accounts', async t => {
  const fx = await steamFixture(t); fx.steamHooks.steam = () => Response.json({ result: { status: 15 } });
  for (let i = 0; i < 2; i++) { const report = await fx.scan(); assert.equal(report.pages, 0); assert.equal(report.errors.length, 2); assert.equal(report.queued.length, 0); }
  assert.equal(fx.steamCalls.length, 4); assert.equal(fx.gets(), 0); assert.equal(fx.storage.getLatestJob(101, 'radiant'), null);
});

test('Steam pipeline: global authorization/cooldown stops sends and identifies unchecked accounts', async t => {
  for (const status of [401, 403, 429]) {
    const fx = await steamFixture(t); fx.steamHooks.steam = () => new Response(null, { status, headers: { 'Retry-After': '120' } });
    const report = await fx.scan(); assert.equal(fx.steamCalls.length, 1); assert.equal(report.errors.length, 2);
    assert.equal(report.errors[1].code, 'steam-unchecked'); assert.equal(report.partial, true);
    if (status === 429) { await fx.scan(); assert.equal(fx.steamCalls.length, 1); }
  }
});

test('Steam pipeline: cursor pagination, new-ID cap and known terminal IDs do not starve later accounts', async t => {
  const fx = await steamFixture(t, { pageSize: 1, maxPagesPerAccount: 2, maxCandidatesPerScan: 1 });
  fx.steamHooks.steam = (account, cursor) => account === settings.steamAccountIds[0]
    ? cursor === null ? page([101], 1) : page([100]) : page([102]);
  for (const id of [100, 101, 102]) { const row = data(id); row.lobby_type = 0; fx.matches.set(id, row); }
  let report = await fx.scan(); assert.equal(report.deferred, 2); assert.equal(fx.gets(), 1);
  assert.deepEqual(fx.steamCalls.slice(0, 2).map(call => call.cursor), [null, 100]);
  report = await fx.scan(); assert.equal(report.deferred, 1); assert.equal(fx.gets(), 2);
  report = await fx.scan(); assert.equal(report.deferred, 0); assert.equal(fx.gets(), 3);
  await fx.clock.tick(1800001); await fx.scan(); assert.equal(fx.gets(), 3);
  assert.equal(fx.steamCalls.filter(call => call.accountId === settings.steamAccountIds[1]).length, 4);
});

test('manual old ready match bypasses an unverified Steam candidate beyond the scan limit', async t => {
  const fx = await steamFixture(t, { ...live, publicationMode: 'on-command', maxDiscoveryChecksPerScan: 1 });
  for (const id of [100, 101]) { const row = data(id); row.start_time -= 100000; fx.matches.set(id, row); }
  for (const account of settings.steamAccountIds) fx.histories.set(account, [100, 101]);
  const scan = await fx.scan(); assert.equal(scan.checks, 1); assert.equal(scan.queued.length, 0); const before = fx.gets(), history = fx.steamCalls.length;
  const requested = await drive(fx.pipeline.requestMatch({ matchId: 101 }), fx.clock); assert.ok('job' in requested); assert.equal(requested.job.origin, 'manual');
  assert.equal(fx.gets(), before + 1); assert.equal(fx.steamCalls.length, history);
  const worker = fx.pipe(fx.config, { steam: fx.steam, publisher: fx.publisher });
  assert.equal((await fx.process(worker)).state, 'succeeded'); assert.equal(fx.posts('analysis').length, 1);
  await fx.pipeline.requestMatch({ matchId: 101 }); assert.equal((await worker.processNext()).status, 'idle'); assert.equal(fx.posts('analysis').length, 1);
  assert.equal(fx.storage.getLatestJob(100, 'radiant'), null);
});

test('first manual candidate check persists missing/incomplete/error outcomes and repeated commands respect cooldown', async t => {
  for (const failure of ['missing', 'incomplete', 'rate-limited', 'invalid'] as const) {
    const fx = await steamFixture(t, { maxDiscoveryChecksPerScan: 1 }); fx.matches.set(100, data(100));
    for (const account of settings.steamAccountIds) fx.histories.set(account, [100, 101]); await fx.scan();
    if (failure === 'missing') fx.matches.delete(101);
    if (failure === 'incomplete') fx.matches.get(101)!.duration = 0;
    if (failure === 'rate-limited') t.mock.method(fx.opendota, 'getMatch', async () => { throw new OpenDotaError('rate_limited', 'getMatch', { retryAt: fx.clock.now() + 180000 }); });
    if (failure === 'invalid') fx.hooks.opendota = () => Response.json({ match_id: 'invalid' });
    const first = await drive(fx.pipeline.requestMatch({ matchId: 101 }), fx.clock); assert.equal(first.status, 'awaiting-data', failure);
    const before = fx.gets(), history = fx.steamCalls.length; fx.reopen(); const resumed = fx.pipe(fx.config, { steam: fx.steam });
    const repeated = await drive(resumed.requestMatch({ matchId: 101 }), fx.clock); assert.equal(repeated.status, 'awaiting-data');
    if (failure !== 'invalid') assert.equal(fx.gets(), before); assert.equal(fx.steamCalls.length, history); assert.equal(fx.posts('analysis').length, 0);
  }
});

test('Steam pipeline: 404 persists outside recent pages and reopen, manual request reads pending without API', async t => {
  const fx = await steamFixture(t); fx.matches.delete(101);
  const report = await fx.scan(); assert.equal(report.pending, 1); assert.equal(report.checks, 1); assert.equal(fx.gets(), 1);
  const before = fx.calls.length + fx.steamCalls.length, waiting = await fx.pipeline.requestMatch({ matchId: 101 });
  assert.equal(waiting.status, 'awaiting-data'); assert.equal(fx.calls.length + fx.steamCalls.length, before);
  await fx.pipeline.stop(); fx.reopen(); fx.histories.clear(); fx.matches.set(101, data()); await fx.clock.tick(60000);
  const next = fx.pipe(fx.config, { steam: fx.steam }); const ready = await drive(next.discoverOnce(), fx.clock);
  assert.equal(ready.queued.length, 1); assert.equal(ready.candidates, 0); assert.equal(fx.gets(), 2);
  assert.equal(fx.posts('parse').length + fx.posts('analysis').length, 0);
});

test('Steam pipeline: readiness, strict end cutoff, hidden IDs and ambiguous sides have distinct decisions', async t => {
  const cases: { edit: (row: MatchData) => void; pending?: boolean; queued?: boolean; reason?: string }[] = [
    { edit: row => { row.duration = 0; }, pending: true }, { edit: row => { row.radiant_win = null; }, pending: true },
    { edit: row => { row.players = row.players.filter(player => player.player_slot !== 4); }, pending: true },
    { edit: row => { row.players = row.players.slice(0, 1); }, pending: true },
    { edit: row => { row.players[2].account_id = null; }, reason: 'not-group-match' },
    { edit: row => { row.players[2].account_id = String(settings.steamAccountIds[1]); }, reason: 'not-group-match' },
    { edit: row => { row.players[5].account_id = settings.steamAccountIds[0]; }, reason: 'ambiguous-side' },
    { edit: row => { row.lobby_type = 0; }, reason: 'unsupported-match' },
    { edit: row => { row.start_time = 1799997900; }, reason: 'outside-window' },
    { edit: row => { row.start_time = 1799997901; }, queued: true },
  ];
  for (const scenario of cases) {
    const fx = await steamFixture(t), row = data(); scenario.edit(row); fx.matches.set(101, row);
    const report = await fx.scan(); assert.equal(report.pending, scenario.pending ? 1 : 0); assert.equal(report.queued.length, scenario.queued ? 1 : 0);
    if (scenario.reason) assert.ok([...report.rejected.map(row => row.code), ...(report.requiresSide.length ? ['ambiguous-side'] : [])].includes(scenario.reason), scenario.reason);
    assert.equal(fx.posts('parse').length + fx.posts('analysis').length, 0);
  }
});

test('Steam pipeline: malformed permanent response stops, transient respects retryAt and fixed expiry', async t => {
  const fx = await steamFixture(t, { discoveryTimeoutMs: 120000 });
  const fault = t.mock.method(fx.opendota, 'getMatch', async () => { throw new OpenDotaError('rate_limited', 'getMatch', { retryAt: fx.clock.now() + 180000 }); });
  const report = await fx.scan(); assert.equal(report.pending, 1);
  const waiting = await fx.pipeline.requestMatch({ matchId: 101 }); assert.ok(waiting.status === 'awaiting-data'); const expiry = fx.clock.now() + 120000;
  assert.ok(waiting.nextCheckAt! >= expiry); const before = fx.gets();
  await fx.clock.tick(120000); const expired = await fx.scan(); assert.equal(expired.pending, 0); assert.equal(fx.gets(), before);
  assert.equal(expired.rejected[0].code, 'discovery-timeout');
  fx.matches.delete(101); fault.mock.restore();
  const manual = await drive(fx.pipeline.requestMatch({ matchId: 101, side: 'radiant' }), fx.clock);
  assert.ok(manual.status === 'awaiting-data'); assert.equal(manual.nextCheckAt, null); assert.equal(manual.code, 'discovery-timeout');
  fx.matches.set(101, data()); assert.equal((await drive(fx.pipeline.requestMatch({ matchId: 101 }), fx.clock)).status, 'queued');
  const other = await steamFixture(t); other.hooks.opendota = () => Response.json({ match_id: 'invalid' });
  const invalid = await other.scan(); assert.equal(invalid.pending, 0); assert.equal(invalid.errors[0].code, 'opendota-invalid-response');
  await other.scan(); assert.equal(other.gets(), 1);
});

test('Steam pipeline: manual/automatic race and crash after enqueue reuse one job and valid result', async t => {
  const fx = await steamFixture(t), gate = deferred<Response>(); fx.hooks.opendota = () => gate.promise;
  const scanning = fx.pipeline.discoverOnce(); await flush();
  const manual = fx.pipeline.requestMatch({ matchId: 101, side: 'radiant' }); await flush();
  gate.resolve(Response.json(data())); const result = await drive(scanning, fx.clock), requested = await drive(manual, fx.clock);
  assert.ok(requested.status === 'awaiting-data' || 'job' in requested); assert.equal(result.queued.length, 1);
  const initial = fx.storage.getLatestJob(101, 'radiant')!; assert.equal(initial.revision, 1);
  await fx.pipeline.stop(); fx.hooks.opendota = undefined; const model = fx.pipe(live); const processed = await fx.process(model); assert.equal(fx.posts('analysis').length, 1, processed.reason ?? 'processed');
  const calls = fx.calls.length; const cached = await model.requestMatch({ matchId: 101 }); assert.ok('job' in cached); assert.ok(cached.result); assert.equal(fx.calls.length, calls);
  await model.stop(); fx.reopen(); const reopened = fx.pipe(fx.config, { steam: fx.steam }); await drive(reopened.discoverOnce(), fx.clock);
  assert.ok('job' in await reopened.requestMatch({ matchId: 101 })); assert.equal(fx.posts('analysis').length, 1);

  const broken = await steamFixture(t); await broken.pipeline.stop();
  const storage = intercepted(broken.storage, { decideDiscoveryCandidate: (() => { throw new StorageError('io-error', 'synthetic'); }) as never });
  const crashing = broken.pipe(broken.config, { steam: broken.steam, storage });
  await assert.rejects(drive(crashing.discoverOnce(), broken.clock), pipelineError('storage-failure'));
  const saved = broken.storage.getLatestJob(101, 'radiant')!; await crashing.stop(); broken.reopen();
  const recovery = broken.pipe(broken.config, { steam: broken.steam }); const report = await drive(recovery.discoverOnce(), broken.clock);
  assert.deepEqual(report.existing, [saved.id]); assert.equal(broken.storage.getLatestJob(101, 'radiant')!.revision, 1);
});

test('Steam pipeline: one scan/worker loop, abort cancels pending read and a second run is inert', async t => {
  const fx = await steamFixture(t), gate = deferred<Response>(); fx.steamHooks.steam = () => gate.promise;
  const running = fx.pipeline.run(); await flush(); assert.equal((await fx.pipeline.discoverOnce()).status, 'busy');
  assert.equal((await fx.pipeline.run()).status, 'already-running'); await fx.pipeline.stop(); assert.equal((await running).status, 'stopped');
  assert.equal(fx.gets(), 0); assert.equal(fx.clock.timers.size, 0); gate.resolve(page([]));
});

test('Steam pipeline: canonical context survives reordered IDs; new company/cutoff gets a separate decision', async t => {
  const fx = await steamFixture(t); fx.matches.get(101)!.lobby_type = 0; await fx.scan(); const before = fx.gets();
  await fx.pipeline.stop();
  const reordered = fx.pipe(fx.config, { steam: fx.steam, settings: { ...settings, steamAccountIds: [...settings.steamAccountIds].reverse() } });
  await drive(reordered.discoverOnce(), fx.clock); assert.equal(fx.gets(), before); await reordered.stop();
  const changed = fx.pipe(fx.config, { steam: fx.steam, settings: { ...settings, steamAccountIds: [...settings.steamAccountIds, 700000] } });
  await drive(changed.discoverOnce(), fx.clock); assert.equal(fx.gets(), before + 1); await changed.stop();
  const cutoff = fx.pipe({ ...fx.config, automaticSince: fx.config.automaticSince! - 1 }, { steam: fx.steam });
  await drive(cutoff.discoverOnce(), fx.clock); assert.equal(fx.gets(), before + 2);
});

test('Steam pipeline: two qualifying teams require a side and ordinary cached requests preserve ambiguity', async t => {
  const fx = await steamFixture(t); await fx.pipeline.stop();
  const group = { ...settings, steamAccountIds: [...settings.steamAccountIds, 100005, 100006] };
  const pipeline = fx.pipe(fx.config, { steam: fx.steam, settings: group });
  const report = await drive(pipeline.discoverOnce(), fx.clock); assert.deepEqual(report.requiresSide, [101]); assert.equal(report.queued.length, 0);
  const a = queued(await drive(pipeline.requestMatch({ matchId: 101, side: 'radiant' }), fx.clock));
  const b = queued(await drive(pipeline.requestMatch({ matchId: 101, side: 'dire' }), fx.clock)); const before = fx.calls.length;
  assert.equal((await pipeline.requestMatch({ matchId: 101 })).status, 'requires-side'); assert.equal(fx.calls.length, before);
  assert.equal(a.side, 'radiant'); assert.equal(b.side, 'dire'); assert.equal(fx.posts('analysis').length + fx.posts('parse').length, 0);
});

test('Steam integration: ten accounts, separate pairs, private teammate, bounded checks, reopen and cached valid', async t => {
  const fx = await steamFixture(t, { maxDiscoveryChecksPerScan: 2 }), ids = Array.from({ length: 10 }, (_, i) => 100000 + i);
  fx.histories.clear(); for (let i = 0; i < ids.length; i++) fx.histories.set(ids[i], i < 6 ? [101 + Math.floor(i / 2)] : []);
  fx.steamHooks.steam = id => id === ids[1] ? Response.json({ result: { status: 15 } }) : undefined;
  for (let i = 0; i < 3; i++) {
    const row = data(101 + i); row.players.forEach((player, index) => { player.account_id = 2000000 + index; });
    row.players[0].account_id = ids[i * 2]; row.players[2].account_id = ids[i * 2 + 1]; fx.matches.set(101 + i, row);
  }
  const delayed = fx.matches.get(101)!; fx.matches.delete(101); fx.matches.get(103)!.duration = 0;
  await fx.pipeline.stop(); const group = { ...settings, steamAccountIds: ids }, pipeline = fx.pipe(fx.config, { settings: group, steam: fx.steam });
  const first = await drive(pipeline.discoverOnce(), fx.clock); assert.equal(first.accountsChecked, 10); assert.equal(first.checks, 2); assert.equal(first.pending, 2); assert.equal(first.deferred, 1); assert.equal(first.queued.length, 1);
  assert.equal(fx.steamCalls.length, 10); assert.equal(fx.gets(), 2); await pipeline.stop(); fx.reopen(); fx.histories.clear(); await fx.clock.tick(60000);
  fx.matches.set(101, delayed); fx.matches.get(103)!.duration = 1500;
  const recovery = fx.pipe(fx.config, { settings: group, steam: fx.steam });
  const second = await drive(recovery.discoverOnce(), fx.clock); assert.equal(second.queued.length, 2); assert.equal(second.pending, 0); assert.equal(fx.gets(), 4);
  const jobs = [101, 102, 103].map(id => fx.storage.getLatestJob(id, 'radiant')!); assert.ok(jobs.every(job => job.revision === 1));
  await recovery.stop(); const worker = fx.pipe(live, { settings: group }); for (let i = 0; i < 3; i++) await fx.process(worker);
  assert.equal(fx.posts('analysis').length, 3); const before = fx.calls.length;
  for (const id of [101, 102, 103]) { const result = await worker.requestMatch({ matchId: id }); assert.ok('job' in result && result.result); }
  assert.equal(fx.calls.length, before); assert.equal(fx.calls.some(call => call.url.includes('/players/')), false);
  assert.equal((await worker.processNext()).status, 'idle');
});

test('on-command auto analysis excludes all history at or before activation and keeps the boundary after reopen', async t => {
  const fx = await steamFixture(t, { ...live, publicationMode: 'on-command' }), cutoff = fx.config.automaticSince;
  for (const [index, id] of [101, 102, 103].entries()) {
    const row = data(id); row.start_time = cutoff / 1000 - row.duration + index - 1; fx.matches.set(id, row);
  }
  for (const account of settings.steamAccountIds) fx.histories.set(account, [101, 102, 103]);
  const scan = await fx.scan(); assert.equal(scan.queued.length, 1); assert.equal(fx.storage.getLatestJob(101, 'radiant'), null); assert.equal(fx.storage.getLatestJob(102, 'radiant'), null);
  const ready = await fx.process(fx.pipeline); assert.equal(ready.matchId, 103); assert.equal(ready.origin, 'automatic'); assert.equal(ready.reason, 'publication-ready');
  assert.equal(fx.posts('analysis').length, 1); assert.equal(fx.storage.listAttempts(ready.id).some(attempt => attempt.kind === 'publication'), false);
  await fx.pipeline.stop(); fx.reopen(); await fx.clock.tick(60000);
  const resumed = fx.pipe(fx.config, { steam: fx.steam }); await drive(resumed.discoverOnce(), fx.clock);
  assert.equal(resumed.config.automaticSince, cutoff); assert.equal((await resumed.processNext()).status, 'idle');
  assert.equal(fx.storage.getLatestJob(101, 'radiant'), null); assert.equal(fx.storage.getLatestJob(102, 'radiant'), null); assert.equal(fx.posts('analysis').length, 1);
  const explicit = await resumed.requestMatch({ matchId: 101, side: 'radiant' }); assert.equal(explicit.status, 'queued');
});
