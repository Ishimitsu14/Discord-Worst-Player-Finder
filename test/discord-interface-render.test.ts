import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderAnalysis, DiscordInterfaceError } from '../src/discord-interface/index.js';
import { publicationMessage, validateMessage, cleanText, shorten } from '../src/discord-interface/render.js';
import { accepted, data } from './discord-interface-helpers.js';
import { analysis as modelAnalysis } from './match-analysis-helpers.js';

async function documentedEmbed(index: number) {
  const readme = await readFile('src/discord-interface/README.md', 'utf8');
  return JSON.parse([...readme.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)][index][1]);
}

test('Discord renderer uses accepted result, slot/hero identity and saved snapshot, without mutation', async t => {
  const fx = await accepted(t), context = structuredClone(fx.context); context.snapshot.data.players.reverse();
  const selected = context.analysis.analysis!.selectedPlayers[0], player = context.snapshot.data.players.find(row => row.player_slot === selected.playerSlot)!;
  player.personaname = 'Наш игрок'; const before = structuredClone(context), embed = renderAnalysis(context);
  assert.match(embed.fields![0].name, /Наш игрок.*Anti-Mage/); assert.equal(embed.fields!.length, 4); assert.match(embed.title!, /Radiant: победа/);
  assert.equal(embed.url, 'https://www.opendota.com/matches/101'); assert.match(embed.footer!.text, /экспериментально/); assert.deepEqual(context, before);
  assert.deepEqual(embed, await documentedEmbed(0));
  const body = publicationMessage(context); assert.equal(body, publicationMessage(context)); validateMessage(body, context.analysis.attemptId!);
  const parsed = JSON.parse(body); assert.deepEqual(parsed.allowed_mentions, { parse: [], users: [], roles: [], replied_user: false });
  const other = structuredClone(context); other.analysis.attemptId = 'new-attempt'; other.job.resultAttemptId = 'new-attempt'; assert.notEqual(JSON.parse(publicationMessage(other)).nonce, parsed.nonce);
});

test('renderer preserves one/two selected players and their facts for both sides and outcomes', async t => {
  const fx = await accepted(t);
  const context = structuredClone(fx.context); context.analysis.analysis = modelAnalysis(context.bundle, [0, 2]);
  let embed = renderAnalysis(context); assert.match(embed.fields![0].name, /Anti-Mage/); assert.match(embed.fields![3].name, /Bane/); assert.equal(embed.fields!.length, 7);
  const dire = await fx.request(fx.pipeline, 101, 'dire'); await fx.process(fx.pipeline); const result = fx.storage.getLatestResult(101, 'dire', 'legacy')!, artifacts = fx.storage.getJobArtifacts(dire.id, 'legacy');
  embed = renderAnalysis({ job: result.job, analysis: result.attempt, bundle: artifacts.bundle!, snapshot: artifacts.snapshot! }); assert.match(embed.title!, /Dire: поражение/);
});

