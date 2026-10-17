import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMatch, analysisClaims, createPromptPackage, prepareAnalysis, type AnalyzeDependencies, type AnalyzeOptions, type Raw, type StartedAttempt } from '../src/match-analysis/index.js';
import { completionUrl, inspectMetadata, metadataUrl } from '../src/match-analysis/openrouter.js';
import { digest } from '../src/match-analysis/values.js';
import { analysis, bundle, metadata, payload, prompt } from './match-analysis-helpers.js';

const key = 'synthetic-key-only-in-memory';
const options: AnalyzeOptions = { attemptId: 'synthetic-attempt', maxEstimatedCostUsd: 1 };
const never = (): Promise<never> => new Promise(() => {});
function fake(input = bundle(), settings: {
  metadata?: unknown; response?: unknown; status?: number; retry?: string; rawResponse?: string;
  onGet?: () => Promise<Response>; onPost?: (init: RequestInit) => Promise<Response>;
} = {}) {
  const sent: RequestInit[] = [], started: StartedAttempt[] = [], events: string[] = [];
  let gets = 0;
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, 'error');
    if (String(url) === metadataUrl) { gets++; events.push('get'); return settings.onGet ? settings.onGet() : Response.json(settings.metadata ?? metadata()); }
    assert.equal(String(url), completionUrl); assert.equal(init?.method, 'POST');
    sent.push(init!); events.push('post');
    if (settings.onPost) return settings.onPost(init!);
    const responseOptions: ResponseInit = { status: settings.status ?? 200, headers: settings.retry ? { 'Retry-After': settings.retry } : {} };
    return settings.rawResponse !== undefined ? new Response(settings.rawResponse, responseOptions) : Response.json(settings.response ?? payload(input), responseOptions);
  };
  const dependencies: AnalyzeDependencies = { apiKey: key, fetcher, beforeSend: async attempt => { events.push('started'); started.push(attempt); } };
  return { dependencies, sent, started, events, get gets() { return gets; } };
}

test('полный путь: стороны, исходы, один/два и отказ; started предшествует точному единственному POST', async () => {
  for (const side of ['radiant', 'dire'] as const) for (const win of [true, false]) for (const kind of ['one', 'two', 'refusal']) {
    const input = bundle(side, win), prepared = prepareAnalysis(input, prompt);
    const answer = analysis(input, input.context.allies.slice(0, kind === 'two' ? 2 : 1).map(player => player.playerSlot));
    if (kind === 'refusal') { answer.status = 'insufficient-evidence'; answer.selectedPlayers = []; answer.comparison = null; answer.closestAlternative = null; }
    const response = payload(input); response.choices[0].message.content = JSON.stringify(answer);
    const upstream = fake(input, { response });
    const result = await analyzeMatch(prepared, input, options, upstream.dependencies);
    assert.equal(result.status, 'valid', JSON.stringify(result.error));
    assert.deepEqual(result.analysis, answer); assert.deepEqual(upstream.events, ['get', 'started', 'post']);
    assert.ok(analysisClaims(result.analysis!).length >= 20);
    assert.equal(upstream.sent.length, 1); assert.equal(upstream.sent[0].body, prepared.body);
    assert.equal(result.identity!.requestDigest, digest(String(upstream.sent[0].body)));
    assert.equal(upstream.started[0].requestDigest, prepared.requestDigest);
    assert.equal(result.billingState, 'known'); assert.equal(result.usage.costUsd, 0.001);
    assert.equal(result.attemptId, options.attemptId); assert.equal(result.identity!.matchId, 101);
    assert.ok(result.elapsedMs >= 0); assert.ok(Date.parse(result.endedAt) >= Date.parse(result.startedAt));
    assert.equal(result.responseDigest, digest(response.choices[0].message.content));
  }
});

