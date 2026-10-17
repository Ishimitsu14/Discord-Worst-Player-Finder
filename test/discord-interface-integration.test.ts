import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatInputCommandInteraction, Client, GatewayIntentBits, InteractionType, ApplicationCommandType, ApplicationCommandOptionType, MessageFlags } from 'discord.js';
import { assembleDiscordExample } from './discord-interface-example.js';
import { fixture, settings, http, live, drive, token, response, flush, intercepted, publisher, interaction, commands } from './discord-interface-helpers.js';
import { StorageError, type Storage } from '../src/storage/index.js';
import { deferred } from './opendota-helpers.js';

function sdkCommand(client: Client, name: string, values: Record<string, string>) {
  const FixtureInteraction = ChatInputCommandInteraction as unknown as new (client: Client, data: unknown) => ChatInputCommandInteraction;
  return new FixtureInteraction(client, {
    id: String(1800000000000000000n + BigInt(name.length)), application_id: '18446744073709551612', token: 'synthetic-interaction-token', version: 1,
    type: InteractionType.ApplicationCommand, guild_id: settings.guildId, channel: { id: settings.channelId, type: 0 }, app_permissions: '19456',
    member: { user: { id: '1800000000000000001', username: 'Synthetic user', discriminator: '0', avatar: null }, permissions: '0', roles: [] },
    locale: 'ru', guild_locale: 'ru', entitlements: [], authorizing_integration_owners: {}, context: 0,
    data: { id: '1800000000000000002', name, type: ApplicationCommandType.ChatInput,
      options: Object.entries(values).map(([name, value]) => ({ name, value, type: ApplicationCommandOptionType.String })) },
  });
}
function replyMessage(body: unknown) {
  return { id: '1800000000000000031', channel_id: settings.channelId, type: 0,
    author: { id: '1800000000000000032', username: 'Synthetic bot', discriminator: '0', avatar: null, bot: true },
    content: '', attachments: [], embeds: [], components: [], timestamp: '2026-10-17T00:00:00.000Z', flags: MessageFlags.Ephemeral,
    ...(typeof body === 'string' ? JSON.parse(body) : {}) };
}

for (const scenario of ['manual', 'automatic', 'insufficient-evidence'] as const) {
  test(`Discord full ${scenario}: real SDK interaction/REST, public modules, SQLite and one saved embed`, async t => {
    const fx = await fixture(t), api = http(call => {
      if (call.url.pathname.includes('/interactions/')) return new Response(null, { status: 204 });
      if (call.url.pathname.includes('/webhooks/')) return Response.json(replyMessage(call.init.body));
      if (call.url.pathname.endsWith('/messages') && call.init.method === 'POST') {
        const job = fx.storage.getLatestJob(101, 'radiant')!, receipt = fx.storage.listAttempts(job.id).find(row => row.kind === 'publication')!;
        assert.equal(receipt.state, 'started'); assert.equal(receipt.unresolved, true); assert.equal((receipt.input as { message: string }).message, call.init.body);
      }
    });
    if (scenario === 'insufficient-evidence') fx.hooks.analysis = (url, init) => url.endsWith('/endpoints') ? undefined : response(init.body, 0.001, true);
    const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { makeRequest: api.makeRequest, retries: 0, rejectOnRateLimit: () => true, hashSweepInterval: 0, handlerSweepInterval: 0 } });
    const assembled = assembleDiscordExample({ ...live, automaticSince: 0 }, { settings, storage: fx.storage, opendota: fx.opendota, facts: { dictionary: (await import('./helpers.js')).dictionary }, prompt: (await import('./match-analysis-helpers.js')).prompt,
      apiKey: 'synthetic-sdk-mimo-key', fetcher: fx.fetcher, clock: fx.clock }, client, token, { makeRequest: api.makeRequest });
    t.after(async () => { await assembled.discord.stop(); await assembled.pipeline.stop(); await client.destroy(); });
    assert.equal(api.calls.length, 0); assembled.discord.attach();
    if (scenario === 'automatic') assert.equal((await drive(assembled.pipeline.discoverOnce(), fx.clock)).queued.length, 1);
    else {
      const command = sdkCommand(client, 'worst', { match_id: '101', side: 'radiant' }); await drive(assembled.discord.handleInteraction(command), fx.clock);
      assert.equal(command.deferred, true); assert.equal(command.ephemeral, true);
      const ack = api.calls.find(call => call.url.pathname.endsWith('/callback'))!; assert.equal(JSON.parse(String(ack.init.body)).data.flags, MessageFlags.Ephemeral);
      assert.equal(fx.posts('analysis').length, 0);
    }
    const result = await drive(assembled.pipeline.processNext(), fx.clock); assert.equal(result.status, 'processed');
    const job = fx.storage.getLatestJob(101, 'radiant')!; assert.equal(job.state, 'succeeded');
    const publicPosts = api.calls.filter(call => call.url.pathname.endsWith('/messages') && call.init.method === 'POST'); assert.equal(publicPosts.length, 1); assert.equal(fx.posts('analysis').length, 1);
    const message = JSON.parse(String(publicPosts[0].init.body)); assert.equal(message.embeds.length, 1); assert.deepEqual(message.allowed_mentions.parse, []);
    assert.match(message.embeds[0].title, scenario === 'insufficient-evidence' ? /Недостаточно данных/ : /Разбор/);
    const before = fx.calls.length, privateStatus = sdkCommand(client, 'worst-status', { job_id: job.id });
    await drive(assembled.discord.handleInteraction(privateStatus), fx.clock); assert.equal(fx.calls.length, before);
    const edit = api.calls.filter(call => call.init.method === 'PATCH').at(-1)!; const body = JSON.parse(String(edit.init.body)); assert.match(body.content, /Сохранённый результат: версия 1/); assert.match(body.content, /https:\/\/discord.com\/channels/); assert.equal(body.embeds.length, 1);
    assert.deepEqual(body.allowed_mentions.parse, []); assert.equal(api.calls.filter(call => call.url.pathname.endsWith('/messages') && call.init.method === 'POST').length, 1);
    assert.equal(fx.storage.listAttempts(job.id).filter(row => row.kind === 'publication').length, 1);
    await assembled.discord.stop(); await assembled.pipeline.stop(); assert.equal(fx.clock.timers.size, 0);
  });
}

