import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGeminiMatch, prepareGeminiAnalysis } from '../src/match-analysis/index.js';
import type { GeminiDependencies, GeminiStartedAttempt } from '../src/match-analysis/index.js';
import { completionUrl } from '../src/match-analysis/openrouter.js';
import { geminiMetadataUrl } from '../src/match-analysis/gemini-run.js';
import { compactBundle, geminiAnswer, geminiEvents, geminiMetadata, geminiPrompt, geminiStreamResponse } from './gemini-helpers.js';

const key = 'synthetic-gemini-key-only-in-memory', options = { attemptId: 'synthetic-gemini', maxEstimatedCostUsd: 1 };
const never = (): Promise<never> => new Promise(() => {});
function fake(settings: { metadata?: unknown; response?: () => Response | Promise<Response>; before?: () => Promise<void> } = {}) {
  const input = compactBundle(), prepared = prepareGeminiAnalysis(input, geminiPrompt), started: GeminiStartedAttempt[] = [], events: string[] = [], sent: RequestInit[] = [];
  const dependencies: GeminiDependencies = { apiKey: key, beforeSend: async value => { events.push('started'); if (settings.before) await settings.before(); started.push(value); }, fetcher: async (url, init) => {
    assert.equal(init?.redirect, 'error');
    if (String(url) === geminiMetadataUrl) { events.push('get'); return Response.json(settings.metadata ?? geminiMetadata()); }
    assert.equal(String(url), completionUrl); assert.equal(init?.method, 'POST'); assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${key}`);
    events.push('post'); sent.push(init!); return settings.response ? settings.response() : geminiStreamResponse(geminiEvents(input), 3);
  } };
  return { input, prepared, started, events, sent, dependencies, run: (extra = {}) => analyzeGeminiMatch(prepared, input, { ...options, ...extra }, dependencies) };
}

test('Gemini SSE: один точный POST после started, UTF-8/CRLF фрагменты, ID/usage/тайминги', async () => {
  const upstream = fake(), result = await upstream.run();
  assert.equal(result.status, 'valid', JSON.stringify(result.error)); assert.deepEqual(result.analysis, geminiAnswer(upstream.input));
  assert.deepEqual(upstream.events, ['get', 'started', 'post']); assert.equal(upstream.sent.length, 1); assert.equal(upstream.sent[0].body, upstream.prepared.body);
  assert.equal(upstream.started[0].requestDigest, result.identity!.requestDigest); assert.equal(upstream.started[0].responseFormat, 'gemini-match-analysis-v1');
  assert.equal((upstream.sent[0].headers as Record<string, string>)['x-session-id'], result.attemptId); assert.equal(result.responseReceived, true);
  assert.equal(result.generationId, 'gen-synthetic'); assert.equal(result.usage.costUsd, 0.001); assert.equal(result.billingState, 'known');
  assert.ok(result.firstContentMs !== null && result.firstContentMs >= 0); assert.ok(result.streamBytes > 0); assert.ok(result.responseDigest); assert.equal(result.finishReason, 'stop');
});

test('Gemini preflight: неизвестная модель/параметры/лимиты/цены не дают started или POST', async () => {
  for (const mutation of ['model', 'endpoints', 'reasoning', 'schema', 'context', 'completion', 'price', 'cache']) {
    const metadata = geminiMetadata(), endpoint = metadata.data.endpoints[0];
    if (mutation === 'model') metadata.data.id = 'other';
    if (mutation === 'endpoints') metadata.data.endpoints = [];
    if (mutation === 'reasoning') endpoint.supported_parameters = endpoint.supported_parameters.filter(p => p !== 'reasoning');
    if (mutation === 'schema') endpoint.supported_parameters = ['temperature', 'max_tokens', 'reasoning'];
    if (mutation === 'context') endpoint.context_length = 1;
    if (mutation === 'completion') endpoint.max_completion_tokens = 1;
    if (mutation === 'price') endpoint.pricing.prompt = '';
    if (mutation === 'cache') Object.assign(endpoint.pricing, { input_cache_write: 'unknown' });
    const upstream = fake({ metadata }), result = await upstream.run(); assert.equal(result.status, 'preflight-failed', mutation);
    assert.equal(upstream.started.length, 0); assert.equal(upstream.sent.length, 0); assert.equal(result.billingState, 'not-sent');
  }
});

test('Gemini SSE: финальный usage повторяет finish, но новый текст/конфликт/обрыв не принимаются', async () => {
  const input = compactBundle(), usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.001 };
  const marker = 'data: ' + JSON.stringify({ choices: [], usage }) + '\r\n\r\n';
  for (const variant of ['accounting', 'no-usage', 'conflict', 'new-content', 'no-done', 'after-done']) {
    const chunk = { id: 'gen-synthetic', choices: [{ index: 0, delta: { role: 'assistant', content: variant === 'new-content' ? 'x' : '' }, finish_reason: variant === 'conflict' ? 'length' : 'stop' }], ...(variant === 'no-usage' ? {} : { usage }) };
    const frame = 'data: ' + JSON.stringify(chunk) + '\r\n\r\n';
    let stream = geminiEvents(input, { usage }); assert.ok(stream.includes(marker)); stream = stream.replace(marker, frame);
    if (variant === 'no-done') stream = stream.replace('data: [DONE]\r\n\r\n', '');
    if (variant === 'after-done') stream += frame;
    const upstream = fake({ response: () => geminiStreamResponse(stream, 3) }), result = await upstream.run();
    assert.equal(result.status, variant === 'accounting' ? 'valid' : 'invalid-output', `${variant}: ${JSON.stringify(result.error)}`);
    assert.equal(upstream.sent.length, 1);
    if (variant !== 'no-usage') { assert.equal(result.usage.costUsd, 0.001); assert.equal(result.billingState, 'known'); }
  }
});

test('Gemini: бюджет, started failure и поздний callback не запускают POST', async () => {
  const low = fake(); assert.equal((await low.run({ maxEstimatedCostUsd: 0.00000001 })).error!.code, 'estimated-cost-exceeded'); assert.equal(low.sent.length, 0);
  const failed = fake({ before: async () => { throw new Error('disk full'); } }); assert.equal((await failed.run()).error!.code, 'before-send-failed'); assert.equal(failed.sent.length, 0);
  const pending = fake({ before: never }); const result = await pending.run({ timeoutMs: 15 }); assert.equal(result.status, 'timed-out'); assert.equal(pending.sent.length, 0);
});

test('Gemini: cooldown, вход и подменённое тело отклоняются до metadata', async () => {
  const upstream = fake(); const result = await upstream.run({ notBefore: new Date(Date.now() + 60000).toISOString() }); assert.equal(result.error!.code, 'cooldown'); assert.equal(upstream.events.length, 0);
  upstream.prepared.body = '{}'; const altered = await upstream.run(); assert.equal(altered.error!.code, 'integrity-error'); assert.equal(upstream.events.length, 0);
  const missing = fake(); missing.dependencies.apiKey = ''; assert.equal((await missing.run()).error!.code, 'missing-key'); assert.equal(missing.events.length, 0);
});

test('Gemini: invalid JSON, неправильная цитата и finish length сохраняют расход без повторов', async () => {
  for (const variant of ['json', 'quote', 'length', 'no-done', 'trailing', 'model']) {
    const input = compactBundle(), answer = geminiAnswer(input); answer.quoteId = 'e999999';
    let text = geminiEvents(input, { ...(variant === 'json' ? { answer: '{oops' } : {}), ...(variant === 'quote' ? { answer } : {}),
      ...(variant === 'length' ? { finish: 'length' } : {}), ...(variant === 'no-done' ? { done: false } : {}), ...(variant === 'trailing' ? { suffix: 'data: {}\n\n' } : {}) });
    if (variant === 'model') text = text.replace('google/gemini-3.8-flash', 'other/model');
    const upstream = fake({ response: () => geminiStreamResponse(text) }), result = await upstream.run();
    assert.equal(result.status, 'invalid-output', `${variant}: ${JSON.stringify(result.error)}`); assert.equal(result.analysis, null); assert.equal(result.usage.costUsd, 0.001); assert.equal(result.billingState, 'known'); assert.equal(upstream.sent.length, 1);
  }
});

test('Gemini: HTTP 400 сохраняет ID заголовка и usage, безопасный класс без сырого сообщения', async () => {
  for (const known of [true, false]) {
    const upstream = fake({ response: () => Response.json({ error: { message: key, metadata: { error_type: 'unmapped' } }, ...(known ? { usage: { cost: 0.002 } } : {}) }, { status: 400, headers: { 'x-generation-id': 'gen-from-header' } }) });
    const result = await upstream.run(); assert.equal(result.status, 'api-error'); assert.equal(result.error!.httpStatus, 400); assert.equal(result.error!.apiType, 'unmapped'); assert.equal(result.generationId, 'gen-from-header');
    assert.equal(result.billingState, known ? 'known' : 'unknown'); assert.equal(result.usage.costUsd, known ? 0.002 : null); assert.ok(!JSON.stringify(result).includes(key)); assert.equal(upstream.sent.length, 1);
  }
  const malformed = fake({ response: () => new Response('not json', { status: 400, headers: { 'x-generation-id': 'gen-header-only' } }) });
  const result = await malformed.run(); assert.equal(result.error!.httpStatus, 400); assert.equal(result.generationId, 'gen-header-only'); assert.equal(result.billingState, 'unknown');
  for (const error of [true, false]) {
    const jsonResponse = fake({ response: () => Response.json({ id: 'gen-unexpected-json', usage: { cost: 0.004 }, ...(error ? { error: { code: 500 } } : { choices: [] }) }) });
    const result = await jsonResponse.run(); assert.equal(result.status, error ? 'api-error' : 'invalid-output'); assert.equal(result.generationId, 'gen-unexpected-json'); assert.equal(result.usage.costUsd, 0.004); assert.equal(result.billingState, 'known'); assert.equal(jsonResponse.sent.length, 1);
  }
});

test('Gemini: SSE ошибка и обрыв сохраняют полученные usage и частичный текст', async () => {
  const initial = 'data: ' + JSON.stringify({ id: 'gen-partial', model: 'google/gemini-3.8-flash', choices: [{ delta: { content: '{partial' } }], usage: { cost: 0.003 } }) + '\n\n';
  for (const variant of ['stream-error', 'timeout', 'read-error']) {
    const upstream = fake({ response: () => {
      if (variant === 'stream-error') return geminiStreamResponse(initial + 'data: {"error":{"code":500}}\n\n');
      let sent = false;
      return new Response(new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(initial)); return; } if (variant === 'read-error') throw new Error('stream ended'); return never(); } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
    const result = await upstream.run({ timeoutMs: 50 }); assert.equal(result.status, variant === 'timeout' ? 'timed-out' : variant === 'stream-error' ? 'api-error' : 'transport-error');
    assert.equal(result.analysis, null); assert.equal(result.generationId, 'gen-partial'); assert.equal(result.content, '{partial'); assert.equal(result.usage.costUsd, 0.003); assert.equal(result.billingState, 'known'); assert.equal(upstream.sent.length, 1);
  }
});

test('Gemini: неизвестный расход не подменяется оценкой или нулём; известный ноль остаётся', async () => {
  for (const cost of [undefined, 0]) {
    const input = compactBundle(), upstream = fake({ response: () => geminiStreamResponse(geminiEvents(input, { usage: { prompt_tokens: 100, ...(cost === undefined ? {} : { cost }) } })) });
    const result = await upstream.run(); assert.equal(result.status, 'valid'); assert.equal(result.usage.costUsd, cost ?? null); assert.equal(result.billingState, cost === 0 ? 'known' : 'unknown');
  }
});

test('Gemini: отражённый ключ в content или ID очищается, reasoning не экспортируется', async () => {
  const input = compactBundle();
  for (const field of ['content', 'id']) {
    const text = field === 'content' ? geminiEvents(input, { answer: key }) : geminiEvents(input).replace('gen-synthetic', key);
    const upstream = fake({ response: () => geminiStreamResponse(text, 3) }), result = await upstream.run();
    assert.equal(result.error!.code, 'secret-in-output'); assert.equal(result.content, null); assert.equal(result.generationId, null); assert.ok(!JSON.stringify(result).includes(key));
  }
  const text = geminiEvents(input).replace('"role":"assistant"', '"reasoning":"secret-thought","role":"assistant"');
  const upstream = fake({ response: () => geminiStreamResponse(text) }); assert.ok(!JSON.stringify(await upstream.run()).includes('secret-thought'));
  const reflectedId = fake({ response: () => Response.json({ id: key, usage: { cost: 0.002 } }, { status: 400 }) });
  const result = await reflectedId.run(); assert.equal(result.error!.code, 'secret-in-output'); assert.equal(result.usage.costUsd, 0.002); assert.equal(result.billingState, 'known'); assert.ok(!JSON.stringify(result).includes(key));
});

test('Gemini: отмена до отправки и после POST не приводит к повтору', async () => {
  const before = fake(), first = new AbortController(); first.abort(); before.dependencies.signal = first.signal;
  assert.equal((await before.run()).status, 'aborted'); assert.equal(before.events.length, 0);
  const controller = new AbortController(), after = fake({ response: () => { controller.abort(); return never(); } }); after.dependencies.signal = controller.signal;
  const result = await after.run(); assert.equal(result.status, 'aborted'); assert.equal(result.billingState, 'unknown'); assert.equal(after.sent.length, 1);
});