test('preflight проверяет каждый достижимый endpoint и максимальные цены без скрытого изменения тела', async () => {
  const input = bundle(), prepared = prepareAnalysis(input, prompt), current = metadata();
  const second = structuredClone(current.data.endpoints[0]);
  second.name = 'second-route'; second.tag = 'deepinfra/other'; second.pricing.prompt = '0.000003';
  current.data.endpoints.push(second);
  const rates = inspectMetadata(current, prepared);
  assert.equal(rates.input, 0.000003);
  for (const change of [
    (m: Raw) => { (m.data as Raw).id = 'other'; },
    (m: Raw) => { (m.data as Raw).endpoints = []; },
    (m: Raw) => { ((m.data as Raw).endpoints as Raw[])[0].supported_parameters = ['temperature']; },
    (m: Raw) => { ((m.data as Raw).endpoints as Raw[])[0].context_length = 1; },
    (m: Raw) => { ((m.data as Raw).endpoints as Raw[])[0].max_completion_tokens = 1; },
    (m: Raw) => { (((m.data as Raw).endpoints as Raw[])[0].pricing as Raw).prompt = null; },
    (m: Raw) => { (((m.data as Raw).endpoints as Raw[])[0].pricing as Raw).completion = '-1'; },
    (m: Raw) => { (((m.data as Raw).endpoints as Raw[])[0].pricing as Raw).input_cache_write = 'unknown'; },
  ]) {
    const modified = structuredClone(current) as Raw; change(modified);
    const upstream = fake(input, { metadata: modified });
    const result = await analyzeMatch(prepared, input, options, upstream.dependencies);
    assert.equal(result.status, 'preflight-failed'); assert.equal(upstream.sent.length, 0); assert.equal(upstream.started.length, 0);
  }
  const unsupported = structuredClone(current); unsupported.data.endpoints.at(-1)!.supported_parameters = [];
  assert.throws(() => inspectMetadata(unsupported, prepared));
  const cache = structuredClone(current) as Raw;
  (((cache.data as Raw).endpoints as Raw[])[0].pricing as Raw).input_cache_write = '0.000005';
  assert.equal(inspectMetadata(cache, prepared).input, 0.000005);
});

test('ключ, опции, мутации и cooldown проверяются до сети; лимит цены — до started/POST', async () => {
  const input = bundle(), prepared = prepareAnalysis(input, prompt);
  for (const modified of [{ ...options, maxEstimatedCostUsd: 0 }, { ...options, maxEstimatedCostUsd: Infinity }, { ...options, timeoutMs: 0 }, { ...options, timeoutMs: 2147483648 }, { ...options, attemptId: '' }, { ...options, notBefore: 'tomorrow' }]) {
    const upstream = fake(input), result = await analyzeMatch(prepared, input, modified, upstream.dependencies);
    assert.equal(result.status, 'preflight-failed'); assert.equal(upstream.gets, 0); assert.equal(upstream.sent.length, 0);
  }
  const missing = fake(input);
  assert.equal((await analyzeMatch(prepared, input, options, { ...missing.dependencies, apiKey: '' })).error!.code, 'missing-key');
  assert.equal(missing.gets, 0);
  const changed = structuredClone(prepared); changed.body += ' ';
  const mutation = fake(input);
  assert.equal((await analyzeMatch(changed, input, options, mutation.dependencies)).status, 'preflight-failed');
  assert.equal(mutation.gets, 0);
  const changedBundle = structuredClone(input); changedBundle.context.matchId++;
  assert.equal((await analyzeMatch(prepared, changedBundle, options, mutation.dependencies)).status, 'preflight-failed');
  assert.equal(mutation.gets, 0);
  const cooldown = fake(input);
  const retry = new Date(Date.now() + 60000).toISOString();
  const cooling = await analyzeMatch(prepared, input, { ...options, notBefore: retry }, cooldown.dependencies);
  assert.equal(cooling.error!.code, 'cooldown'); assert.equal(cooling.retryAt, retry); assert.equal(cooldown.gets, 0);
  const expensive = fake(input);
  const cost = await analyzeMatch(prepared, input, { ...options, maxEstimatedCostUsd: 1e-10 }, expensive.dependencies);
  assert.equal(cost.error!.code, 'estimated-cost-exceeded'); assert.ok(cost.estimatedCostUsd! > 0);
  assert.equal(expensive.gets, 1); assert.equal(expensive.sent.length, 0); assert.equal(expensive.started.length, 0);
});

