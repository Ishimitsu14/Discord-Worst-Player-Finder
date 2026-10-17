import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildContext, validateAnalysis, validateDictionary, validateProfile, verifyEvidence } from '../src/evaluation-lab/context.js';
import { digest, id, json, readJson } from '../src/evaluation-lab/files.js';
import { loadPlan, prepare } from '../src/evaluation-lab/prepare.js';
import type { Context, Corpus } from '../src/evaluation-lab/types.js';
import { analysis, dictionary, fixture, match, profile, schema, writeJson } from './helpers.js';

test('контекст исключает личные и произвольные данные и сохраняет обе стороны', async () => {
  const f = await fixture();
  const entry = f.corpus.entries[0];
  const raw = match();
  (raw.players as Record<string, unknown>[])[0].hero_id = 999999;
  const full = buildContext(raw, entry, 'full-v1', profile, validateDictionary(dictionary));
  assert.equal(full.players.length, 10);
  assert.equal(full.players[0].heroId, 999999);
  assert.equal(full.players[0].heroName, null);
  assert.ok(full.limitations.some(value => value.includes('Неизвестный hero')));
  assert.ok(!json(full).includes('private') && !json(full).includes('account_id') && !json(full).includes('personaname') && !json(full).includes('ignore all'));
  verifyEvidence(full, raw);
  assert.ok(full.evidence.some(e => e.paths.includes('/players/0/ability_uses/antimage_blink') && e.value === 2));
  assert.ok(full.evidence.some(e => e.paths.includes('/players/0/deaths_log/0/time_dead') && e.unit === 'seconds'));
  const changed = structuredClone(full); changed.evidence[0].value = 'tamper';
  assert.throws(() => verifyEvidence(changed, raw), /не совпадает/);
});

test('срезы используют times и реальные индексы, без интерполяции и 30-й минуты короткой игры', async () => {
  const f = await fixture();
  const raw = match();
  const players = raw.players as Record<string, unknown>[];
  [players[0], players[7]] = [players[7], players[0]];
  delete players[1].gold_t;
  const context = buildContext(raw, f.corpus.entries[0], 'compact-v1', profile, validateDictionary(dictionary));
  assert.equal(context.indexToSlot[0], 130);
  assert.ok(context.evidence.some(e => e.playerSlot === 130 && e.transform === 'slice-10m-v1' && e.paths.includes('/players/0/gold_t/1') && e.value === 2000));
  assert.ok(!context.evidence.some(e => e.transform === 'slice-30m-v1'));
  assert.ok(context.evidence.some(e => e.playerSlot === 130 && e.transform === 'delta-10-20m-v1' && e.value === 2000 && e.paths.includes('/players/0/gold_t/2')));
  assert.ok(!context.evidence.some(e => e.playerSlot === 1 && e.paths.some(path => path.includes('/gold_t/'))));
  verifyEvidence(context, raw);
});

test('analysis-v1: один, пара и отказ; неверные слоты, дубликаты, ссылки и обёртки отклоняются', async () => {
  const f = await fixture();
  const context = await readJson(join(f.path, f.plan.requests[0].context)) as Context;
  validateAnalysis(analysis(context), context, schema);
  validateAnalysis(analysis(context, [0, 1]), context, schema);
  validateAnalysis({ status: 'insufficient-evidence', selectedPlayers: [], comparison: 'Мало данных.', limitations: ['Нет событий.'] }, context, schema);
  for (const slots of [[128], [0, 0], [0, 1, 2]]) assert.throws(() => validateAnalysis(analysis(context, slots), context, schema));
  const invalid = analysis(context); invalid.selectedPlayers[0].reasons[0].evidenceIds = ['e9999999'];
  assert.throws(() => validateAnalysis(invalid, context, schema), /отсутствующее/);
  const missing = analysis(context); missing.selectedPlayers[0].reasons.pop();
  assert.throws(() => validateAnalysis(missing, context, schema));
  assert.throws(() => validateAnalysis('```json\n{}\n```', context, schema));
});

