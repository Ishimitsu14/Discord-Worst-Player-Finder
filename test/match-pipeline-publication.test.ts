import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicationError, type PublicationInput, type PipelineEvent } from '../src/match-pipeline/index.js';
import { StorageError, type AnalysisAttempt, type Storage } from '../src/storage/index.js';
import { fixture, live, drive, response, settings, intercepted, data, flush, pipelineError } from './match-pipeline-helpers.js';
import { deferred } from './opendota-helpers.js';

test('publisher sees accepted literal analysis, original target, exact persisted JSON and admission before send', async t => {
  const fx = await fixture(t), first = fx.pipe(live); const job = await fx.request(first); await fx.process(first);
  assert.equal(fx.storage.getLatestResult(101, 'radiant')!.attempt.analysis!.status, 'selected'); await first.stop(); await fx.clock.tick(300000);
  let sends = 0, prepares = 0; const message = '{ "content": "Точный тестовый текст", "allowed_mentions": {"parse": []} }';
  const pipeline = fx.pipe(live, { settings: { ...settings, channelId: '123' }, publisher: {
    prepare(input) { prepares++; assert.equal(input.job.id, job.id); assert.equal(input.analysis.status, 'valid'); assert.equal(input.bundle.context.allies.length, 5); assert.equal(input.snapshot.data.match_id, 101); return message; },
    async send(input) {
      sends++; const receipt = fx.storage.listAttempts(job.id).find(item => item.kind === 'publication')!;
      assert.equal(receipt.state, 'started'); assert.equal(receipt.unresolved, true); assert.deepEqual(input, receipt.input);
      assert.equal(input.guildId, settings.guildId); assert.equal(input.channelId, settings.channelId); assert.equal(input.message, message); return { messageId: '18446744073709551613' };
    },
  } });
  assert.equal((await fx.process(pipeline)).state, 'succeeded'); assert.equal(sends, 1); assert.equal(prepares, 1);
  const status = pipeline.getStatus({ jobId: job.id }); assert.equal(status.result!.publications[0].outcome && 'messageId' in status.result!.publications[0].outcome!, true);
  assert.equal((await pipeline.processNext()).status, 'idle'); assert.equal(sends, 1); assert.equal(fx.posts('analysis').length, 1);
});

test('insufficient-evidence and valid with unknown cost publish literally; later generation stays blocked', async t => {
  const fx = await fixture(t); let published = '';
  fx.hooks.analysis = (url, init) => url.endsWith('/endpoints') ? undefined : response(init.body, null, true);
  const pipeline = fx.pipe(live, { publisher: { prepare(input) { assert.deepEqual(input.analysis.analysis!.selectedPlayers, []); published = input.analysis.analysis!.status; return '{}'; }, send: fx.publisher.send } });
  const job = await fx.request(pipeline); assert.equal((await fx.process(pipeline)).state, 'succeeded'); assert.equal(published, 'insufficient-evidence');
  const before = fx.calls.length, status = pipeline.getStatus({ jobId: job.id }); assert.equal(status.attention, true); assert.equal(status.billingUnknown, true); assert.equal(fx.calls.length, before);
  fx.matches.set(102, data(102)); await fx.request(pipeline, 102); assert.equal((await fx.process(pipeline)).reason, 'budget-unknown'); assert.equal(fx.posts('analysis').length, 1);
});

test('invalid local publication payload waits before admission and does not hide accepted analysis', async t => {
  for (const message of ['[]', 'bad JSON', 'null']) {
    const fx = await fixture(t); let sends = 0;
    const pipeline = fx.pipe(live, { publisher: { prepare: () => message, send: async () => { sends++; return { messageId: '123' }; } } });
    const job = await fx.request(pipeline); const waiting = await fx.process(pipeline);
    assert.equal(waiting.reason, 'publication-invalid'); assert.equal(sends, 0); assert.equal(fx.storage.listAttempts(job.id).filter(item => item.kind === 'publication').length, 0);
    assert.ok(pipeline.getStatus({ jobId: job.id }).result);
  }
});

test('serialized publication envelope size is checked before durable admission', async t => {
  const fx = await fixture(t); let sends = 0;
  const message = JSON.stringify({ content: '"'.repeat(9 * 1024 * 1024) }); assert.ok(Buffer.byteLength(message) < 32 * 1024 * 1024);
  const pipeline = fx.pipe(live, { publisher: { prepare: () => message, send: async () => { sends++; return { messageId: '123' }; } } });
  const job = await fx.request(pipeline); assert.equal((await fx.process(pipeline)).reason, 'publication-invalid'); assert.equal(sends, 0);
  assert.equal(fx.storage.listAttempts(job.id).filter(item => item.kind === 'publication').length, 0);
});

