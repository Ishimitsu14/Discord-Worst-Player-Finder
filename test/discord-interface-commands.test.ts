import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Events, MessageFlags, PermissionFlagsBits, type Interaction } from 'discord.js';
import { createDiscordInterface, DiscordInterfaceError, type DiscordInterfaceDependencies, type DiscordEvent } from '../src/discord-interface/index.js';
import { StorageError } from '../src/storage/index.js';
import { fixture, accepted, commands, interaction, settings, drive, flush, live, data, response, intercepted } from './discord-interface-helpers.js';
import { deferred } from './opendota-helpers.js';

test('awaiting-data is private with no invented job or ETA; scope checks precede the journal', async t => {
  const fx = await fixture(t), real = fx.pipe(); let requests = 0;
  for (const nextCheckAt of [fx.clock.now() + 60000, null]) {
    const pipeline = { ...real, requestMatch: async () => { requests++; return { status: 'awaiting-data', matchId: 101, code: 'opendota-pending', nextCheckAt } as const; },
      requestReanalysis: real.requestReanalysis.bind(real), getStatus: real.getStatus.bind(real) } as typeof real;
    const { handle, ui } = commands(fx, pipeline), command = interaction(); await handle(command);
    assert.equal(command.responses[0].body.flags, MessageFlags.Ephemeral); assert.match(command.content(), /Матч найден/);
    assert.match(command.content(), nextCheckAt === null ? /остановлено/ : /Ожидаем данные OpenDota/);
    assert.doesNotMatch(command.content(), /Задача|job|<t:|ETA|через \d/); assert.equal(fx.calls.length, 0);
    const before = requests; await handle(interaction({ guildId: '123' })); await handle(interaction({ channelId: '123' })); assert.equal(requests, before); await ui.stop();
  }
});

test('saved valid report has priority over a pending discovery candidate without another API call', async t => {
  const fx = await accepted(t); fx.matches.delete(101);
  const pipeline = fx.pipe({ historySource: 'steam', automaticSince: fx.clock.now() - 600000 }, { steam: { getMatchHistory: async () => ({ matches: [{ matchId: 101, startTime: 1799998000 }], nextStartAtMatchId: null }) } });
  const report = await drive(pipeline.discoverOnce(), fx.clock); assert.equal(report.pending, 1);
  const before = fx.calls.length, { ui, handle } = commands(fx, pipeline), command = interaction(); await handle(command);
  assert.match(command.content(), /Сохранённый результат/); assert.doesNotMatch(command.content(), /Ожидаем данные/); assert.equal(fx.calls.length, before);
  assert.equal(fx.posts('analysis').length, 1); assert.equal(command.responses[0].body.flags, MessageFlags.Ephemeral); await ui.stop();
});

test('interface config is inert, rejects unknown fields/getters and copies group settings', async t => {
  const fx = await fixture(t), deps: DiscordInterfaceDependencies = { client: { on() {}, off() {} } as never, pipeline: fx.pipe(), storage: fx.storage, clock: fx.clock };
  for (const options of [null, {}, { settings, extra: true }, { settings, requestTimeoutMs: 0 }, { settings, requestTimeoutMs: 60001 }, { settings: { ...settings, channelId: '01' } }]) {
    assert.throws(() => createDiscordInterface(options as never, deps), (error: unknown) => error instanceof DiscordInterfaceError && error.code === 'invalid-config');
  }
  for (const bad of [{ client: {} }, { pipeline: {} }, { storage: {} }, { clock: {} }, { onEvent: 1 }, { get client() { throw new Error('secret token'); } }]) {
    const invalid = Object.defineProperties({ ...deps }, Object.getOwnPropertyDescriptors(bad));
    assert.throws(() => createDiscordInterface({ settings }, invalid as never), /Discord interface: invalid-config/);
  }
  const mutable = structuredClone(settings), ui = createDiscordInterface({ settings: mutable }, deps); assert.equal(fx.calls.length, 0); assert.equal(fx.clock.timers.size, 0);
  mutable.channelId = '123'; mutable.steamAccountIds.push(7);
  const command = interaction(); await drive(ui.handleInteraction(command.command as Interaction), fx.clock); assert.match(command.content(), /Задача принята/);
  await ui.stop();
  for (const file of ['index', 'types', 'values', 'render', 'rest', 'commands', 'interface']) {
    const source = await readFile(`src/discord-interface/${file}.ts`, 'utf8'); assert.doesNotMatch(source, /process\.env|node:fs|console\./);
  }
});