test('unknown hero falls back to ID and outcome matches the accepted facts', async t => {
  const raw = data(); raw.players[0].hero_id = 9999; raw.radiant_win = false;
  const fx = await accepted(t, raw), embed = renderAnalysis(fx.context);
  assert.match(embed.fields![0].name, /Герой #9999/); assert.match(embed.title!, /Radiant: поражение/);
  const dire = await fx.request(fx.pipeline, 101, 'dire'); await fx.process(fx.pipeline);
  const result = fx.storage.getLatestResult(101, 'dire', 'legacy')!, artifacts = fx.storage.getJobArtifacts(dire.id, 'legacy');
  assert.match(renderAnalysis({ job: result.job, analysis: result.attempt, bundle: artifacts.bundle!, snapshot: artifacts.snapshot! }).title!, /Dire: победа/);
});

test('anonymous player falls back to slot; long nickname cannot truncate hero out of heading', async t => {
  const fx = await accepted(t), context = structuredClone(fx.context);
  delete context.snapshot.data.players[0].personaname;
  assert.match(renderAnalysis(context).fields![0].name, /Игрок, слот 0 — Anti-Mage/);
  context.snapshot.data.players[0].personaname = 'Очень длинный ник '.repeat(100); const embed = renderAnalysis(context);
  assert.ok(embed.fields![0].name.length <= 96); assert.match(embed.fields![0].name, /… — Anti-Mage/); assert.match(embed.footer!.text, /сокращён/);
  context.snapshot.data.players[0].personaname = 'a'.repeat(1_000_000);
  assert.match(renderAnalysis(context).footer!.text, /сокращён/);
});

test('insufficient-evidence keeps limitations/outcome/link without selected player or roast', async t => {
  const fx = await accepted(t), context = structuredClone(fx.context), result = context.analysis.analysis!;
  result.status = 'insufficient-evidence'; result.confidence = 'low'; result.selectedPlayers = []; result.comparison = null; result.closestAlternative = null; result.limitations = ['Недостаточно журналов.'];
  const embed = renderAnalysis(context); assert.match(embed.title!, /Недостаточно данных.*победа/); assert.equal(embed.fields!.length, 1); assert.equal(embed.fields![0].value, 'Недостаточно журналов.'); assert.ok(embed.url);
  assert.deepEqual(embed, await documentedEmbed(1));
});

test('renderer rejects invalid/unaccepted/mismatched data and unsupported fact references', async t => {
  const fx = await accepted(t);
  for (const edit of [
    (c: typeof fx.context) => { c.job.resultAttemptId = null; },
    (c: typeof fx.context) => { c.analysis.status = 'invalid-output'; },
    (c: typeof fx.context) => { c.analysis.identity!.bundleId = 'wrong'; },
    (c: typeof fx.context) => { c.snapshot.data.players[0].hero_id = 20; },
    (c: typeof fx.context) => { c.snapshot.data.radiant_win = false; },
    (c: typeof fx.context) => { c.snapshot.data.duration = 1; },
    (c: typeof fx.context) => { c.analysis.analysis!.selectedPlayers[0].reasons[0].evidenceIds = ['e99999999']; },
  ]) {
    const context = structuredClone(fx.context); edit(context); assert.throws(() => renderAnalysis(context), (error: unknown) => error instanceof DiscordInterfaceError);
  }
});

test('maximum strings, two players, Unicode/mentions/links stay within one embed and disable hostile markup', async t => {
  const fx = await accepted(t), context = structuredClone(fx.context); context.analysis.analysis = modelAnalysis(context.bundle, [0, 2]);
  const evil = '@everyone <@123> [ссылка](https://evil.example/path) ``` ** 💩 '.repeat(12).slice(0, 590);
  context.analysis.analysis.selectedPlayers.forEach(player => { player.roast = evil; player.reasons = Array.from({ length: 3 }, () => ({ claim: evil, evidenceIds: [context.bundle.context.allies[0].metrics.id] })); });
  context.analysis.analysis.comparison!.claim = evil; context.analysis.analysis.limitations = [evil.slice(0, 290)];
  context.snapshot.data.players[0].personaname = '@here 😃'.repeat(50) + '\ud800';
  const body = publicationMessage(context), value = JSON.parse(body), embed = value.embeds[0]; validateMessage(body, context.analysis.attemptId!);
  const fields = embed.fields as { name: string; value: string }[]; assert.equal(fields.length, 9);
  const sum = embed.title.length + embed.description.length + embed.footer.text.length + fields.reduce((n, row) => n + row.name.length + row.value.length, 0);
  assert.ok(sum <= 6000); assert.ok(fields.every(row => row.name.length <= 256 && row.value.length <= 1024));
  assert.doesNotMatch(JSON.stringify(fields), /https:\/\/evil|@everyone|@here|(?<!\\)```/); assert.match(embed.footer.text, /сокращён/);
  assert.equal(shorten('текст '.repeat(20) + '1234567890', 124).endsWith('1234…'), false); assert.doesNotMatch(cleanText('\ud800'), /[\ud800-\udfff]/u);
});

test('stored message validation rejects mutations before any HTTP dispatch', async t => {
  const fx = await accepted(t), original = publicationMessage(fx.context);
  for (const edit of [
    (v: any) => { v.allowed_mentions.parse = ['everyone']; }, (v: any) => { v.embeds[0].url = 'https://evil.example'; },
    (v: any) => { v.embeds[0].description = '@everyone'; }, (v: any) => { v.nonce = 'other'; }, (v: any) => { v.content = 'extra'; },
    (v: any) => { v.embeds[0].description = 'x'.repeat(6001); }, (v: any) => { v.embeds[0].fields[0].value = '[fake](//evil.example)'; },
  ]) {
    const value = JSON.parse(original); edit(value); assert.throws(() => validateMessage(JSON.stringify(value), fx.context.analysis.attemptId!), (error: unknown) => error instanceof DiscordInterfaceError && error.code === 'invalid-message');
  }
});