test('publication known not-sent fails; untyped errors, unknown and invalid message IDs require attention without retry', async t => {
  for (const failure of ['not-sent', 'unknown', 'untyped', 'number', 'overflow'] as const) {
    const fx = await fixture(t); let sends = 0;
    const pipeline = fx.pipe(live, { publisher: { prepare: () => '{}', send: async () => {
      sends++; if (failure === 'untyped') throw new Error('token and raw remote payload');
      if (failure === 'not-sent' || failure === 'unknown') throw new PublicationError('forbidden', failure);
      return { messageId: failure === 'number' ? 123 : '18446744073709551616' } as never;
    } } });
    const job = await fx.request(pipeline), final = await fx.process(pipeline);
    assert.equal(final.state, failure === 'not-sent' ? 'failed' : 'needs-attention'); assert.ok(pipeline.getStatus({ jobId: job.id }).result);
    assert.doesNotMatch(JSON.stringify(fx.storage.listAttempts(job.id)), /token and raw remote payload/);
    await fx.clock.tick(400000); assert.equal((await pipeline.processNext()).status, 'idle'); assert.equal(sends, 1);
  }
});

test('publication timeout leaves pending receipt; late ID saves without old checkpoint and operator can resume known outcome', async t => {
  const fx = await fixture(t), pending = deferred<{ messageId: string }>(); let sends = 0;
  const pipeline = fx.pipe({ ...live, publicationTimeoutMs: 5000 }, { publisher: { prepare: () => '{}', send: () => { sends++; return pending.promise; } } });
  const job = await fx.request(pipeline), processing = pipeline.processNext(); await fx.clock.tick(3000);
  assert.equal(sends, 1); await fx.clock.tick(5000); const result = await drive(processing, fx.clock); assert.equal(result.status, 'processed');
  const receipt = fx.storage.listAttempts(job.id).find(item => item.kind === 'publication')!;
  assert.equal(receipt.state, 'started'); assert.equal(receipt.outcome, null); assert.equal(fx.storage.getJob(job.id).state, 'needs-attention');
  const version = fx.storage.getJob(job.id).version; pending.resolve({ messageId: '12345' }); await flush();
  assert.deepEqual(fx.storage.listAttempts(job.id).find(item => item.kind === 'publication')!.outcome, { messageId: '12345' });
  assert.equal(fx.storage.getJob(job.id).version, version); assert.equal(fx.storage.getJob(job.id).state, 'needs-attention');
  fx.storage.resolveUncertain({ resolutionId: 'accept-late', jobId: job.id, expectedVersion: version, attemptId: receipt.id, decision: 'accept-outcome', state: 'waiting', reason: 'checked', evidenceRef: 'message-12345' });
  assert.equal((await fx.process(pipeline)).state, 'succeeded'); assert.equal(sends, 1); assert.equal(fx.posts('analysis').length, 1); assert.equal(fx.clock.timers.size, 0);
});

test('stop aborts pending publication, returns while adapter promise is alive and still stores late outcome', async t => {
  const fx = await fixture(t), pending = deferred<{ messageId: string }>(); let adapterSignal: AbortSignal | undefined;
  const pipeline = fx.pipe(live, { publisher: { prepare: () => '{}', send: (_input, options) => { adapterSignal = options.signal; return pending.promise; } } });
  const job = await fx.request(pipeline); const processing = pipeline.processNext(); await fx.clock.tick(3000); await pipeline.stop(); await processing;
  assert.equal(adapterSignal!.aborted, true); assert.equal(fx.storage.getJob(job.id).state, 'needs-attention');
  pending.resolve({ messageId: '98765' }); await flush(); assert.deepEqual(fx.storage.listAttempts(job.id).find(item => item.kind === 'publication')!.outcome, { messageId: '98765' });
  assert.ok(pipeline.getStatus({ jobId: job.id }).result); await assert.rejects(pipeline.processNext(), pipelineError('stopped'));
  assert.equal(fx.clock.timers.size, 0);
});

test('valid final survives lease expiry before checkpoint and resumes without generation or a fresh GET', async t => {
  const fx = await fixture(t); let expire = true;
  const storage = intercepted(fx.storage, { saveAnalysisOutcome: ((...args: Parameters<Storage['saveAnalysisOutcome']>) => {
    if (expire) { fx.clock.time += 60001; expire = false; } return fx.storage.saveAnalysisOutcome(...args);
  }) as never });
  const pipeline = fx.pipe(live, { storage }), job = await fx.request(pipeline); await fx.process(pipeline);
  assert.equal(fx.storage.getJob(job.id).resultAttemptId, null); assert.equal((fx.storage.listAttempts(job.id)[0].outcome as AnalysisAttempt).status, 'valid');
  await pipeline.stop(); fx.reopen(); const next = fx.pipe(live, { publisher: fx.publisher }); const getCount = fx.calls.filter(call => call.url.includes('/matches/')).length;
  assert.equal((await fx.process(next)).state, 'succeeded'); assert.equal(fx.posts('analysis').length, 1); assert.equal(fx.calls.filter(call => call.url.includes('/matches/')).length, getCount);
});

