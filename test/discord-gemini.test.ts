import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderAnalysis, createDiscordPublisher } from '../src/discord-interface/index.js';
import { validateMessage } from '../src/discord-interface/render.js';
import { geminiFixture, geminiAnswerV2, geminiEvents, geminiStreamResponse, live, brokenConnection } from './gemini-runtime-helpers.js';
import { commands, interaction } from './discord-interface-helpers.js';

test('Gemini renderer: maximum schema strings/Unicode/mentions/links keep player, four reasons and final three within limits', async t => {
  const fx = await geminiFixture(t), evil = '@everyone <@123> [ссылка](https://evil.example/path) ``` ** 💩 ';
  fx.matches.get(101)!.players[7].personaname = evil.repeat(20) + '\ud800';
  fx.controls.inference = () => {
    const job = fx.storage.getLatestJob(101, 'dire')!, { bundle } = fx.storage.getJobArtifacts(job.id, 'gemini'), answer = geminiAnswerV2(bundle!);
    const bounded = (n: number) => Array.from(evil.repeat(30)).slice(0, n).join('');
    answer.nomination = bounded(100); answer.verdict = bounded(700); answer.limitations = [bounded(160), bounded(160)];
    answer.facts.push(structuredClone(answer.facts[0])); answer.facts.forEach(row => { row.claim = bounded(240); }); answer.teamFacts.forEach(row => { row.claim = bounded(240); });
    return geminiStreamResponse(geminiEvents(bundle!, { answer }));
  };
  const pipeline = fx.geminiPipe(), job = await fx.request(pipeline, 101, 'dire'); assert.equal((await fx.process(pipeline)).state, 'succeeded');
  const stored = fx.storage.getLatestResult(101, 'dire', 'gemini')!, artifacts = fx.storage.getJobArtifacts(job.id, 'gemini');
  const context = { analysisProfile: 'gemini' as const, job: stored.job, analysis: stored.attempt, bundle: artifacts.bundle!, snapshot: artifacts.snapshot! };
  const message = createDiscordPublisher({ botToken: 'synthetic-discord-key' }).prepare(context), parsed = JSON.parse(message), embed = parsed.embeds[0];
  validateMessage(message, stored.attempt.attemptId!); assert.equal(parsed.enforce_nonce, true); assert.deepEqual(parsed.allowed_mentions, { parse: [], users: [], roles: [], replied_user: false });
  assert.equal(embed.fields.filter((row: { name: string }) => row.name.startsWith('Основание')).length, 4);
  assert.match(embed.description, /Legion Commander/); assert.match(embed.footer.text, /сокращён/); assert.equal(embed.fields.slice(-3).every((row: { name: string }) => row.name.includes('Почему проебали')), true);
  const sum = embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((n: number, row: { name: string; value: string }) => n + row.name.length + row.value.length, 0);
  assert.ok(sum <= 6000); assert.ok(embed.fields.every((row: { value: string }) => row.value.length <= 1024)); assert.doesNotMatch(JSON.stringify(embed), /@everyone|https:\/\/evil|@here/);
  const changed = structuredClone(context); changed.analysis.attemptId = 'different-attempt'; changed.job.resultAttemptId = 'different-attempt';
  assert.notEqual(JSON.parse(createDiscordPublisher({ botToken: 'synthetic-discord-key' }).prepare(changed)).nonce, parsed.nonce);
});

test('Gemini stored report survives failed legacy revision; scope/admin checks and both commands add no external requests', async t => {
  const fx = await geminiFixture(t), gemini = fx.geminiPipe(), job = await fx.request(gemini); await fx.process(gemini); await gemini.stop();
  const legacy = fx.pipe(live); await legacy.requestReanalysis({ requestId: 'explicit-admin-revision', matchId: 101, side: 'radiant' });
  fx.hooks.analysis = () => { throw Error('synthetic metadata failure'); }; const latest = await fx.process(legacy); assert.equal(latest.analysisProfile, 'legacy');
  const before = fx.calls.length, ui = commands(fx, legacy), ordinary = interaction({ matchId: '101' }), status = interaction({ name: 'worst-status', jobId: latest.id });
  await ui.handle(ordinary); await ui.handle(status); assert.match(ordinary.content(), /Сохранённый результат: версия 1/); assert.match(status.content(), /Сохранённый результат: версия 1/);
  assert.equal(fx.calls.length, before); assert.equal(fx.posts('analysis').length, 1); assert.equal(fx.sends(), 1);
  const forbidden = interaction({ name: 'worst-reanalyze', matchId: '101', side: 'radiant' }); await ui.handle(forbidden); assert.match(forbidden.content(), /администратору/);
  const outsider = interaction({ name: 'worst-status', jobId: job.id, channelId: '123' }); await ui.handle(outsider); assert.match(outsider.content(), /заданном канале/); await ui.ui.stop();
});

test('Gemini unknown/reserve status never invents report or calls a reserve a charge', async t => {
  const fx = await geminiFixture(t); fx.controls.inference = brokenConnection;
  const pipeline = fx.geminiPipe({ ...live, maxTotalCostUsd: 0.025 }), job = await fx.request(pipeline); await fx.process(pipeline);
  const ui = commands(fx, pipeline), status = interaction({ name: 'worst-status', jobId: job.id }), calls = fx.calls.length;
  await ui.handle(status); assert.match(status.content(), /Резерв бюджета/); assert.match(status.content(), /не подтверждённое списание/); assert.match(status.content(), /неизвестна/);
  assert.equal((status.responses.at(-1)!.body.embeds as unknown[]).length, 0); assert.equal(fx.calls.length, calls); await ui.ui.stop();
});

test('documented Gemini embed matches the public renderer fixture', async t => {
  const fx = await geminiFixture(t), pipeline = fx.geminiPipe(), job = await fx.request(pipeline, 101, 'dire'); await fx.process(pipeline);
  const stored = fx.storage.getLatestResult(101, 'dire', 'gemini')!, artifacts = fx.storage.getJobArtifacts(job.id, 'gemini');
  const embed = renderAnalysis({ analysisProfile: 'gemini', job: stored.job, analysis: stored.attempt, bundle: artifacts.bundle!, snapshot: artifacts.snapshot! });
  const readme = await readFile('src/discord-interface/README.md', 'utf8'), examples = [...readme.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)];
  assert.deepEqual(embed, JSON.parse(examples[2][1]));
});