test('guild/channel/thread and Administrator are checked before queue, while normal users may enqueue', async t => {
  const fx = await fixture(t), { ui, handle } = commands(fx);
  for (const options of [{ guildId: null }, { guildId: '123' }, { channelId: '123' }, { thread: true }, { name: 'worst-reanalyze', side: 'radiant' }, { name: 'worst-reanalyze', side: 'radiant', permissions: PermissionFlagsBits.ManageGuild }]) {
    const command = interaction(options); await handle(command); assert.equal(command.responses.length, 1); assert.equal(command.responses[0].body.flags, MessageFlags.Ephemeral); assert.match(command.content(), /только/);
  }
  assert.equal(fx.calls.length, 0); const normal = interaction({ side: 'radiant' }); await handle(normal); assert.match(normal.content(), /Задача принята/); assert.equal(fx.posts('analysis').length, 0); assert.equal(fx.storage.getLatestJob(101, 'radiant')!.state, 'queued'); await ui.stop();
});

test('invalid input is private and never reaches OpenDota; uint64 IDs are unchanged', async t => {
  const fx = await fixture(t), { handle, ui } = commands(fx);
  for (const matchId of ['0', '-1', '1.5', '1e3', '01', '101 ', ' 101', 'https://www.opendota.com/matches/101', '9007199254740992']) {
    const command = interaction({ matchId }); await handle(command); assert.match(command.content(), /Укажи ID/); assert.equal(command.responses[0].method, 'reply');
  }
  const badSide = interaction({ side: 'other' }); await handle(badSide); assert.match(badSide.content(), /Укажи ID/);
  const status = interaction({ name: 'worst-status', jobId: '../secret' }); await handle(status); assert.match(status.content(), /Укажи ID/);
  for (const missing of [interaction({ name: 'worst-status' }), interaction({ name: 'worst-reanalyze', permissions: PermissionFlagsBits.Administrator }), interaction()]) {
    if (missing.command.commandName === 'worst') Object.defineProperty(missing.command, 'options', { value: { getString: () => null } });
    await handle(missing); assert.match(missing.content(), /Укажи ID/);
  }
  assert.equal(fx.calls.length, 0); const good = interaction({ side: 'radiant', id: '18446744073709551615' }); await handle(good); assert.match(good.content(), /Задача принята/); assert.equal(fx.storage.getLatestJob(101, 'radiant')!.settings.guildId, settings.guildId); await ui.stop();
});

test('ACK precedes slow OpenDota, duplicates do not enqueue twice, failed ACK never starts business work', async t => {
  const fx = await fixture(t), { ui, handle } = commands(fx), gate = deferred<Response>();
  const command = interaction({ side: 'radiant' }); fx.hooks.opendota = () => { assert.equal(command.responses[0].method, 'defer'); return gate.promise; };
  const handling = ui.handleInteraction(command.command as Interaction); await flush(); assert.equal(command.responses.length, 1);
  assert.deepEqual(await ui.handleInteraction(command.command as Interaction), { status: 'handled' }); gate.resolve(Response.json(data())); await drive(handling, fx.clock);
  assert.deepEqual(command.responses.map(row => row.method), ['defer', 'edit']); assert.equal(fx.calls.length, 1);
  const before = fx.calls.length, failure = interaction(); failure.hooks.defer = async () => { throw new Error('private interaction token'); }; await handle(failure); assert.equal(fx.calls.length, before); assert.equal(failure.responses.length, 1);
  const existing = interaction({ side: 'radiant' }); await handle(existing); assert.match(existing.content(), /Найдена сохранённая/); assert.equal(fx.calls.length, before);
  await ui.stop();
});

test('requires-side and rejected match leave no task; failed edit after commit never retries or rolls back', async t => {
  const fx = await fixture(t), { ui, handle } = commands(fx);
  fx.matches.get(101)!.players.forEach(row => { delete row.account_id; }); const ambiguous = interaction(); await handle(ambiguous); assert.match(ambiguous.content(), /side:radiant.*side:dire/); assert.equal(fx.storage.getLatestJob(101, 'radiant'), null);
  fx.matches.get(101)!.game_mode = 23; const rejected = interaction({ side: 'radiant' }); await handle(rejected); assert.match(rejected.content(), /Матч не подходит/);
  fx.matches.get(101)!.game_mode = 22; const faulty = interaction({ side: 'radiant' }); faulty.hooks.edit = async () => { throw new Error('private webhook'); }; await handle(faulty);
  assert.equal(fx.storage.getLatestJob(101, 'radiant')!.revision, 1); assert.equal(faulty.responses.filter(row => row.method === 'edit').length, 1); assert.equal(fx.posts('analysis').length, 0); await ui.stop();
});

