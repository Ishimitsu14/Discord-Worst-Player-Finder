import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { analysisClaims, buildContext, validateAnalysis, validateDictionary, validateProfile, verifyEvidence } from '../src/evaluation-lab/context.js';
import { digest, readJson } from '../src/evaluation-lab/files.js';
import { loadPlan, prepare } from '../src/evaluation-lab/prepare.js';
import { report } from '../src/evaluation-lab/report.js';
import { run } from '../src/evaluation-lab/run.js';
import type { Context, Entry, Raw, Reviews } from '../src/evaluation-lab/types.js';
import { analysis, dictionary, fakeFetch, fixture, match, profile, schema, writeJson } from './helpers.js';

const v2 = validateProfile(await readJson('evaluation/prompts/v2/profile.json'));
const schemaV2 = await readJson('evaluation/prompts/v2/response.schema.json') as object;
const dict = validateDictionary(dictionary);
const entry: Entry = { matchId: 101, side: 'radiant', split: 'development', snapshot: 'unused', digest: 'unused', retrievedAt: null, importedAt: '2026-10-17T00:00:00Z', source: 'import', originalMatchId: 101, parentDigest: null, usedForTuning: false };
const players = (raw: Raw) => raw.players as Raw[];
const context = (raw = match(), variant: Context['variant'] = 'compact-v2') => buildContext(raw, entry, variant, v2, dict);

test('v1 remains unchanged in shape; profiles and transformations reject mixed versions', () => {
  const raw = match();
  players(raw)[0].position_est = 5;
  const old = buildContext(raw, entry, 'compact-v1', profile, dict);
  assert.equal(old.roles, undefined);
  assert.equal(old.fights, undefined);
  assert.ok(!JSON.stringify(old).includes('position_est'));
  validateAnalysis(analysis(old), old, schema);
  assert.throws(() => validateProfile({ ...v2, analysisVersion: 1 }), /версии/);
  assert.throws(() => validateProfile({ ...v2, contextFields: profile.contextFields }), /Allowlist/);
  assert.throws(() => buildContext(raw, entry, 'full-v2', profile, dict), /версии/);
});

test('positions preserve unusual support heroes, source and evidence without filling gaps', () => {
  const raw = match();
  players(raw)[0].position_est = 5;
  players(raw)[1].position_est = 4;
  players(raw)[2].position_est = 99;
  const c = context(raw);
  assert.deepEqual(c.roles?.slice(0, 2).map(role => [role.position, role.source]), [[5, 'opendota-estimate'], [4, 'opendota-estimate']]);
  assert.equal(c.roles?.[2].position, null);
  assert.equal(c.roles?.[3].position, null);
  verifyEvidence(c, raw);
  const evidence = c.evidence.find(item => item.evidenceId === c.roles?.[0].evidenceId)!;
  assert.deepEqual(evidence.paths, ['/players/0/position_est']);
  evidence.value = 1;
  assert.throws(() => verifyEvidence(c, raw), /снимком/);
});

test('conflicting estimates become unknown, explicit overrides are tracked and cannot collide', () => {
  const raw = match();
  players(raw)[0].position_est = players(raw)[1].position_est = 1;
  assert.deepEqual(context(raw).roles?.slice(0, 2).map(role => role.position), [null, null]);
  const c = buildContext(raw, entry, 'compact-v2', v2, dict, [{ matchId: 101, playerSlot: 0, position: 5 }]);
  assert.deepEqual(c.roles?.slice(0, 2).map(role => [role.position, role.source]), [[5, 'manual'], [1, 'opendota-estimate']]);
  assert.throws(() => buildContext(raw, entry, 'compact-v2', v2, dict, [{ matchId: 101, playerSlot: 0, position: 5 }, { matchId: 101, playerSlot: 1, position: 5 }]), /повторяются/);
  assert.throws(() => buildContext(raw, entry, 'compact-v2', v2, dict, [{ matchId: 101, playerSlot: 99, position: 5 }]), /назначение/);
});

