import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, json, readJson } from '../src/evaluation-lab/files.js';
import { history, inspectMetadata, run } from '../src/evaluation-lab/run.js';
import { report } from '../src/evaluation-lab/report.js';
import type { Attempt, Context } from '../src/evaluation-lab/types.js';
import { analysis, fakeFetch, fixture, metadata, profile, writeJson } from './helpers.js';

test('план → started до POST → два валидных ответа; точные тела, usage и отдельные runId', async () => {
  const f = await fixture();
  const api = fakeFetch({ onPost: async () => {
    const attempts = await history(f.root);
    assert.ok(attempts.some(attempt => attempt.status === 'started'));
  } });
  const result = await run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher: api.fetcher, apiKey: 'fake-test-key' });
  assert.equal(result.sent, 2); assert.equal(result.stopReason, 'completed');
  assert.equal(api.posts, 2); assert.equal(api.gets, 1);
  const attempts = await history(f.root);
  assert.ok(attempts.every(attempt => attempt.status === 'valid' && attempt.elapsedMs !== null));
  assert.equal(attempts[0].usage.costUsd, 0.001);
  const next = await run({ root: f.root, planPath: f.path, budgetUsd: 10, maxRequests: 1 }, { fetcher: api.fetcher, apiKey: 'fake-test-key' });
  assert.notEqual(next.runId, result.runId); assert.equal(next.stopReason, 'max-requests');
  assert.equal((await history(f.root)).length, 3);
});

test('без ключа и при неверном бюджете запросы не отправляются', async () => {
  const f = await fixture();
  const api = fakeFetch();
  await assert.rejects(run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher: api.fetcher, apiKey: '' }), { code: 'missing-key' });
  await assert.rejects(run({ root: f.root, planPath: f.path, budgetUsd: 0 }, { fetcher: api.fetcher, apiKey: 'fake-test-key' }));
  assert.equal(api.posts + api.gets, 0);
});

for (const failure of ['unsupported-schema', 'unsupported-parameter', 'unknown-price', 'missing-metadata', 'context-limit']) test(`проверка до платного POST: ${failure}`, async () => {
  const f = await fixture();
  let posts = 0;
  const fetcher: typeof fetch = async (url) => {
    if (!String(url).endsWith('/endpoints')) { posts++; throw Error('must not POST'); }
    const value = metadata();
    if (failure === 'unsupported-schema') value.data.endpoints[0].supported_parameters = ['temperature', 'max_tokens', 'response_format'];
    if (failure === 'unsupported-parameter') value.data.endpoints[0].supported_parameters = ['max_tokens', 'response_format', 'structured_outputs'];
    if (failure === 'unknown-price') value.data.endpoints[0].pricing.prompt = 'unknown';
    if (failure === 'context-limit') value.data.endpoints[0].context_length = 10;
    return failure === 'missing-metadata' ? new Response('', { status: 503 }) : Response.json(value);
  };
  await assert.rejects(run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher, apiKey: 'fake-test-key' }));
  assert.equal(posts, 0);
});

test('тариф — максимальный известный по допустимым endpoint, неизвестный не становится нулём', async () => {
  const f = await fixture();
  const value = metadata();
  value.data.endpoints.push({ ...value.data.endpoints[0], name: 'Expensive endpoint', pricing: { prompt: '0.000003', completion: '0.000004' } });
  assert.equal(inspectMetadata(value, profile, f.plan.requests).input, 0.000003);
  assert.equal(inspectMetadata(value, profile, f.plan.requests).output, 0.000004);
  value.data.endpoints[1].pricing.completion = '';
  assert.throws(() => inspectMetadata(value, profile, f.plan.requests), /тариф/);
});