test('admin revision uses persistent interaction ID, survives reopen and unfinished conflicts never cancel jobs', async t => {
  const fx = await accepted(t);
  const initial = fx.storage.getLatestJob(101, 'radiant')!; fx.clock.time = initial.nextRunAt;
  const claim = fx.storage.claimNext()!.claim; fx.storage.finish(claim, { state: 'failed', reason: 'test-finish-with-saved-result' });
  const first = commands(fx, fx.pipeline), original = interaction({ name: 'worst-reanalyze', matchId: '101', side: 'radiant', permissions: PermissionFlagsBits.Administrator });
  await first.handle(original); const revision = fx.storage.getLatestJob(101, 'radiant')!; assert.equal(revision.revision, 2);
  const duplicate = interaction({ name: 'worst-reanalyze', side: 'radiant', permissions: PermissionFlagsBits.Administrator, id: original.command.id }); await first.handle(duplicate); assert.equal(fx.storage.getLatestJob(101, 'radiant')!.id, revision.id);
  const conflict = interaction({ name: 'worst-reanalyze', side: 'radiant', permissions: PermissionFlagsBits.Administrator }); await first.handle(conflict); assert.match(conflict.content(), /конфликтует/);
  await first.ui.stop(); await fx.pipeline.stop(); fx.reopen(); const next = commands(fx);
  await next.handle(interaction({ name: 'worst-reanalyze', side: 'radiant', permissions: PermissionFlagsBits.Administrator, id: original.command.id })); assert.equal(fx.storage.getLatestJob(101, 'radiant')!.id, revision.id); await next.ui.stop();
});

test('status reads current failure plus prior result without API calls and same response for inaccessible/unknown ID', async t => {
  const fx = await accepted(t), first = fx.storage.getLatestJob(101, 'radiant')!; fx.clock.time = first.nextRunAt;
  let claim = fx.storage.claimNext()!.claim; fx.storage.finish(claim, { state: 'failed', reason: 'finish' });
  const current = fx.storage.createRevision({ requestId: 'second', matchId: 101, side: 'radiant', settings }); claim = fx.storage.claimNext()!.claim; fx.storage.finish(claim, { state: 'failed', reason: 'raw private token' });
  const { handle, ui } = commands(fx, fx.pipeline); const before = fx.calls.length, command = interaction({ name: 'worst-status', jobId: current.id }); await handle(command);
  assert.match(command.content(), /версия 2: ошибка/); assert.match(command.content(), /Сохранённый результат: версия 1/); assert.doesNotMatch(command.content(), /raw private token/); assert.equal(fx.calls.length, before); assert.equal((command.responses.at(-1)!.body.embeds as unknown[]).length, 1);
  const hidden = fx.storage.enqueueInitial({ matchId: 102, side: 'radiant', origin: 'manual', settings: { ...settings, channelId: '123' } });
  const hiddenStatus = interaction({ name: 'worst-status', jobId: hidden.id }), unknown = interaction({ name: 'worst-status', jobId: 'missing-job' }); await handle(hiddenStatus); await handle(unknown);
  assert.equal(hiddenStatus.content(), unknown.content()); assert.doesNotMatch(hiddenStatus.content(), new RegExp(hidden.id)); await ui.stop();
});

test('existing job from old target and previous result of another channel stay private', async t => {
  const fx = await accepted(t), target = { ...settings, channelId: '123' }; let observed = '';
  const pipeline = fx.pipe(live, { settings: target }), module = commands(fx, pipeline, { settings: target }, { onEvent: event => { observed += JSON.stringify(event); } });
  const existing = interaction({ channelId: '123', side: 'radiant' }); await module.handle(existing); assert.match(existing.content(), /не найдена или недоступна/); assert.doesNotMatch(observed, new RegExp(fx.job.id));
  fx.clock.time = fx.storage.getJob(fx.job.id).nextRunAt; const claim = fx.storage.claimNext()!.claim; fx.storage.finish(claim, { state: 'failed', reason: 'finish' });
  const current = fx.storage.createRevision({ requestId: 'new-target', matchId: 101, side: 'radiant', settings: target });
  const status = interaction({ name: 'worst-status', channelId: '123', jobId: current.id }); await module.handle(status); assert.doesNotMatch(status.content(), /Сохранённый результат/); assert.equal((status.responses.at(-1)!.body.embeds as unknown[]).length, 0); await module.ui.stop();
});

