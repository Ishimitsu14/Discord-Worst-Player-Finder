import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, id, json, now, object, readJson } from '../src/evaluation-lab/files.js';
import { report } from '../src/evaluation-lab/report.js';
import { run } from '../src/evaluation-lab/run.js';
import { prepare } from '../src/evaluation-lab/prepare.js';
import type { Context, Reviews } from '../src/evaluation-lab/types.js';
import { analysis, fakeFetch, fixture, profile, writeJson } from './helpers.js';

test('победа/поражение → план → API → ревью → отчёт; повторный отчёт без сети', async () => {
  const f = await fixture({ count: 2 });
  const api = fakeFetch();
  await run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher: api.fetcher, apiKey: 'fake-test-key' });
  const first = await report({ root: f.root, planPath: f.path });
  const overall = object(first.report.overall);
  assert.equal(overall.valid, 4); assert.equal(overall.reviewed, 0);
  assert.equal(object(overall.independentLabels).exactMatches, 4);
  const reviews = await readJson(join(first.path, 'reviews-template.json')) as Reviews;
  reviews.entries.forEach(review => { review.status = 'reviewed'; review.agreement = 'agree'; review.roast = 'usable'; review.claims.forEach(claim => claim.verdict = 'supported'); });
  const reviewsFile = join(f.root, 'reviews-current.json');
  await writeJson(reviewsFile, reviews);
  const next = await report({ root: f.root, planPath: f.path, reviewsFile });
  assert.equal(object(next.report.overall).reviewed, 4);
  assert.equal((next.report.pairs as Record<string, unknown>[]).filter(pair => pair.isolatedContextEffect).length, 2);
  assert.equal(api.posts, 4);
  assert.equal(next.report.stage, 'tool-ready');
  assert.ok((await readFile(join(next.path, 'report.md'), 'utf8')).includes('Рекомендация: нет'));
});

test('частичное пересечение не считается точным; неразмеченные и после просмотра разделены', async () => {
  const f = await fixture({ count: 3 });
  f.labels.previousRevision = f.labels.revision; f.labels.revision = id();
  f.labels.entries[0].acceptableSelections = [[0, 1]];
  f.labels.entries[1].status = 'unlabeled'; f.labels.entries[1].acceptableSelections = [];
  f.labels.entries[2].modelOutputSeen = true;
  await writeJson(f.labelsFile, f.labels);
  const plan = await prepare(f.root, f.experimentFile);
  const api = fakeFetch();
  await run({ root: f.root, planPath: plan.path, budgetUsd: 10 }, { fetcher: api.fetcher, apiKey: 'fake-test-key' });
  const output = await report({ root: f.root, planPath: plan.path });
  const overall = object(output.report.overall);
  assert.equal(object(overall.independentLabels).exactMatches, 0);
  assert.equal(object(overall.independentLabels).partialOverlaps, 2);
  assert.equal(overall.unlabeled, 2);
  assert.equal(object(overall.afterOutputLabels).exactMatches, 2);
  assert.equal(object(overall.claims).supported, 0);
});

test('отказ совпадает только с эталоном insufficient-evidence', async () => {
  const f = await fixture({ labelStatus: 'insufficient-evidence' });
  const api = fakeFetch({ payload: () => ({ id: 'gen-test', model: profile.model, provider: 'DeepInfra', usage: { cost: 0.001 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ status: 'insufficient-evidence', selectedPlayers: [], comparison: 'Мало данных.', limitations: ['Нет событий.'] }) } }] }) });
  await run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher: api.fetcher, apiKey: 'fake-test-key' });
  const result = await report({ root: f.root, planPath: f.path });
  assert.equal(object(object(result.report.overall).independentLabels).exactMatches, 2);
});

test('ревью привязано к digest ответа и ревизии эталона, требует все утверждения', async () => {
  const f = await fixture();
  const api = fakeFetch();
  await run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher: api.fetcher, apiKey: 'fake-test-key' });
  const initial = await report({ root: f.root, planPath: f.path });
  const reviews = await readJson(join(initial.path, 'reviews-template.json')) as Reviews;
  const path = join(f.root, 'manual.json');
  const original = structuredClone(reviews);
  reviews.entries[0].responseDigest = 'a'.repeat(64);
  await writeJson(path, reviews);
  await assert.rejects(report({ root: f.root, planPath: f.path, reviewsFile: path }), /другому ответу/);
  reviews.entries[0] = structuredClone(original.entries[0]);
  reviews.entries[0].labelsRevision = 'different';
  await writeJson(path, reviews);
  await assert.rejects(report({ root: f.root, planPath: f.path, reviewsFile: path }), /эталону/);
  reviews.entries[0] = structuredClone(original.entries[0]); reviews.entries[0].status = 'reviewed'; reviews.entries[0].claims.pop();
  await writeJson(path, reviews);
  await assert.rejects(report({ root: f.root, planPath: f.path, reviewsFile: path }), /все основания/);
});