for (const status of [401, 402, 403, 429, 500, 503]) test(`HTTP ${status}: одна попытка, стоимость сохранена, повтора нет`, async () => {
  const f = await fixture();
  const api = fakeFetch({ status, retry: '60', payload: () => ({ error: { message: 'do not persist this provider diagnostic' }, usage: { cost: 0.005 } }) });
  const result = await run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher: api.fetcher, apiKey: 'fake-test-key' });
  assert.equal(api.posts, 1); assert.equal(result.stopReason, 'api-error');
  const attempts = await history(f.root);
  assert.equal(attempts[0].usage.costUsd, 0.005);
  assert.equal(attempts[0].status, 'api-error');
  if (status === 429) {
    await assert.rejects(run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher: api.fetcher, apiKey: 'fake-test-key' }), { code: 'cooldown' });
    assert.equal(api.posts, 1);
  }
});

for (const kind of ['api-error-200', 'empty', 'truncated', 'invalid-json', 'invalid-schema', 'markdown', 'wrong-model', 'filtered']) test(`невалидный ответ: ${kind}`, async () => {
  const f = await fixture();
  const api = fakeFetch({ payload: (context) => {
    const output = analysis(context);
    const result = { id: 'gen-test', model: profile.model, provider: 'DeepInfra', usage: { cost: 0.001 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output), refusal: null as string | null } }] };
    if (kind === 'api-error-200') return { ...result, error: { message: 'error' } };
    if (kind === 'empty') result.choices[0].message.content = '';
    if (kind === 'truncated') result.choices[0].finish_reason = 'length';
    if (kind === 'invalid-json') result.choices[0].message.content = '{';
    if (kind === 'invalid-schema') result.choices[0].message.content = '{}';
    if (kind === 'markdown') result.choices[0].message.content = '```json\n' + result.choices[0].message.content + '\n```';
    if (kind === 'wrong-model') result.model = 'different/model';
    if (kind === 'filtered') result.choices[0].message.refusal = 'refusal';
    return result;
  } });
  const result = await run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher: api.fetcher, apiKey: 'fake-test-key' });
  assert.equal(api.posts, 1);
  assert.equal(result.stopReason, kind === 'api-error-200' ? 'api-error' : 'invalid-output');
  assert.equal((await history(f.root))[0].usage.costUsd, 0.001);
});

test('неизвестный расход останавливает серию; новый запуск требует резерв или сверку по generation ID', async () => {
  const f = await fixture();
  const unknown = fakeFetch({ cost: null });
  const first = await run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher: unknown.fetcher, apiKey: 'fake-test-key' });
  assert.equal(first.stopReason, 'unknown-cost'); assert.equal(unknown.posts, 1);
  const valid = fakeFetch();
  await assert.rejects(run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher: valid.fetcher, apiKey: 'fake-test-key' }), { code: 'unknown-cost' });
  const next = await run({ root: f.root, planPath: f.path, budgetUsd: 10, reserveUnknownUsd: 0.5 }, { fetcher: valid.fetcher, apiKey: 'fake-test-key' });
  const summary = await readJson(join(next.path, 'run.json')) as Record<string, unknown>;
  assert.equal(summary.reservedUsd, 0.5);
  assert.equal((await history(f.root)).find(attempt => attempt.runId === first.runId)!.usage.costUsd, null);
  const reconciliation = join(f.root, 'reconciliation.json');
  await writeJson(reconciliation, { version: 1, entries: [{ runId: first.runId, index: 0, generationId: 'gen-test', source: 'openrouter-generation', costUsd: 0.02 }] });
  await run({ root: f.root, planPath: f.path, budgetUsd: 10, reconciliation }, { fetcher: valid.fetcher, apiKey: 'fake-test-key' });
});

test('предел бюджета проверяется до отправки, предел запросов включает невалидные платные ответы', async () => {
  const f = await fixture();
  const api = fakeFetch();
  const result = await run({ root: f.root, planPath: f.path, budgetUsd: 0.0000001 }, { fetcher: api.fetcher, apiKey: 'fake-test-key' });
  assert.equal(result.sent, 0); assert.equal(result.stopReason, 'budget-exceeded');
  assert.equal(api.posts, 0);
  const limited = await run({ root: f.root, planPath: f.path, budgetUsd: 10, maxRequests: 1 }, { fetcher: api.fetcher, apiKey: 'fake-test-key' });
  assert.equal(limited.sent, 1);
});