test('unknown billing and publication needs-attention are visible without generation or repost', async t => {
  const fx = await fixture(t); fx.hooks.analysis = (url, init) => url.endsWith('/endpoints') ? undefined : response(init.body, null);
  const pipeline = fx.pipe(live), job = await fx.request(pipeline); await fx.process(pipeline);
  const module = commands(fx, pipeline), before = fx.calls.length, command = interaction({ name: 'worst-status', jobId: job.id }); await module.handle(command);
  assert.match(command.content(), /Стоимость запроса неизвестна/); assert.match(command.content(), /Требуется внимание/); assert.equal(fx.calls.length, before); await module.ui.stop();
});

test('request timeout, stopped ACK and stopped business request never create new queue work', async t => {
  const fx = await fixture(t), module = commands(fx, undefined, { requestTimeoutMs: 1000 }), pending = deferred<Response>();
  fx.hooks.opendota = () => pending.promise; const command = interaction(), handling = module.ui.handleInteraction(command.command as Interaction); await fx.clock.tick(2000); await handling;
  assert.match(command.content(), /Время ответа истекло/); assert.equal(fx.storage.getLatestJob(101, 'radiant'), null);
  pending.resolve(Response.json(data())); await flush(); assert.equal(fx.storage.getLatestJob(101, 'radiant'), null); await module.ui.stop();
  const second = commands(fx), ack = deferred<unknown>(), stopped = interaction(); stopped.hooks.defer = () => ack.promise;
  const acknowledging = second.ui.handleInteraction(stopped.command as Interaction); await flush(); await second.ui.stop(); await acknowledging; ack.resolve(undefined); await flush();
  assert.equal(fx.storage.getLatestJob(101, 'radiant'), null); assert.equal(fx.clock.timers.size, 0);
});

test('one listener ignores other commands, isolates observer errors and preserves caller resources on stop', async t => {
  const fx = await fixture(t); const events: DiscordEvent[] = [];
  const module = commands(fx, undefined, {}, { onEvent: event => { events.push(event); if (events.length % 2) throw new Error('private observer'); return Promise.reject(new Error('private observer')); } });
  module.ui.attach(); module.ui.attach(); assert.equal(module.client.listenerCount(Events.InteractionCreate), 1);
  const foreign = interaction({ name: 'another-command' }); assert.equal((await module.ui.handleInteraction(foreign.command as Interaction)).status, 'ignored'); assert.equal(foreign.responses.length, 0);
  const command = interaction({ side: 'radiant' }); module.client.emit(Events.InteractionCreate, command.command); await fx.clock.tick(3000); assert.match(command.content(), /Задача принята/);
  const bad = interaction({ matchId: 'bad' }); await module.handle(bad); await flush(); assert.doesNotMatch(JSON.stringify(events), /private|personaname|token|steamAccountIds/); assert.ok(events.every(Object.isFrozen));
  await module.ui.stop(); await module.ui.stop(); assert.equal(module.client.listenerCount(Events.InteractionCreate), 0);
  assert.ok(fx.storage.getLatestJob(101, 'radiant')); assert.equal(fx.clock.timers.size, 0);
  await assert.rejects(module.ui.handleInteraction(interaction().command as Interaction), (error: unknown) => error instanceof DiscordInterfaceError && error.code === 'stopped');
  assert.throws(() => module.ui.attach(), /stopped/); assert.equal((await module.pipeline.processNext()).status, 'processed');
});

test('storage failure disables listener, reports safe failure and preserves saved jobs', async t => {
  const fx = await accepted(t), pipeline = { ...fx.pipeline, requestMatch: fx.pipeline.requestMatch.bind(fx.pipeline), requestReanalysis: fx.pipeline.requestReanalysis.bind(fx.pipeline), getStatus: () => { throw new StorageError('io-error', 'read'); } };
  const module = commands(fx, fx.pipeline, {}, { pipeline }); module.ui.attach();
  const command = interaction({ name: 'worst-status', jobId: fx.job.id }); await module.handle(command); assert.match(command.content(), /Не удалось подтвердить/); assert.equal(module.client.listenerCount(Events.InteractionCreate), 0);
  assert.ok(fx.storage.getLatestResult(101, 'radiant')); await assert.rejects(module.ui.handleInteraction(interaction().command as Interaction), /stopped/); await module.ui.stop();
});