test('safe observer throws/rejections do not affect writes, diagnostics contain only documented IDs and aggregates', async t => {
  const fx = await fixture(t), events: PipelineEvent[] = [];
  const pipeline = fx.pipe({ ...live, automaticSince: 0 }, { publisher: fx.publisher, onEvent: event => { events.push(event); if (events.length % 2) throw new Error('private diagnostic'); return Promise.reject(new Error('private async diagnostic')); } });
  const scan = await drive(pipeline.discoverOnce(), fx.clock); assert.equal(scan.queued.length, 1); const job = await fx.process(pipeline); assert.equal(job.state, 'succeeded');
  await flush(); assert.doesNotMatch(JSON.stringify(events), /sk-synthetic|content|Authorization|private|steamAccountIds|requestDigest|personaname/);
  assert.ok(events.some(event => event.type === 'discovery')); assert.ok(events.every(Object.isFrozen));
  const calls = fx.calls.length; pipeline.getStatus({ jobId: job.id }); pipeline.getStatus({ jobId: job.id }); assert.equal(fx.calls.length, calls);
});

test('run manual-only needs no activation, concurrent run returns already-running, idle/pause do not spin and stop preserves caller resources', async t => {
  const fx = await fixture(t), pipeline = fx.pipe();
  await assert.rejects(pipeline.run(), pipelineError('automatic-since-required'));
  const running = pipeline.run({ automatic: false }); await flush(); assert.equal((await pipeline.run({ automatic: false })).status, 'already-running');
  assert.equal(fx.calls.length, 0); assert.ok(fx.clock.timers.size > 0);
  const job = await fx.request(pipeline); await fx.clock.tick(5000); assert.equal(fx.storage.getJob(job.id).reason, 'live-disabled');
  const calls = fx.calls.length; await fx.clock.tick(20000); assert.equal(fx.calls.length, calls);
  await pipeline.stop(); assert.deepEqual(await running, { status: 'stopped' }); await pipeline.stop();
  assert.equal(fx.clock.timers.size, 0); assert.ok(pipeline.getStatus({ jobId: job.id })); assert.equal(fx.storage.getJob(job.id).state, 'waiting');
  await assert.rejects(pipeline.run({ automatic: false }), pipelineError('stopped'));
  assert.equal((await drive(fx.opendota.getMatch(101, { fresh: true }), fx.clock)).data.match_id, 101);
});

test('automatic run has one discovery and one worker loop, recovers recently expired tasks and stops on storage failure', async t => {
  const fx = await fixture(t); let scans = 0;
  fx.hooks.opendota = url => { if (url.pathname.includes('/players/100000/')) scans++; return undefined; };
  const pipeline = fx.pipe({ automaticSince: 0, pollIntervalMs: 60000 }); const running = pipeline.run();
  await fx.clock.tick(10000); assert.equal(scans, 1); const calls = fx.calls.length; await fx.clock.tick(20000); assert.equal(fx.calls.length, calls);
  await fx.clock.tick(60000); assert.equal(scans, 2); await pipeline.stop(); await running;
  const next = await fixture(t), job = next.storage.enqueueInitial({ matchId: 101, side: 'radiant', origin: 'manual', settings }); next.storage.claimNext();
  const manual = next.pipe(); const work = manual.run({ automatic: false }); await next.clock.tick(62000); assert.equal(next.storage.getJob(job.id).reason, 'live-disabled'); await manual.stop(); await work;
  const third = await fixture(t); let claims = 0;
  const faulty = third.pipe({}, { storage: intercepted(third.storage, { claimNext: (() => { claims++; throw new StorageError('io-error', 'claimNext'); }) as never }) });
  await assert.rejects(faulty.run({ automatic: false }), pipelineError('storage-failure')); assert.equal(claims, 1); assert.equal(third.clock.timers.size, 0);
});

test('stop before analysis admission saves not-sent, keeps queue and prevents new actions', async t => {
  const fx = await fixture(t), metadata = deferred<Response>(), pipeline = fx.pipe(live);
  const job = await fx.request(pipeline); fx.hooks.analysis = url => url.endsWith('/endpoints') ? metadata.promise : undefined;
  const processing = pipeline.processNext(); await fx.clock.tick(3000); await pipeline.stop(); await processing;
  const receipt = fx.storage.listAttempts(job.id)[0]; assert.equal((receipt.outcome as AnalysisAttempt).requestSent, false); assert.equal(receipt.state, 'finished');
  assert.equal(fx.storage.getJob(job.id).state, 'waiting'); assert.equal(fx.posts('analysis').length, 0); assert.equal(fx.clock.timers.size, 0);
  metadata.resolve(Response.json({})); await flush(); await assert.rejects(pipeline.requestMatch({ matchId: 101 }), pipelineError('stopped'));
});