test('разные провайдеры, неизвестный маршрут и неполные пары исключены из изолированного сравнения', async () => {
  const f = await fixture({ count: 2 });
  const api = fakeFetch({ payload: (context, index) => ({ id: 'gen-test', model: profile.model, provider: index === 0 ? 'First' : index === 1 ? 'Second' : undefined,
    usage: { cost: 0.001 }, choices: [{ finish_reason: index === 3 ? 'length' : 'stop', message: { content: JSON.stringify(analysis(context)) } }] }) });
  await run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher: api.fetcher, apiKey: 'fake-test-key' });
  const result = await report({ root: f.root, planPath: f.path });
  const pairs = result.report.pairs as Record<string, unknown>[];
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].reason, 'different-providers'); assert.equal(pairs[1].reason, 'incomplete-pair');
  assert.ok(pairs.every(pair => !pair.isolatedContextEffect));
  assert.equal(object(result.report.overall).sent, 4);
});

test('стабильность требует повторений, знаменатели считаются по попыткам и уникальным матчам', async () => {
  const f = await fixture({ repeats: 3 });
  const api = fakeFetch();
  await run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher: api.fetcher, apiKey: 'fake-test-key' });
  const result = await report({ root: f.root, planPath: f.path });
  assert.equal(object(result.report.overall).uniqueMatches, 1);
  assert.equal(object(result.report.overall).sent, 6);
  const groups = result.report.stability as Record<string, unknown>[];
  assert.ok(groups.every(group => group.measured && group.modalMatches === 3 && group.valid === 3));
  const single = await fixture();
  await run({ root: single.root, planPath: single.path, budgetUsd: 10 }, { fetcher: fakeFetch().fetcher, apiKey: 'fake-test-key' });
  const singleReport = await report({ root: single.root, planPath: single.path });
  assert.ok((singleReport.report.stability as Record<string, unknown>[]).every(group => !group.measured && group.modalMatches === null));
});

test('неизвестные расходы остаются неизвестными, прерванные попытки включаются в знаменатели', async () => {
  const f = await fixture();
  await run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher: fakeFetch({ cost: null }).fetcher, apiKey: 'fake-test-key' });
  const result = await report({ root: f.root, planPath: f.path });
  const cost = object(object(result.report.overall).cost);
  assert.equal(cost.unknownAttempts, 1); assert.equal(cost.totalUsd, null); assert.equal(cost.knownSubtotalUsd, 0);
});

test('ошибка факта блокирует кандидата даже при совпадении выбранных слотов', async () => {
  const f = await fixture({ count: 10 });
  const corpus = structuredClone(f.corpus); corpus.revision = id();
  corpus.entries.slice(-3).forEach(entry => entry.split = 'holdout');
  await writeJson(f.experiment.corpus, corpus);
  f.experiment.holdoutUntouched = true;
  await writeJson(f.experimentFile, f.experiment);
  const prepared = await prepare(f.root, f.experimentFile);
  await run({ root: f.root, planPath: prepared.path, budgetUsd: 100, maxRequests: 20 }, { fetcher: fakeFetch().fetcher, apiKey: 'fake-test-key' });
  const first = await report({ root: f.root, planPath: prepared.path });
  const reviews = await readJson(join(first.path, 'reviews-template.json')) as Reviews;
  reviews.entries.forEach(review => { review.status = 'reviewed'; review.agreement = 'agree'; review.roast = 'usable'; review.claims.forEach(claim => claim.verdict = 'supported'); });
  reviews.recommendation = { variant: 'compact-v1', conclusion: 'candidate', matchFacts: ['Тестовый вывод по данным.'], matchAnalysis: ['Тестовый вывод по инструкции.'], limitations: ['Это синтетический тест условий перехода.'] };
  const file = join(f.root, 'reviews.json');
  await writeJson(file, reviews);
  const good = await report({ root: f.root, planPath: prepared.path, reviewsFile: file });
  assert.equal(good.report.stage, 'candidate');
  reviews.previousRevision = reviews.revision; reviews.revision = id();
  reviews.entries.find(review => review.index === 19)!.claims[0].verdict = 'unsupported';
  await writeJson(file, reviews);
  const bad = await report({ root: f.root, planPath: prepared.path, reviewsFile: file });
  assert.notEqual(bad.report.stage, 'candidate'); assert.equal(bad.report.recommendation, null);
});