test('план фиксирует точные входы и чередует варианты; изменение инструкции с тем же именем меняет digest', async () => {
  const f = await fixture({ count: 3, repeats: 2 });
  assert.equal(f.plan.requests.length, 12);
  assert.deepEqual(f.plan.requests.slice(0, 4).map(request => request.variant), ['full-v1', 'compact-v1', 'compact-v1', 'full-v1']);
  const request = await readFile(join(f.path, f.plan.requests[0].request), 'utf8');
  assert.ok(!request.includes('acceptableSelections') && !request.includes('modelOutputSeen'));
  await writeFile(join(f.prompt, 'instruction.md'), 'Изменённая инструкция.');
  const next = await prepare(f.root, f.experimentFile);
  assert.notEqual(next.plan.packageDigest, f.plan.packageDigest);
  assert.notEqual(next.plan.requests[0].requestDigest, f.plan.requests[0].requestDigest);
  assert.equal((await loadPlan(f.path)).planId, f.plan.planId);
  await writeFile(join(next.path, next.plan.requests[0].request), '{}');
  await assert.rejects(loadPlan(next.path), /Изменён артефакт/);
});

test('слишком большой контекст не обрезается', async () => {
  assert.equal(validateProfile({ ...profile, temperature: 0.1 }).temperature, 0.1);
  assert.throws(() => validateProfile({ ...profile, temperature: -1 }));
  const f = await fixture();
  const p = await readJson(join(f.prompt, 'profile.json')) as Record<string, unknown>;
  p.maxRequestBytes = 100;
  await writeJson(join(f.prompt, 'profile.json'), p);
  await assert.rejects(prepare(f.root, f.experimentFile), { code: 'context-too-large' });
});

test('holdout требует подтверждения; использованный для настройки holdout блокируется', async () => {
  const f = await fixture();
  const corpus = structuredClone(f.corpus); corpus.revision = id(); corpus.entries[0].split = 'holdout';
  await writeJson(f.experiment.corpus, corpus);
  await assert.rejects(prepare(f.root, f.experimentFile), /holdout/);
  f.experiment.holdoutUntouched = true;
  await writeJson(f.experimentFile, f.experiment);
  await prepare(f.root, f.experimentFile);
  corpus.revision = id(); corpus.entries[0].usedForTuning = true;
  await writeJson(f.experiment.corpus, corpus);
  await assert.rejects(prepare(f.root, f.experimentFile), /holdout/);
});

test('примеры не могут происходить из целевого или проверочного матча', async () => {
  const f = await fixture({ count: 2 });
  const entry = f.corpus.entries[0];
  const context = await readJson(join(f.path, f.plan.requests[0].context)) as Context;
  const examples = { version: 1, entries: [{ matchId: entry.matchId, snapshotDigest: entry.digest, context, analysis: analysis(context) }] };
  await writeJson(join(f.prompt, 'examples.json'), examples);
  await assert.rejects(prepare(f.root, f.experimentFile), /целевого матча/);
  f.experiment.matches.shift();
  await writeJson(f.experimentFile, f.experiment);
  await prepare(f.root, f.experimentFile);
  const corpus = structuredClone(f.corpus); corpus.revision = id(); corpus.entries[0].split = 'holdout';
  await writeJson(f.experiment.corpus, corpus);
  await assert.rejects(prepare(f.root, f.experimentFile), /development/);
});

test('шаблоны имеют поддерживаемые версии и не содержат локальных значений ключа', async () => {
  for (const name of ['corpus', 'labels', 'experiment', 'reviews']) {
    const bytes = await readFile(`evaluation/templates/${name}.json`, 'utf8');
    assert.equal(JSON.parse(bytes).version, 1);
    assert.ok(!bytes.includes('sk-or-'));
  }
});