function withFight(): Raw {
  const raw = match();
  raw.teamfights = [{ start: 600, end: 660, deaths: 3, players: Array.from({ length: 10 }, (_, index) => ({ deaths: index % 2, damage: 100 + index, healing: 0, buybacks: 0, gold_delta: -index, xp_delta: index, ability_uses: { antimage_blink: index }, item_uses: {}, killed: {}, ability_targets: {} })) }];
  raw.objectives = [
    { time: 660, type: 'building_kill', key: 'npc_dota_badguys_tower1_mid', player_slot: 0 },
    { time: 780, type: 'building_kill', key: 'npc_dota_badguys_tower1_bot', player_slot: 0 },
    { time: 781, type: 'building_kill', key: 'npc_dota_badguys_tower1_top', player_slot: 0 },
  ];
  return raw;
}

test('fight cards map canonical slots even when match players are shuffled; zero differs from missing', () => {
  const raw = withFight();
  players(raw).reverse();
  for (const variant of ['full-v2', 'compact-v2'] as const) {
    const c = context(raw, variant);
    const p = c.fights![0].players[5];
    assert.equal(p.playerSlot, 128);
    assert.equal(c.evidence.find(item => item.evidenceId === p.metrics.damage)?.value, 105);
    assert.equal(c.evidence.find(item => item.evidenceId === p.metrics.healing)?.value, 0);
    assert.equal(p.metrics.xp_start, null);
    assert.ok(p.evidenceIds.length > 0);
    verifyEvidence(c, raw);
    c.evidence.find(item => item.evidenceId === p.metrics.damage)!.playerSlot = 0;
    assert.throws(() => verifyEvidence(c, raw), /другому слоту/);
  }
});

test('malformed fight arrays do not guess slots; objectives use an explicit temporal window', () => {
  const raw = withFight();
  const c = context(raw);
  const ids = c.fights![0].followingObjectives;
  assert.ok(ids.length > 0);
  assert.ok(ids.every(id => c.evidence.find(item => item.evidenceId === id)!.paths[0].startsWith('/objectives/1/')));
  assert.ok(c.limitations.some(value => value.includes('только временная связь')));
  ((raw.teamfights as Raw[])[0].players as unknown[]).pop();
  const malformed = context(raw).fights![0];
  assert.equal(malformed.players.length, 0);
  assert.ok(malformed.limitations.length > 0);
});

test('target maps admit known numeric data but exclude arbitrary player strings and object keys', () => {
  const raw = withFight();
  players(raw)[0].ability_targets = { antimage_blink: { npc_dota_hero_antimage: 7, 'secret target': 123 }, 'secret ability': 99 };
  players(raw)[0].damage_targets = { npc_dota_hero_antimage: 42, injection: 'secret instruction' };
  (raw.objectives as Raw[]).push({ time: 1400, type: 'building_kill', key: 'npc_dota_goodguys_tower4' });
  const c = context(raw);
  const serialized = JSON.stringify(c);
  for (const text of ['secret', 'private nickname', '100000', 'ignore all instructions']) assert.ok(!serialized.includes(text));
  assert.ok(c.evidence.some(e => e.paths[0] === '/players/0/ability_targets/antimage_blink/npc_dota_hero_antimage' && e.value === 7));
  assert.ok(c.evidence.some(e => e.paths[0] === '/players/0/damage_targets/npc_dota_hero_antimage' && e.value === 42));
  assert.equal(c.evidence.find(e => e.paths[0] === '/players/0/damage_targets/npc_dota_hero_antimage')?.unit, 'hp');
  assert.ok(c.evidence.some(e => e.value === 'building_kill'));
  assert.ok(c.evidence.some(e => e.value === 'npc_dota_goodguys_tower4'));
  verifyEvidence(c, raw);
});