test('таймаут и отмена завершают серию, started остаётся видимым при сбое процесса', async () => {
  for (const cancelled of [false, true]) {
    const f = await fixture();
    const controller = new AbortController();
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/endpoints')) return Response.json(metadata());
      if (cancelled) setTimeout(() => controller.abort(), 5);
      return new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error('fallback')), 2000);
        init!.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(Error('aborted')); }, { once: true });
      });
    };
    const result = await run({ root: f.root, planPath: f.path, budgetUsd: 10, timeoutMs: 25, signal: controller.signal }, { fetcher, apiKey: 'fake-test-key' });
    assert.equal(result.sent, 1); assert.equal(result.stopReason, 'unknown-cost');
    const attempt = (await history(f.root))[0];
    assert.equal(attempt.status, cancelled ? 'aborted' : 'timed-out');
    attempt.status = 'started'; attempt.content = null; attempt.responseDigest = null; attempt.endedAt = null;
    await writeJson(join(result.path, 'attempt-0.json'), attempt);
    const output = await report({ root: f.root, planPath: f.path });
    assert.equal((output.report.rows as Record<string, unknown>[])[0].status, 'interrupted');
  }
});

test('ошибка транспорта не теряет попытку, ключ, reasoning, headers и provider metadata не сохраняются', async () => {
  const f = await fixture();
  const key = 'fake-ephemeral-key-for-test';
  const api = fakeFetch({ payload: (context) => {
    const output = analysis(context); output.selectedPlayers[0].roast = 'Ответ ' + key;
    return { id: 'gen-test', model: profile.model, provider: 'DeepInfra',
      provider_metadata: { secret: 'should-not-persist' }, headers: { Authorization: key },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output), reasoning: 'should-not-persist' } }], usage: { cost: 0.001 } };
  } });
  const result = await run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher: api.fetcher, apiKey: key });
  for (const file of await readdir(result.path)) {
    const bytes = await readFile(join(result.path, file), 'utf8');
    assert.ok(!bytes.includes(key) && !bytes.includes('should-not-persist') && !bytes.includes('Authorization'));
  }
  const fetcher: typeof fetch = async url => { if (String(url).endsWith('/endpoints')) return Response.json(metadata()); throw Error('secret diagnostic '+key); };
  const failed = await run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher, apiKey: key });
  const attempt = (await history(f.root)).find(attempt => attempt.runId === failed.runId)!;
  assert.equal(attempt.status, 'transport-error'); assert.equal(attempt.error, 'transport-error');
});

test('Retry-After поддерживает HTTP date и fallback при неверном значении', async () => {
  for (const retry of [new Date(Date.now() + 120000).toUTCString(), 'not-a-date']) {
    const f = await fixture();
    const api = fakeFetch({ status: 429, retry, cost: 0 });
    await run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher: api.fetcher, apiKey: 'fake-test-key' });
    assert.ok(Date.parse((await history(f.root))[0].retryAt!) > Date.now() + 50000);
  }
});

test('фактические расходы первой отправки блокируют следующую; JSON ошибки транспорта отличим от JSON модели', async () => {
  const f = await fixture();
  const highCost = fakeFetch({ cost: 1 });
  const first = await run({ root: f.root, planPath: f.path, budgetUsd: 1 }, { fetcher: highCost.fetcher, apiKey: 'fake-test-key' });
  assert.equal(first.sent, 1); assert.equal(first.stopReason, 'budget-exceeded');
  const badJson: typeof fetch = async url => String(url).endsWith('/endpoints') ? Response.json(metadata()) : new Response('{', { status: 200 });
  const second = await run({ root: f.root, planPath: f.path, budgetUsd: 10 }, { fetcher: badJson, apiKey: 'fake-test-key' });
  const attempt = (await history(f.root)).find(attempt => attempt.runId === second.runId)!;
  assert.equal(attempt.status, 'invalid-output'); assert.equal(attempt.error, 'invalid-response-json');
});
