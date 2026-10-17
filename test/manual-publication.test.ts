import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDiscordPublisher } from '../src/discord-interface/index.js';
import { validateConfig } from '../src/operations/index.js';
import { StorageError, openStorage } from '../src/storage/index.js';
import { PublicationError } from '../src/match-pipeline/index.js';
import { geminiFixture, live, settings, geminiStreamResponse, geminiEvents, geminiAnswerV2 } from './gemini-runtime-helpers.js';
import { commands, interaction, http } from './discord-interface-helpers.js';
import { intercepted } from './match-pipeline-helpers.js';

const onCommand = { ...live, publicationMode: 'on-command' } as const;
const automaticJob = (fx: Awaited<ReturnType<typeof geminiFixture>>) => fx.storage.enqueueInitial({ matchId: 101, side: 'radiant', origin: 'automatic', settings, analysisProfile: 'gemini' });

test('ready auto analysis is idle and its scoped publication intent survives duplicate requests, checkpoint and reopen', async t => {
  const fx = await geminiFixture(t), api = http(), publisher = createDiscordPublisher({ botToken: 'synthetic-discord-key' }, { makeRequest: api.makeRequest });
  const pipe = fx.geminiPipe(onCommand, { publisher }), job = automaticJob(fx), ready = await fx.process(pipe);
  assert.equal(ready.reason, 'publication-ready'); assert.equal(ready.step, 'publish'); assert.equal(ready.state, 'waiting'); assert.equal(ready.nextRunAt, Number.MAX_SAFE_INTEGER);
  assert.equal(fx.posts('analysis').length, 1); assert.equal(api.posts().length, 0); assert.equal((await pipe.processNext()).status, 'idle');
  const bill = fx.storage.getBillingSummary(), intent = { jobId: job.id, guildId: settings.guildId, channelId: settings.channelId };
  for (const target of [{ ...intent, guildId: '123' }, { ...intent, channelId: '123' }]) {
    assert.throws(() => fx.storage.requestPublication(target), (error: unknown) => error instanceof StorageError && error.code === 'conflict');
  }
  assert.deepEqual(fx.storage.getJob(job.id), ready);
  const requested = fx.storage.requestPublication(intent); assert.equal(requested.reason, 'publication-requested');
  assert.equal(fx.storage.requestPublication(intent).version, requested.version);
  const claim = fx.storage.claimNext()!; assert.equal(claim.job.reason, 'publication-requested');
  const saved = fx.storage.checkpoint(claim.claim, { step: 'publish', resultAttemptId: ready.resultAttemptId! });
  assert.equal(saved.job.reason, 'publication-requested'); fx.storage.defer(saved.claim, { reason: 'publication-requested', nextRunAt: fx.clock.now() });
  await pipe.stop(); fx.reopen();
  const resumed = fx.geminiPipe(onCommand, { publisher }); assert.equal((await fx.process(resumed)).state, 'succeeded');
  await resumed.requestMatch({ matchId: 101 }); assert.equal((await resumed.processNext()).status, 'idle');
  assert.equal(api.posts().length, 1); assert.equal(fx.posts('analysis').length, 1); assert.deepEqual(fx.storage.getBillingSummary(), bill);
  const db = new DatabaseSync(fx.path, { readOnly: true }); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3); db.close();
});

test('status never grants publication; ready worst sends once and foreign scope stays private', async t => {
  const fx = await geminiFixture(t), pipe = fx.geminiPipe(onCommand), job = automaticJob(fx), ui = commands(fx, pipe);
  const queued = interaction({ name: 'worst-status', jobId: job.id }); await ui.handle(queued); assert.equal(fx.storage.getJob(job.id).publicationRequested, false);
  await fx.process(pipe); const before = fx.calls.length;
  const status = interaction({ name: 'worst-status', jobId: job.id }); await ui.handle(status);
  assert.match(status.content(), /готов и ждёт команды/); assert.match(status.content(), /Пост ещё не опубликован/);
  assert.doesNotMatch(status.content(), /отправка.*не подтверждена/); assert.equal(fx.storage.getJob(job.id).reason, 'publication-ready'); assert.equal(fx.calls.length, before);
  const otherSettings = { ...settings, channelId: '123' }, otherPipe = fx.geminiPipe(onCommand, { settings: otherSettings });
  const otherUi = commands(fx, otherPipe, { settings: otherSettings }), foreign = interaction({ channelId: '123' }); await otherUi.handle(foreign);
  assert.match(foreign.content(), /не найдена или недоступна/); assert.equal(fx.storage.getJob(job.id).reason, 'publication-ready'); await otherUi.ui.stop();
  const request = interaction(); await ui.handle(request); assert.match(request.content(), /Публикация в очереди/);
  assert.equal((await fx.process(pipe)).state, 'succeeded'); assert.equal(fx.sends(), 1);
  const again = interaction(); await ui.handle(again); assert.match(again.content(), /Открыть пост с разбором/);
  assert.equal((await pipe.processNext()).status, 'idle'); assert.equal(fx.posts('analysis').length, 1); assert.equal(fx.sends(), 1); await ui.ui.stop();
});

