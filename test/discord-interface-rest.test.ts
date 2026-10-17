import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationCommandOptionType, PermissionFlagsBits } from 'discord.js';
import { buildCommandDefinitions, createDiscordPublisher, registerGuildCommands, DiscordInterfaceError } from '../src/discord-interface/index.js';
import { PublicationError, type PublicationInput } from '../src/match-pipeline/index.js';
import { accepted, http, publisher, token, settings, flush } from './discord-interface-helpers.js';
import { publicationMessage } from '../src/discord-interface/render.js';
import { deferred } from './opendota-helpers.js';

function input(context: Awaited<ReturnType<typeof accepted>>['context']): PublicationInput {
  return { version: 1, guildId: context.job.settings.guildId, channelId: context.job.settings.channelId, analysisAttemptId: context.analysis.attemptId!, message: publicationMessage(context) };
}
const publicationError = (outcome: 'not-sent' | 'unknown', code?: string) => (error: unknown) => {
  assert.ok(error instanceof PublicationError); assert.equal(error.outcome, outcome); if (code) assert.equal(error.code, code); assert.doesNotMatch(error.message, /synthetic-discord-token|private upstream/); return true;
};

test('command definitions use three guild upserts, string IDs, explicit side and admin only on reanalysis', () => {
  const definitions = buildCommandDefinitions(); assert.deepEqual(definitions.map(row => row.name), ['worst', 'worst-status', 'worst-reanalyze']);
  assert.equal(definitions[2].default_member_permissions, String(PermissionFlagsBits.Administrator)); assert.equal(definitions[0].default_member_permissions, undefined);
  for (const command of definitions) { assert.match(command.description, /[А-Яа-я]/); assert.equal(command.options![0].type, ApplicationCommandOptionType.String); assert.equal(command.options![0].required, true); }
  const side = definitions[2].options![1]; assert.equal(side.required, true); assert.equal(definitions[0].options![1].required, false);
  assert.deepEqual(buildCommandDefinitions(), definitions);
});

test('explicit registration upserts only own names, preserves foreign command and reports partial failure without retry', async () => {
  const saved = new Map([['foreign-command', '123']]); let count = 0, failing = false;
  const api = http(call => {
    assert.equal(call.init.method, 'POST'); assert.equal(call.url.pathname, `/api/v10/applications/18446744073709551612/guilds/${settings.guildId}/commands`);
    const body = JSON.parse(String(call.init.body)); if (failing && ++count === 2) return Response.json({ message: 'private upstream' }, { status: 503 });
    const commandId = saved.get(body.name) ?? String(1800000000000000000n + BigInt(saved.size)); saved.set(body.name, commandId); return Response.json({ id: commandId, name: body.name });
  });
  const options = { applicationId: '18446744073709551612', guildId: settings.guildId, botToken: token };
  const first = await registerGuildCommands(options, { makeRequest: api.makeRequest }); assert.equal(first.status, 'complete');
  assert.deepEqual(await registerGuildCommands(options, { makeRequest: api.makeRequest }), first); assert.equal(saved.get('foreign-command'), '123'); assert.equal(saved.size, 4);
  failing = true; const before = api.posts().length, partial = await registerGuildCommands(options, { makeRequest: api.makeRequest });
  assert.equal(partial.status, 'partial'); assert.equal(partial.registered.length, 1); assert.equal(api.posts().length - before, 2); assert.doesNotMatch(JSON.stringify(partial), /private upstream|synthetic-discord-token/);
  const controller = new AbortController(); controller.abort(); assert.equal((await registerGuildCommands(options, { makeRequest: api.makeRequest, signal: controller.signal })).error!.code, 'aborted'); assert.equal(api.posts().length - before, 2);
});

test('REST factories are inert, safe on invalid config/getters and create no sweepers', async () => {
  const before = process.getActiveResourcesInfo().filter(type => type === 'Timeout').length;
  const api = http(); createDiscordPublisher({ botToken: token }, { makeRequest: api.makeRequest });
  assert.equal(api.calls.length, 0); assert.equal(process.getActiveResourcesInfo().filter(type => type === 'Timeout').length, before);
  for (const options of [{ botToken: '' }, { botToken: token, extra: true }, { get botToken(): string { throw new Error(token); } }]) {
    assert.throws(() => createDiscordPublisher(options), (error: unknown) => error instanceof DiscordInterfaceError && error.code === 'invalid-config' && !error.message.includes(token));
  }
  for (const dependencies of [{ makeRequest: 1 }, { signal: 'bad' }, { extra: true }, { get makeRequest() { throw new Error(token); } }]) {
    assert.throws(() => createDiscordPublisher({ botToken: token }, dependencies as never), (error: unknown) => error instanceof DiscordInterfaceError && error.code === 'invalid-config');
  }
  await assert.rejects(registerGuildCommands({ applicationId: '123', guildId: settings.guildId, get botToken(): string { throw new Error(token); } }), (error: unknown) => error instanceof DiscordInterfaceError && !error.message.includes(token));
});