test('ошибка metadata, отказ/поздний callback и отмена между started/POST не вызывают генерацию', async () => {
  const input = bundle(), prepared = prepareAnalysis(input, prompt);
  for (const onGet of [async () => { throw new Error(key); }, async () => new Response('bad', { status: 503 }), async () => new Response('invalid-json')]) {
    const upstream = fake(input, { onGet });
    const result = await analyzeMatch(prepared, input, options, upstream.dependencies);
    assert.equal(result.error!.code, 'metadata-unavailable'); assert.equal(upstream.sent.length, 0); assert.equal(result.billingState, 'not-sent');
  }
  const limited = fake(input, { onGet: async () => new Response('busy', { status: 429, headers: { 'Retry-After': '120' } }) });
  const retry = await analyzeMatch(prepared, input, options, limited.dependencies);
  assert.equal(retry.error!.httpStatus, 429); assert.ok(Date.parse(retry.retryAt!) > Date.now() + 110000); assert.equal(limited.sent.length, 0);
  const failed = fake(input);
  const failure = await analyzeMatch(prepared, input, options, { ...failed.dependencies, beforeSend: async () => { throw new Error(key); } });
  assert.equal(failure.error!.code, 'before-send-failed'); assert.equal(failed.sent.length, 0);
  assert.ok(!JSON.stringify(failure).includes(key));
  const cancelled = fake(input), abort = new AbortController();
  const result = await analyzeMatch(prepared, input, options, { ...cancelled.dependencies, signal: abort.signal, beforeSend: async attempt => { cancelled.started.push(attempt); abort.abort(); } });
  assert.equal(result.status, 'aborted'); assert.equal(result.requestSent, false); assert.equal(cancelled.started.length, 1); assert.equal(cancelled.sent.length, 0);
  let release: () => void = () => {};
  const late = fake(input);
  const pending = new Promise<void>(resolve => { release = resolve; });
  const timeout = await analyzeMatch(prepared, input, { ...options, timeoutMs: 150 }, { ...late.dependencies, beforeSend: () => pending });
  assert.equal(timeout.status, 'timed-out'); assert.equal(late.sent.length, 0);
  release(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(late.sent.length, 0);
});

test('общий таймаут охватывает metadata, callback, POST и чтение JSON, даже если зависимость игнорирует signal', async () => {
  const input = bundle(), prepared = prepareAnalysis(input, prompt);
  const scenarios = [
    { upstream: fake(input, { onGet: never }), sent: false },
    { upstream: fake(input), callback: never, sent: false },
    { upstream: fake(input, { onPost: never }), sent: true },
    { upstream: fake(input, { onPost: async () => ({ ok: true, status: 200, headers: new Headers(), json: never } as unknown as Response) }), sent: true },
  ];
  for (const scenario of scenarios) {
    const result = await analyzeMatch(prepared, input, { ...options, timeoutMs: 150 }, { ...scenario.upstream.dependencies, ...(scenario.callback ? { beforeSend: scenario.callback } : {}) });
    assert.equal(result.status, 'timed-out'); assert.equal(result.requestSent, scenario.sent);
    assert.equal(result.billingState, scenario.sent ? 'unknown' : 'not-sent');
    assert.ok(result.elapsedMs < 2000);
  }
});

test('отмена до сети и после отправки различает возможный внешний эффект', async () => {
  const input = bundle(), prepared = prepareAnalysis(input, prompt), before = new AbortController(); before.abort();
  const quiet = fake(input);
  const first = await analyzeMatch(prepared, input, options, { ...quiet.dependencies, signal: before.signal });
  assert.equal(first.status, 'aborted'); assert.equal(quiet.gets, 0); assert.equal(first.requestSent, false);
  const after = new AbortController();
  const upstream = fake(input, { onPost: async () => { after.abort(); return never(); } });
  const result = await analyzeMatch(prepared, input, options, { ...upstream.dependencies, signal: after.signal });
  assert.equal(result.status, 'aborted'); assert.equal(result.requestSent, true); assert.equal(result.billingState, 'unknown'); assert.equal(upstream.sent.length, 1);
});

test('ошибки HTTP/тела/choice сохраняют расходы, не выдавая анализ и не повторяя POST', async () => {
  const input = bundle(), prepared = prepareAnalysis(input, prompt);
  for (const status of [400, 401, 402, 403, 408, 429, 500, 502, 503]) {
    const upstream = fake(input, { status });
    const result = await analyzeMatch(prepared, input, options, upstream.dependencies);
    assert.equal(result.status, 'api-error'); assert.equal(result.error!.httpStatus, status);
    assert.equal(result.usage.costUsd, 0.001); assert.equal(result.analysis, null); assert.equal(upstream.sent.length, 1);
    if ([429, 503].includes(status)) assert.ok(Date.parse(result.retryAt!) > Date.now());
  }
  for (const where of ['top', 'choice']) {
    const response = payload(input) as Raw;
    const failure = { code: 429, message: key, metadata: { error_type: 'rate_limit_exceeded', private: key } };
    if (where === 'top') response.error = failure;
    else (response.choices as Raw[])[0].error = failure;
    const upstream = fake(input, { response });
    const result = await analyzeMatch(prepared, input, options, upstream.dependencies);
    assert.equal(result.status, 'api-error'); assert.equal(result.error!.apiType, 'rate_limit_exceeded'); assert.equal(result.analysis, null);
    assert.ok(!JSON.stringify(result).includes(key));
  }
});

test('неполный/чужой/невалидный ответ и неправильные ссылки не исправляются', async () => {
  const input = bundle(), prepared = prepareAnalysis(input, prompt);
  const cases: ((p: Raw) => void)[] = [
    p => { p.model = 'other'; }, p => { delete p.model; }, p => { p.choices = []; },
    p => { (p.choices as Raw[])[0].finish_reason = 'length'; },
    p => { ((p.choices as Raw[])[0].message as Raw).refusal = 'refused'; },
    p => { ((p.choices as Raw[])[0].message as Raw).role = 'tool'; },
    p => { ((p.choices as Raw[])[0].message as Raw).tool_calls = [{}]; },
    p => { ((p.choices as Raw[])[0].message as Raw).content = ''; },
    p => { ((p.choices as Raw[])[0].message as Raw).content = '```json\n{}\n```'; },
    p => { ((p.choices as Raw[])[0].message as Raw).content = '{broken'; },
    p => { const answer = analysis(input); answer.comparison!.evidenceIds = ['e9999999']; ((p.choices as Raw[])[0].message as Raw).content = JSON.stringify(answer); },
    p => { const answer = analysis(input); Object.assign(answer, { version: 2 }); ((p.choices as Raw[])[0].message as Raw).content = JSON.stringify(answer); },
  ];
  for (const change of cases) {
    const response = payload(input) as Raw; change(response);
    const upstream = fake(input, { response });
    const result = await analyzeMatch(prepared, input, options, upstream.dependencies);
    assert.equal(result.status, 'invalid-output', JSON.stringify(result.error)); assert.equal(result.analysis, null);
    assert.equal(result.usage.costUsd, 0.001); assert.equal(upstream.sent.length, 1);
  }
  for (const status of [200, 503]) {
    const upstream = fake(input, { rawResponse: 'not json', status });
    const result = await analyzeMatch(prepared, input, options, upstream.dependencies);
    assert.equal(result.status, status === 200 ? 'invalid-output' : 'api-error'); assert.equal(result.billingState, 'unknown');
  }
  const broken = fake(input, { onPost: async () => { throw new Error(key); } });
  const result = await analyzeMatch(prepared, input, options, broken.dependencies);
  assert.equal(result.status, 'transport-error'); assert.equal(result.requestSent, true); assert.ok(!JSON.stringify(result).includes(key));
});

test('usage принимает только независимые известные значения; отсутствие provider не выдумывается', async () => {
  const input = bundle(), prepared = prepareAnalysis(input, prompt);
  const response = payload(input) as Raw; delete response.provider;
  response.usage = { prompt_tokens: 0, completion_tokens: '20', total_tokens: -1, completion_tokens_details: { reasoning_tokens: 3 }, prompt_tokens_details: { cached_tokens: 0 }, cost: 0 };
  const upstream = fake(input, { response });
  const result = await analyzeMatch(prepared, input, options, upstream.dependencies);
  assert.equal(result.status, 'valid'); assert.equal(result.provider, null); assert.equal(result.billingState, 'known');
  assert.deepEqual(result.usage, { promptTokens: 0, completionTokens: null, totalTokens: null, reasoningTokens: 3, cachedTokens: 0, costUsd: 0 });
  delete response.usage;
  const unknown = await analyzeMatch(prepared, input, options, fake(input, { response }).dependencies);
  assert.equal(unknown.status, 'valid'); assert.equal(unknown.billingState, 'unknown'); assert.equal(unknown.usage.costUsd, null);
});

test('Retry-After: секунды, HTTP date и невалидный заголовок; никакого ожидания/повтора', async () => {
  const input = bundle(), prepared = prepareAnalysis(input, prompt);
  for (const retry of ['120', new Date(Date.now() + 120000).toUTCString(), 'invalid', '-1', 'Infinity']) {
    const upstream = fake(input, { status: 429, retry });
    const result = await analyzeMatch(prepared, input, options, upstream.dependencies);
    assert.equal(result.status, 'api-error'); assert.ok(Date.parse(result.retryAt!) > Date.now() + 50000);
    assert.equal(upstream.sent.length, 1);
  }
});

test('секреты в content/ID/model/provider не экспортируются; reasoning/headers/metadata исключены', async () => {
  const input = bundle(), prepared = prepareAnalysis(input, prompt);
  for (const field of ['content', 'id', 'model', 'provider', 'finish_reason']) {
    const response = payload(input) as Raw;
    if (field === 'content') ((response.choices as Raw[])[0].message as Raw).content = key;
    else if (field === 'finish_reason') (response.choices as Raw[])[0].finish_reason = key;
    else response[field] = key;
    const result = await analyzeMatch(prepared, input, options, fake(input, { response }).dependencies);
    assert.equal(result.error!.code, 'secret-in-output'); assert.equal(result.content, null); assert.equal(result.analysis, null);
    assert.equal(result.usage.costUsd, 0.001); assert.ok(!JSON.stringify(result).includes(key));
  }
  const response = payload(input) as Raw;
  ((response.choices as Raw[])[0].message as Raw).reasoning = key; response.openrouter_metadata = { secret: key };
  const upstream = fake(input, { response });
  const result = await analyzeMatch(prepared, input, options, upstream.dependencies);
  assert.equal(result.status, 'valid'); assert.ok(!JSON.stringify(result).includes(key)); assert.ok(!JSON.stringify(upstream.started).includes(key));
  const badPrompt = createPromptPackage({ ...prompt.files, 'instruction.md': prompt.files['instruction.md'] + key });
  const secretPrepared = prepareAnalysis(input, badPrompt), quiet = fake(input);
  const denied = await analyzeMatch(secretPrepared, input, options, quiet.dependencies);
  assert.equal(denied.error!.code, 'secret-in-input'); assert.equal(quiet.gets, 0); assert.ok(!JSON.stringify(denied).includes(key));
});

test('потеря итоговой записи оставляет started; новая явная попытка имеет свой ID и тот же digest', async () => {
  const input = bundle(), prepared = prepareAnalysis(input, prompt), upstream = fake(input);
  await analyzeMatch(prepared, input, options, upstream.dependencies);
  assert.equal(upstream.started[0].status, 'started'); assert.equal(upstream.sent.length, 1);
  const next = await analyzeMatch(prepared, input, { ...options, attemptId: 'synthetic-next' }, upstream.dependencies);
  assert.equal(upstream.started.length, 2); assert.equal(upstream.sent.length, 2);
  assert.equal(next.attemptId, 'synthetic-next'); assert.equal(next.identity!.requestDigest, upstream.started[0].requestDigest);
});
