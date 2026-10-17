import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collect, inspectMatch, loadSnapshot, validateCorpus, validateLabels } from '../src/evaluation-lab/corpus.js';
import { atomicWrite, digest, json, parse, readJson, version, within } from '../src/evaluation-lab/files.js';
import { loadPlan, prepare } from '../src/evaluation-lab/prepare.js';
import { fixture, match, profile, writeJson } from './helpers.js';

test('точные байты снимка, неизвестное время импорта и старый план сохраняются при обновлении', async () => {
  const f = await fixture();
  const old = f.corpus.entries[0];
  const bytes = await readFile(join(f.root, old.snapshot));
  assert.equal(digest(bytes), old.digest);
  assert.equal(old.retrievedAt, null);
  const raw = JSON.parse(bytes.toString());
  assert.equal(raw.players[0].kills, 0);
  assert.equal(raw.players[0].hero_healing, null);
  assert.deepEqual(raw.players[0].kills_log, []);
  assert.equal(Object.hasOwn(raw.players[0], 'net_worth'), false);
  raw.players[0].kills = 9;
  await writeJson(join(f.root, 'changed.json'), raw);
  const newer = await collect({ root: f.root, matchId: 101, side: 'radiant', fromFile: join(f.root, 'changed.json') });
  assert.notEqual(newer.digest, old.digest);
  assert.deepEqual(await readFile(join(f.root, old.snapshot)), bytes);
  assert.equal((await loadPlan(f.path)).planId, f.plan.planId);
  await writeFile(join(f.root, newer.snapshot), '{}');
  await assert.rejects(loadSnapshot(f.root, newer), /Контрольная сумма/);
});

test('атомарная запись не перезаписывает существующий артефакт', async () => {
  const f = await fixture();
  const path = join(f.root, 'atomic.json');
  await atomicWrite(path, 'original');
  await assert.rejects(atomicWrite(path, 'replacement'), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), 'original');
  assert.throws(() => within(f.root, '../outside'), /выходит/);
});

test('проверяются JSON, версии, match ID и вход до сети', async () => {
  const f = await fixture();
  assert.throws(() => parse('{'), /JSON/);
  assert.throws(() => version({ version: 99 }), /версия/);
  await writeFile(join(f.root, 'broken.json'), '{');
  await assert.rejects(collect({ root: f.root, matchId: 101, side: 'radiant', fromFile: join(f.root, 'broken.json') }), /JSON/);
  await assert.rejects(collect({ root: f.root, matchId: 202, side: 'radiant', fromFile: join(f.root, 'input-0.json') }), /другой матч/);
  let calls = 0;
  const noNetwork: typeof fetch = async () => { calls++; throw Error('network forbidden'); };
  await assert.rejects(collect({ root: f.root, matchId: NaN, side: 'radiant' }, noNetwork));
  await assert.rejects(collect({ root: f.root, matchId: 101, side: 'radiant', split: 'bad' as 'development' }, noNetwork));
  await collect({ root: f.root, matchId: 101, side: 'radiant', fromFile: join(f.root, 'input-0.json') }, noNetwork);
  assert.equal(calls, 0);
});

test('публичный GET свежий, без POST и повторов при HTTP 429/500', async () => {
  const f = await fixture();
  let calls = 0;
  const api: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.opendota.com/api/matches/101');
    assert.notEqual(init?.method, 'POST');
    return Response.json(match());
  };
  const entry = await collect({ root: f.root, matchId: 101, side: 'radiant' }, api);
  assert.equal(entry.source, 'api'); assert.ok(entry.retrievedAt);
  assert.equal(calls, 1);
  for (const status of [429, 500]) {
    let failed = 0;
    await assert.rejects(collect({ root: f.root, matchId: 101, side: 'radiant' }, async () => { failed++; return new Response('', { status }); }), /HTTP/);
    assert.equal(failed, 1);
  }
});

test('обе стороны, анонимный союзник, basic и неполный parsed', () => {
  const raw = match();
  const radiant = inspectMatch(raw, { matchId: 101, side: 'radiant' }, profile);
  const dire = inspectMatch(raw, { matchId: 101, side: 'dire' }, profile);
  assert.equal(radiant.players.length, 10); assert.equal(dire.players.length, 10);
  delete (raw.players as Record<string, unknown>[])[0].gold_t;
  assert.ok(inspectMatch(raw, { matchId: 101, side: 'radiant' }, profile).limitations.some(value => value.includes('gold_t')));
  delete raw.version;
  assert.ok(inspectMatch(raw, { matchId: 101, side: 'radiant' }, profile).limitations.some(value => value.includes('Базовый')));
});