test('confirmed Discord refusal keeps accepted analysis readable without retry after reopen', async t => {
  const fx = await fixture(t), api = http(call => call.init.method === 'POST' ? Response.json({ code: 50013, message: 'synthetic private error' }, { status: 403 }) : undefined);
  const pipeline = fx.pipe(live, { publisher: publisher(api.makeRequest) }), job = await fx.request(pipeline);
  await fx.process(pipeline);
  assert.equal(fx.storage.getJob(job.id).state, 'failed'); assert.ok(fx.storage.getLatestResult(101, 'radiant'));
  assert.deepEqual(fx.storage.listAttempts(job.id).find(row => row.kind === 'publication')!.outcome, { state: 'not-sent', code: 'forbidden' });
  await pipeline.stop(); fx.reopen(); const next = fx.pipe(live, { publisher: publisher(api.makeRequest) });
  assert.equal((await next.processNext()).status, 'idle');
  const module = commands(fx, next), status = interaction({ name: 'worst-status', jobId: job.id }); await module.handle(status);
  assert.match(status.content(), /права бота/); assert.match(status.content(), /Сохранённый результат/); assert.doesNotMatch(status.content(), /synthetic private error/);
  assert.equal(api.posts().length, 1); assert.equal(fx.posts('analysis').length, 1); await module.ui.stop();
});

for (const phase of ['message-saved', 'message-sent', 'id-saved'] as const) {
  test(`Discord fault ${phase}: reopen never repeats an uncertain or known message`, async t => {
    const fx = await fixture(t), api = http(call => {
      if (phase === 'message-sent' && call.init.method === 'POST') throw new Error('synthetic lost reply after effect');
      return undefined;
    });
    const storage = intercepted(fx.storage, {
      beginPublication: ((...args: Parameters<Storage['beginPublication']>) => { const receipt = fx.storage.beginPublication(...args); if (phase === 'message-saved') throw new StorageError('io-error', 'after-save'); return receipt; }) as never,
      finish: ((...args: Parameters<Storage['finish']>) => { if (phase === 'id-saved' && args[1].state === 'succeeded') throw new StorageError('io-error', 'finish'); return fx.storage.finish(...args); }) as never,
    });
    const pipeline = fx.pipe(live, { storage, publisher: publisher(api.makeRequest) }), job = await fx.request(pipeline);
    const processing = drive(pipeline.processNext(), fx.clock);
    if (phase === 'message-sent') await processing;
    else await assert.rejects(processing, (error: unknown) => (error as { code: string }).code === 'storage-failure');
    const receipt = fx.storage.listAttempts(job.id).find(row => row.kind === 'publication')!; assert.ok(receipt.input && 'message' in receipt.input);
    const oldPosts = api.posts().length, oldAnalysisPosts = fx.posts('analysis').length; await pipeline.stop(); await fx.clock.tick(60001); fx.reopen();
    const next = fx.pipe(live, { publisher: publisher(api.makeRequest) }); const result = await next.processNext();
    if (phase === 'id-saved') { assert.equal(result.status, 'processed'); assert.equal(fx.storage.getJob(job.id).state, 'succeeded'); }
    else { assert.equal(result.status, 'idle'); assert.equal(fx.storage.getJob(job.id).state, 'needs-attention'); }
    assert.equal(api.posts().length, oldPosts); assert.equal(fx.posts('analysis').length, oldAnalysisPosts); assert.equal(oldPosts, phase === 'message-saved' ? 0 : 1);
    const module = commands(fx, next), command = interaction({ name: 'worst-status', jobId: job.id }); await module.handle(command); assert.match(command.content(), /Сохранённый результат/); await module.ui.stop();
  });
}

test('live REST promise after pipeline timeout stores late ID without advancing stale job or reposting', async t => {
  const fx = await fixture(t), gate = deferred<Response>(), api = http(call => call.init.method === 'POST' ? gate.promise : undefined);
  const pipeline = fx.pipe({ ...live, publicationTimeoutMs: 5000 }, { publisher: publisher(api.makeRequest) }), job = await fx.request(pipeline);
  const processing = pipeline.processNext(); await fx.clock.tick(3000); assert.equal(api.posts().length, 1); await fx.clock.tick(5000); await drive(processing, fx.clock);
  const receipt = fx.storage.listAttempts(job.id).find(row => row.kind === 'publication')!; assert.equal(receipt.state, 'started'); assert.equal(receipt.outcome, null);
  const waiting = fx.storage.getJob(job.id); assert.equal(waiting.state, 'needs-attention');
  gate.resolve(Response.json({ id: '1800000000000000099', channel_id: settings.channelId })); await flush();
  assert.deepEqual(fx.storage.listAttempts(job.id).find(row => row.kind === 'publication')!.outcome, { messageId: '1800000000000000099' }); assert.equal(fx.storage.getJob(job.id).version, waiting.version);
  await pipeline.stop(); fx.reopen(); const resumed = fx.pipe(live, { publisher: publisher(api.makeRequest) }); assert.equal((await resumed.processNext()).status, 'idle'); assert.equal(api.posts().length, 1); assert.equal(fx.posts('analysis').length, 1);
});
