import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGeminiMatch, checkGeminiRecovery, prepareGeminiAnalysis } from '../src/match-analysis/index.js';
import type { GeminiAttempt } from '../src/match-analysis/index.js';
import { compactBundle, geminiMetadata, geminiPromptV2 } from './gemini-helpers.js';

const managementKey = 'synthetic-management-key';
async function failure() {
  const bundle = compactBundle(), prepared = prepareGeminiAnalysis(bundle, geminiPromptV2);
  const attempt = await analyzeGeminiMatch(prepared, bundle, { attemptId: 'synthetic-recovery', maxEstimatedCostUsd: 1 }, {
    apiKey: 'synthetic-inference-key', beforeSend: async () => {}, fetcher: async url => {
      if (String(url).endsWith('/endpoints')) return Response.json(geminiMetadata()); throw new Error('synthetic disconnect');
    },
  });
  assert.equal(attempt.status, 'transport-error'); assert.equal(attempt.responseReceived, false);
  return { prepared, attempt };
}
function analytics(rows: unknown[] = [], extra = {}) {
  return { data: { data: rows, metadata: { row_count: rows.length, truncated: false }, ...extra } };
}
const row = (attempt: GeminiAttempt) => ({ generation_id: 'gen-synthetic-recorded', session_id: attempt.attemptId, request_count: '1', total_usage: 0.001 });

test('Gemini recovery: три полных пустых проверки разрешают один повтор с положительным резервом', async () => {
  const f = await failure(), waits: number[] = [], queries: unknown[] = [];
  const decision = await checkGeminiRecovery(f.prepared, f.attempt, { managementKey, wait: async ms => { waits.push(ms); }, fetcher: async (url, init) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/analytics/query'); assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${managementKey}`);
    const query = JSON.parse(String(init?.body)); queries.push(query);
    assert.deepEqual(query.filters, [{ field: 'session_id', operator: 'eq', value: f.attempt.attemptId }]);
    assert.deepEqual(query.dimensions, ['generation_id', 'session_id']); assert.equal(query.limit, 2);
    return Response.json(analytics());
  } });
  assert.equal(decision.status, 'retry-allowed'); assert.equal(decision.costUsd, null); assert.equal(decision.reserveUsd, f.attempt.estimatedCostUsd);
  assert.ok(decision.reserveUsd > 0); assert.equal(decision.checks.length, 3); assert.deepEqual(waits, [10000, 20000, 30000]); assert.equal(queries.length, 3);
  assert.equal(f.attempt.usage.costUsd, null); assert.doesNotMatch(JSON.stringify(decision), /synthetic-management-key/);
});

test('Gemini recovery: поздняя запись останавливает проверки, точная стоимость берётся по ID', async () => {
  const f = await failure(); let queries = 0, lookups = 0;
  const decision = await checkGeminiRecovery(f.prepared, f.attempt, { managementKey, wait: async () => {}, fetcher: async url => {
    if (String(url).endsWith('/analytics/query')) return Response.json(analytics(++queries === 1 ? [] : [row(f.attempt)]));
    assert.equal(String(url), 'https://openrouter.ai/api/v1/generation?id=gen-synthetic-recorded'); lookups++;
    return Response.json({ data: { id: 'gen-synthetic-recorded', total_cost: 0.00100025 } });
  } });
  assert.equal(decision.status, 'recorded'); assert.equal(queries, 2); assert.equal(lookups, 1); assert.equal(decision.costUsd, 0.00100025); assert.equal(decision.reserveUsd, 0);
  assert.deepEqual(decision.checks.at(-1)!.generationIds, ['gen-synthetic-recorded']); assert.equal(f.attempt.generationId, null);
});

test('Gemini recovery: найденная запись запрещает повтор даже при недоступной стоимости', async () => {
  const f = await failure();
  const result = await checkGeminiRecovery(f.prepared, f.attempt, { managementKey, wait: async () => {}, fetcher: async url =>
    String(url).endsWith('/analytics/query') ? Response.json(analytics([row(f.attempt)])) : new Response('', { status: 404 }) });
  assert.equal(result.status, 'recorded'); assert.equal(result.costUsd, null); assert.equal(result.reserveUsd, f.attempt.estimatedCostUsd); assert.equal(result.reason, 'generation-cost-unavailable');
});

test('Gemini recovery: stale/truncated/malformed/чужая session/неизвестный ID запрещают повтор', async () => {
  const f = await failure();
  for (const payload of [analytics([], { cachedAt: Date.parse(f.attempt.endedAt) - 1 }), { data: { data: [], metadata: { row_count: 0, truncated: true } } },
    { data: { data: [], metadata: { row_count: 1, truncated: false } } }, analytics([], { warnings: ['Partial analytics'] }), {}, analytics([{ ...row(f.attempt), session_id: 'someone-else' }]),
    analytics([{ ...row(f.attempt), generation_id: 'unknown' }]), analytics([{ ...row(f.attempt), total_usage: null }]),
    analytics([{ ...row(f.attempt), generation_id: 'gen-' + managementKey }])]) {
    let queries = 0;
    const result = await checkGeminiRecovery(f.prepared, f.attempt, { managementKey, wait: async () => {}, fetcher: async () => { queries++; return Response.json(payload); } });
    assert.equal(result.status, 'unavailable'); assert.equal(queries, 1); assert.doesNotMatch(JSON.stringify(result), /synthetic-management-key/);
  }
});

test('Gemini recovery: 403/429/обрыв management API не разрешают новый запрос', async () => {
  const f = await failure();
  for (const status of [403, 429, 500, null]) {
    let queries = 0;
    const result = await checkGeminiRecovery(f.prepared, f.attempt, { managementKey, wait: async () => {}, fetcher: async () => {
      queries++; if (status === null) throw new Error(managementKey); return new Response('', { status });
    } });
    assert.equal(result.status, 'unavailable'); assert.equal(queries, 1); assert.doesNotMatch(JSON.stringify(result), /synthetic-management-key/);
  }
});

test('Gemini recovery: HTTP-ответ, частичный поток, ID, usage, invalid JSON и старые записи не повторяются', async () => {
  const f = await failure();
  for (const patch of [{ responseReceived: true }, { generationId: 'gen-known' }, { content: '' }, { streamBytes: 1 },
    { usage: { ...f.attempt.usage, costUsd: 0 } }, { status: 'invalid-output' as const }, { responseReceived: undefined }, { requestSent: false }]) {
    const result = await checkGeminiRecovery(f.prepared, { ...f.attempt, ...patch } as GeminiAttempt, { managementKey, fetcher: async () => { throw new Error('unexpected API'); }, wait: async () => { throw new Error('unexpected wait'); } });
    assert.equal(result.status, 'not-eligible'); assert.equal(result.checks.length, 0);
  }
});

test('Gemini recovery: отмена ожидания и запроса прекращает сверку', async () => {
  const f = await failure();
  for (const phase of ['wait', 'request']) {
    const controller = new AbortController(); let requests = 0;
    const result = await checkGeminiRecovery(f.prepared, f.attempt, { managementKey, signal: controller.signal,
      wait: async () => { if (phase === 'wait') controller.abort(); }, fetcher: async () => { requests++; controller.abort(); return new Promise<Response>(() => {}); } });
    assert.equal(result.status, 'aborted'); assert.equal(requests, phase === 'request' ? 1 : 0);
  }
});