for (const scenario of ['missing-player', 'duplicate-slot', 'hero', 'outcome', 'duration', 'normal', 'turbo', 'unknown-mode']) test(`непригодный матч: ${scenario}`, () => {
  const raw = match();
  const players = raw.players as Record<string, unknown>[];
  if (scenario === 'missing-player') players.shift();
  if (scenario === 'duplicate-slot') players[1].player_slot = 0;
  if (scenario === 'hero') players[0].hero_id = null;
  if (scenario === 'outcome') delete raw.radiant_win;
  if (scenario === 'duration') raw.duration = 0;
  if (scenario === 'normal') raw.lobby_type = 0;
  if (scenario === 'turbo') raw.game_mode = 23;
  if (scenario === 'unknown-mode') delete raw.game_mode;
  assert.throws(() => inspectMatch(raw, { matchId: 101, side: 'radiant' }, profile));
});

test('эталоны: альтернативы, отказ, субъективность и пути', async () => {
  const f = await fixture();
  const snapshots = new Map([['101/radiant', match()]]);
  const labels = structuredClone(f.labels);
  labels.entries[0].acceptableSelections = [[1], [1, 3]];
  labels.entries[0].reasons = [{ playerSlot: 1, subjective: false, paths: ['/players/1/deaths'], comment: 'Наблюдение.' }];
  assert.deepEqual(validateLabels(labels, f.corpus, snapshots), labels);
  labels.entries[0].acceptableSelections = [[128]];
  assert.throws(() => validateLabels(labels, f.corpus, snapshots), /союзников/);
  labels.entries[0].acceptableSelections = [[1, 1]];
  assert.throws(() => validateLabels(labels, f.corpus, snapshots), /уникальных/);
  labels.entries[0].acceptableSelections = [];
  labels.entries[0].status = 'insufficient-evidence';
  validateLabels(labels, f.corpus, snapshots);
  labels.entries[0].reasons[0].paths = ['/missing'];
  assert.throws(() => validateLabels(labels, f.corpus, snapshots), /отсутствует/);
  labels.entries[0].reasons = [{ playerSlot: null, subjective: true, paths: [], comment: 'Личное впечатление.' }];
  validateLabels(labels, f.corpus, snapshots);
  labels.entries[0].snapshotDigest = 'a'.repeat(64);
  assert.throws(() => validateLabels(labels, f.corpus, snapshots), /другой снимок/);
});

test('ревизии эталонов не перезаписываются, разделение действует для всего match ID', async () => {
  const f = await fixture();
  const labels = structuredClone(f.labels);
  labels.entries[0].modelOutputSeen = true;
  await writeJson(f.labelsFile, labels);
  await assert.rejects(prepare(f.root, f.experimentFile), /Ревизия/);
  labels.previousRevision = labels.revision; labels.revision = 'next-labels';
  await writeJson(f.labelsFile, labels);
  const next = await prepare(f.root, f.experimentFile);
  assert.equal((await readJson(join(next.path, 'labels.json')) as typeof labels).entries[0].modelOutputSeen, true);
  const corpus = structuredClone(f.corpus);
  corpus.entries.push({ ...corpus.entries[0], side: 'dire', split: 'holdout' });
  assert.throws(() => validateCorpus(corpus), /разные разделы/);
  corpus.entries[1].matchId = 909;
  assert.throws(() => validateCorpus(corpus), /производные/);
});

test('производная фикстура сохраняет происхождение, просмотр ответа нельзя скрыть следующей ревизией', async () => {
  const f = await fixture();
  const entry = await collect({ root: f.root, matchId: 101, side: 'radiant', fromFile: join(f.root, 'input-0.json'), parentDigest: f.corpus.entries[0].digest });
  assert.equal(entry.source, 'derived-fixture'); assert.equal(entry.parentDigest, f.corpus.entries[0].digest);
  f.labels.previousRevision = f.labels.revision; f.labels.revision = 'seen'; f.labels.entries[0].modelOutputSeen = true;
  await writeJson(f.labelsFile, f.labels);
  await prepare(f.root, f.experimentFile);
  f.labels.previousRevision = f.labels.revision; f.labels.revision = 'hidden'; f.labels.entries[0].modelOutputSeen = false;
  await writeJson(f.labelsFile, f.labels);
  await assert.rejects(prepare(f.root, f.experimentFile), /Нельзя скрывать/);
});