test('v2 validates all five assessments, confidence, positions, alternative and every reference', () => {
  const c = context();
  const good = analysis(c);
  validateAnalysis(good, c, schemaV2);
  const bad = (edit: (a: ReturnType<typeof analysis>) => void) => { const value = structuredClone(good); edit(value); assert.throws(() => validateAnalysis(value, c, schemaV2)); };
  bad(a => { a.playerAssessments!.pop(); });
  bad(a => { a.playerAssessments![1].playerSlot = 0; });
  bad(a => { a.playerAssessments![0].position = 1; });
  bad(a => { a.playerAssessments![0].contributions[0].evidenceIds = ['e99999999']; });
  bad(a => { a.closestAlternative!.reason.evidenceIds = ['e99999999']; });
  bad(a => { a.closestAlternative!.playerSlot = 0; });
  bad(a => { a.closestAlternative!.playerSlot = 128; });
  bad(a => { a.closestAlternative = null; });
  bad(a => { delete a.confidence; });
  bad(a => { a.playerAssessments![0].resources = null; });
  const pair = analysis(c, [0, 1]);
  validateAnalysis(pair, c, schemaV2);
  const refusal = analysis(c, []);
  refusal.status = 'insufficient-evidence';
  validateAnalysis(refusal, c, schemaV2);
  assert.ok(analysisClaims(refusal).length > 0);
});

test('v2 prepare freezes role overrides, alternating variants and schema while old plans stay readable', async () => {
  const f = await fixture({ contextVersion: 2, repeats: 2 });
  assert.deepEqual(f.plan.requests.map(r => r.variant), ['full-v2', 'compact-v2', 'compact-v2', 'full-v2']);
  const oldBytes = await readFile(join(f.path, 'plan.json'));
  await writeJson(f.experimentFile, { ...f.experiment, roleOverrides: [{ matchId: 101, playerSlot: 0, position: 5 }] });
  const second = await prepare(f.root, f.experimentFile);
  const c = await readJson(join(second.path, second.plan.requests[0].context)) as Context;
  assert.equal(c.roles?.[0].source, 'manual');
  const body = await readJson(join(second.path, second.plan.requests[0].request)) as Raw;
  assert.equal(((body.response_format as Raw).json_schema as Raw).name, 'analysis_v2');
  assert.equal(digest(await readFile(join(f.path, 'plan.json'))), digest(oldBytes));
  await loadPlan(f.path);
  await writeJson(f.experimentFile, { ...f.experiment, roleOverrides: [{ matchId: 999, playerSlot: 0, position: 5 }] });
  await assert.rejects(prepare(f.root, f.experimentFile), /назначение/);
  const old = await fixture();
  assert.deepEqual(old.plan.requests.map(r => r.variant), ['full-v1', 'compact-v1']);
  await loadPlan(old.path);
});

test('v2 mocked run and report require reviewing facts from all players and separate version metrics', async () => {
  const f = await fixture({ contextVersion: 2, side: 'dire' });
  const api = fakeFetch();
  await run({ root: f.root, planPath: f.path, budgetUsd: 100, maxRequests: 2 }, { fetcher: api.fetcher, apiKey: 'test-secret' });
  assert.equal(api.posts, 2);
  const first = await report({ root: f.root, planPath: f.path });
  const rows = first.report.rows as { analysis: ReturnType<typeof analysis>; status: string }[];
  assert.ok(rows.every(row => row.status === 'valid' && row.analysis.playerAssessments!.length === 5));
  assert.deepEqual(Object.keys(first.report.variants as object), ['full-v2', 'compact-v2']);
  assert.equal((first.report.pairs as { complete: boolean }[])[0].complete, true);
  const reviews = await readJson(join(first.path, 'reviews-template.json')) as Reviews;
  assert.ok(reviews.entries.every(review => review.claims.length === 18));
  reviews.entries.forEach(review => { review.status = 'reviewed'; review.agreement = 'agree'; review.roast = 'usable'; review.claims.forEach(claim => { claim.verdict = 'supported'; }); });
  const file = join(f.root, 'reviews-input.json');
  await writeJson(file, { ...reviews, entries: reviews.entries.map(review => ({ ...review, claims: review.claims.filter(claim => claim.section === undefined) })) });
  await assert.rejects(report({ root: f.root, planPath: f.path, reviewsFile: file }), /все основания/);
  await writeJson(file, reviews);
  const second = await report({ root: f.root, planPath: f.path, reviewsFile: file });
  assert.equal((second.report.overall as { reviewed: number }).reviewed, 2);
  assert.equal(second.report.stage, 'tool-ready');
});