test('worst during inference preserves the active claim and publishes once after valid without a second command', async t => {
  const fx = await geminiFixture(t), pipe = fx.geminiPipe(onCommand), job = automaticJob(fx), ui = commands(fx, pipe);
  fx.controls.inference = async () => {
    const before = fx.storage.getJob(job.id); assert.equal(before.state, 'running'); assert.equal(before.step, 'analyze');
    const request = interaction(); await ui.handle(request); assert.match(request.content(), /сам скину.*Повторять команду не нужно/);
    const current = fx.storage.getJob(job.id); assert.equal(current.publicationRequested, true); assert.equal(current.version, before.version); assert.equal(current.leaseToken, before.leaseToken);
    assert.equal(fx.sends(), 0); assert.equal(fx.storage.listAttempts(job.id).some(row => row.kind === 'publication'), false);
    const bundle = fx.storage.getJobArtifacts(job.id, 'gemini').bundle!;
    return geminiStreamResponse(geminiEvents(bundle, { answer: geminiAnswerV2(bundle) }));
  };
  assert.equal((await fx.process(pipe)).state, 'succeeded'); assert.equal(fx.sends(), 1); assert.equal(fx.posts('analysis').length, 1);
  await ui.handle(interaction()); assert.equal((await pipe.processNext()).status, 'idle'); assert.equal(fx.sends(), 1); await ui.ui.stop();
});

test('queued intent is idempotent, scoped and survives checkpoint, ordinary defer and reopen', async t => {
  const fx = await geminiFixture(t), job = automaticJob(fx), intent = { jobId: job.id, guildId: settings.guildId, channelId: settings.channelId };
  for (const channelId of ['123', '456']) assert.throws(() => fx.storage.requestPublication({ ...intent, channelId }));
  assert.equal(fx.storage.getJob(job.id).publicationRequested, false);
  const queued = fx.storage.requestPublication(intent); assert.equal(queued.version, job.version); assert.equal(queued.publicationRequested, true);
  assert.equal(fx.storage.requestPublication(intent).version, job.version);
  const claim = fx.storage.claimNext()!, saved = fx.storage.checkpoint(claim.claim, { step: 'load-match' });
  const delayed = fx.storage.defer(saved.claim, { reason: 'opendota-rate-limited', nextRunAt: fx.clock.now() + 60000 }); assert.equal(delayed.publicationRequested, true);
  fx.reopen(); assert.equal(fx.storage.getJob(job.id).publicationRequested, true); await fx.clock.tick(60001);
  const pipe = fx.geminiPipe(onCommand); assert.equal((await fx.process(pipe)).state, 'succeeded'); assert.equal(fx.sends(), 1); assert.equal(fx.posts('analysis').length, 1);
});

test('concurrent intent between worker gate and ready defer cannot lose its wakeup', async t => {
  const fx = await geminiFixture(t), job = automaticJob(fx), other = openStorage({ path: fx.path, clock: { now: fx.clock.now } });
  try {
    let requested = false;
    const storage = intercepted(fx.storage, { defer: (claim: Parameters<typeof fx.storage.defer>[0], input: Parameters<typeof fx.storage.defer>[1]) => {
      if (input.reason === 'publication-ready') {
        requested = true; const before = fx.storage.getJob(job.id);
        const granted = other.requestPublication({ jobId: job.id, guildId: settings.guildId, channelId: settings.channelId }); assert.equal(granted.version, before.version);
      }
      return fx.storage.defer(claim, input);
    } });
    const pipe = fx.geminiPipe(onCommand, { storage }), waiting = await fx.process(pipe);
    assert.equal(requested, true); assert.equal(waiting.reason, 'publication-requested'); assert.ok(waiting.nextRunAt <= fx.clock.now());
    assert.equal((await fx.process(pipe)).state, 'succeeded'); assert.equal(fx.sends(), 1); assert.equal(fx.posts('analysis').length, 1);
  } finally { other.close(); }
});

test('on-command never retries an unknown Discord outcome or regenerates its saved result', async t => {
  const fx = await geminiFixture(t); let sends = 0;
  const pipe = fx.geminiPipe(onCommand, { publisher: { ...fx.publisher, send: async () => { sends++; throw new PublicationError('transport-error', 'unknown'); } } });
  const job = automaticJob(fx); await fx.process(pipe); await pipe.requestMatch({ matchId: 101 });
  assert.equal((await fx.process(pipe)).state, 'needs-attention');
  await pipe.requestMatch({ matchId: 101 }); assert.equal((await pipe.processNext()).status, 'idle');
  assert.equal(sends, 1); assert.equal(fx.posts('analysis').length, 1); assert.ok(fx.storage.getLatestResult(101, 'radiant'));
  assert.equal(fx.storage.getJob(job.id).reason, 'publication-transport-error');
});

test('default automatic publication and explicit manual analysis keep their previous behavior', async t => {
  for (const automatic of [true, false]) {
    const fx = await geminiFixture(t), pipe = fx.geminiPipe(automatic ? live : onCommand);
    if (automatic) automaticJob(fx); else await fx.request(pipe);
    assert.equal((await fx.process(pipe)).state, 'succeeded'); assert.equal(fx.sends(), 1); assert.equal(fx.posts('analysis').length, 1);
  }
});

test('publication mode validates before IO in pipeline and operations', async t => {
  const fx = await geminiFixture(t), raw = { version: 1, applicationId: '123456789012345678', groupSettingsPath: 'group.json', dataDir: 'data' };
  assert.equal(fx.pipe().config.publicationMode, 'automatic');
  assert.equal(validateConfig({ ...raw, pipeline: { publicationMode: 'on-command' } }, process.cwd()).pipeline.publicationMode, 'on-command');
  for (const value of ['unknown', false, null]) {
    assert.throws(() => fx.geminiPipe({ ...onCommand, publicationMode: value } as never));
    assert.throws(() => validateConfig({ ...raw, pipeline: { publicationMode: value } }, process.cwd()));
  }
  assert.equal(fx.calls.length, 0);
});