test('publisher sends exact saved bytes to original target with SDK signal and one wire POST', async t => {
  const fx = await accepted(t), api = http(), adapter = publisher(api.makeRequest), saved = input(fx.context), controller = new AbortController();
  assert.equal(adapter.prepare(fx.context), saved.message); assert.equal(api.calls.length, 0);
  assert.deepEqual(await adapter.send(saved, { signal: controller.signal }), { messageId: '18446744073709551613' });
  assert.deepEqual(api.calls.map(call => call.init.method), ['GET', 'POST']); assert.equal(api.posts()[0].init.body, saved.message);
  assert.equal(api.posts()[0].url.pathname, `/api/v10/channels/${settings.channelId}/messages`); assert.equal(api.posts()[0].init.signal instanceof AbortSignal, true);
  assert.equal((api.posts()[0].init.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.equal(JSON.parse(String(api.posts()[0].init.body)).enforce_nonce, true);
});

test('wrong guild, unsupported channels, invalid stored body and pre-send abort produce zero POST', async t => {
  const fx = await accepted(t), saved = input(fx.context);
  for (const type of [1, 2, 4, 10, 11, 12, 15]) {
    const api = http(call => call.init.method === 'GET' ? Response.json({ id: settings.channelId, guild_id: settings.guildId, type }) : undefined);
    await assert.rejects(publisher(api.makeRequest).send(saved, { signal: new AbortController().signal }), publicationError('not-sent', 'unavailable')); assert.equal(api.posts().length, 0);
  }
  for (const response of [{ id: settings.channelId, guild_id: '123', type: 0 }, { id: '456', guild_id: settings.guildId, type: 0 }]) {
    const api = http(() => Response.json(response)); await assert.rejects(publisher(api.makeRequest).send(saved, { signal: new AbortController().signal }), publicationError('not-sent')); assert.equal(api.posts().length, 0);
  }
  for (const status of [403, 404, 429, 503]) {
    const api = http(() => Response.json({ message: 'private upstream', retry_after: 120 }, { status }));
    await assert.rejects(publisher(api.makeRequest).send(saved, { signal: new AbortController().signal }), publicationError('not-sent'));
    assert.equal(api.calls.length, 1); assert.equal(api.posts().length, 0);
  }
  const gate = deferred<Response>(), stopped = new AbortController(), pendingApi = http(() => gate.promise);
  const pending = publisher(pendingApi.makeRequest).send(saved, { signal: stopped.signal }); await flush(); stopped.abort();
  gate.resolve(Response.json({ id: settings.channelId, guild_id: settings.guildId, type: 0 }));
  await assert.rejects(pending, publicationError('not-sent')); assert.equal(pendingApi.posts().length, 0);
  const api = http(), adapter = publisher(api.makeRequest); await assert.rejects(adapter.send({ ...saved, message: '{}' }, { signal: new AbortController().signal }), publicationError('not-sent', 'invalid-message')); assert.equal(api.calls.length, 0);
  const controller = new AbortController(); controller.abort(); await assert.rejects(adapter.send(saved, { signal: controller.signal }), publicationError('not-sent')); assert.equal(api.calls.length, 0);
});

test('Discord 400/401/403/404/429 reject once; 408/5xx remain unknown with zero hidden POST retries', async t => {
  const fx = await accepted(t), saved = input(fx.context);
  for (const status of [400, 401, 403, 404, 429, 408, 500, 503]) {
    const api = http(call => call.init.method === 'POST' ? Response.json({ code: status === 403 ? 50013 : 0, message: 'private upstream', retry_after: 120 }, { status, headers: status === 429 ? { 'Retry-After': '120', 'X-RateLimit-Reset-After': '120', 'X-RateLimit-Remaining': '0' } : {} }) : undefined);
    await assert.rejects(publisher(api.makeRequest).send(saved, { signal: new AbortController().signal }), publicationError([408, 500, 503].includes(status) ? 'unknown' : 'not-sent'));
    assert.equal(api.posts().length, 1, `HTTP ${status} must not retry`);
  }
});

test('network failure before POST is not-sent; after POST and malformed success are unknown', async t => {
  const fx = await accepted(t), saved = input(fx.context);
  for (const phase of ['GET', 'POST']) {
    const api = http(call => { if (call.init.method === phase) throw new Error(`private upstream ${token}`); return undefined; });
    await assert.rejects(publisher(api.makeRequest).send(saved, { signal: new AbortController().signal }), publicationError(phase === 'GET' ? 'not-sent' : 'unknown'));
    assert.equal(api.posts().length, phase === 'GET' ? 0 : 1);
  }
  for (const value of [{ id: 123, channel_id: settings.channelId }, { id: '18446744073709551616', channel_id: settings.channelId }, { id: '123', channel_id: '456' }, {}]) {
    const api = http(call => call.init.method === 'POST' ? Response.json(value) : undefined);
    await assert.rejects(publisher(api.makeRequest).send(saved, { signal: new AbortController().signal }), publicationError('unknown')); assert.equal(api.posts().length, 1);
  }
});

test('abort/timeout of dispatched fetch has no retry and an uncooperative promise can still deliver late ID', async t => {
  const fx = await accepted(t), saved = input(fx.context);
  for (const name of ['AbortError', 'TimeoutError']) {
    const api = http(call => { if (call.init.method === 'POST') throw new DOMException('private upstream', name); return undefined; });
    await assert.rejects(publisher(api.makeRequest).send(saved, { signal: new AbortController().signal }), publicationError('unknown')); assert.equal(api.posts().length, 1);
  }
  const pending = deferred<Response>(), controller = new AbortController(); let seenSignal: AbortSignal | undefined;
  const api = http(call => { if (call.init.method === 'POST') { seenSignal = call.init.signal as AbortSignal; return pending.promise; } });
  let ended = false; const sending = publisher(api.makeRequest).send(saved, { signal: controller.signal }).finally(() => { ended = true; });
  await flush(); assert.equal(api.posts().length, 1); controller.abort(); await flush(); assert.equal(seenSignal!.aborted, true); assert.equal(ended, false);
  pending.resolve(Response.json({ id: '12345', channel_id: settings.channelId })); assert.deepEqual(await sending, { messageId: '12345' }); assert.equal(api.posts().length, 1);
});
