import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { validateAnalysis, validateProfile } from './context.js';
import { atomicWrite, check, digest, json, LabError, newDirectory, nonnegative, now, object, parse, positiveInt, readJson, version, within } from './files.js';
import { loadPlan } from './prepare.js';
import type { Attempt, Context, Profile, Raw, RequestEntry } from './types.js';

export const completionUrl = 'https://openrouter.ai/api/v1/chat/completions';
export const metadataUrl = 'https://openrouter.ai/api/v1/models/xiaomi/mimo-v2.6-pro/endpoints';
export const emptyUsage = (): Attempt['usage'] => ({ promptTokens: null, completionTokens: null, totalTokens: null, reasoningTokens: null, cachedTokens: null, costUsd: null });

export async function history(root: string): Promise<Attempt[]> {
  let names: string[];
  try { names = await readdir(join(root, 'runs')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const attempts: Attempt[] = [];
  for (const name of names) {
    const path = within(root, `runs/${name}`);
    for (const file of await readdir(path)) if (/^attempt-\d+\.json$/.test(file)) {
      const attempt = version(await readJson(join(path, file))) as unknown as Attempt;
      check(attempt.runId === name && Number.isSafeInteger(attempt.index) && typeof attempt.status === 'string', 'Некорректная запись попытки.');
      attempts.push(attempt);
    }
  }
  return attempts.sort((a, b) => a.runId.localeCompare(b.runId) || a.index - b.index);
}

function price(value: unknown): number {
  check((typeof value === 'string' && value.trim() !== '') || typeof value === 'number', 'Неизвестный тариф endpoint.', 'unknown-price');
  const amount = Number(value);
  check(nonnegative(amount), 'Неизвестный тариф endpoint.', 'unknown-price');
  return amount;
}

export function inspectMetadata(input: unknown, profile: Profile, requests: RequestEntry[]): { input: number; output: number; request: number; endpointNames: string[] } {
  const data = object(object(input).data);
  check(data.id === profile.model && Array.isArray(data.endpoints), 'Нет метаданных согласованной модели.', 'metadata-unavailable');
  const allowed = profile.provider.only?.map(name => name.toLowerCase());
  const endpoints = data.endpoints.map(object).filter(endpoint => {
    const name = String(endpoint.provider_name).toLowerCase();
    const tag = String(endpoint.tag).toLowerCase();
    return (!allowed || allowed.some(value => name === value || tag === value || tag.split('/')[0] === value));
  });
  check(endpoints.length > 0, 'Нет endpoint выбранного маршрута.', 'unsupported-endpoint');
  const qualified = endpoints.filter(endpoint => ['temperature', 'max_tokens', 'response_format', 'structured_outputs'].every(parameter => Array.isArray(endpoint.supported_parameters) && endpoint.supported_parameters.includes(parameter)));
  check(qualified.length > 0, 'Маршрут не подтверждает strict structured output и параметры профиля.', 'unsupported-endpoint');
  const rates = qualified.map(endpoint => {
    check(nonnegative(endpoint.context_length) && requests.every(request => request.estimatedInputTokens + profile.maxTokens <= Number(endpoint.context_length)), 'context-too-large: предел контекста endpoint.', 'context-too-large');
    check(endpoint.max_prompt_tokens == null || (nonnegative(endpoint.max_prompt_tokens) && requests.every(request => request.estimatedInputTokens <= Number(endpoint.max_prompt_tokens))), 'context-too-large: предел входа endpoint.', 'context-too-large');
    check(endpoint.max_completion_tokens == null || (nonnegative(endpoint.max_completion_tokens) && profile.maxTokens <= endpoint.max_completion_tokens), 'Выход превышает предел endpoint.', 'context-too-large');
    const pricing = object(endpoint.pricing);
    return {
      input: Math.max(price(pricing.prompt), ...['input_cache_read', 'input_cache_write'].filter(key => pricing[key] != null).map(key => price(pricing[key]))),
      output: price(pricing.completion), request: pricing.request == null ? 0 : price(pricing.request), name: String(endpoint.name),
    };
  });
  return { input: Math.max(...rates.map(rate => rate.input)), output: Math.max(...rates.map(rate => rate.output)), request: Math.max(...rates.map(rate => rate.request)), endpointNames: rates.map(rate => rate.name) };
}

function retryAfter(value: string | null): string {
  const number = value === null || value.trim() === '' ? NaN : Number(value);
  const target = Number.isFinite(number) && number >= 0 ? Date.now() + number * 1000 : Date.parse(value ?? '');
  return new Date(Number.isFinite(target) ? Math.max(Date.now(), target) : Date.now() + 60000).toISOString();
}

function usageOf(value: unknown): Attempt['usage'] {
  const usage = value && typeof value === 'object' ? value as Raw : {};
  const count = (value: unknown): number | null => nonnegative(value) && Number.isSafeInteger(value) ? value : null;
  const promptDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object' ? usage.prompt_tokens_details as Raw : {};
  const completionDetails = usage.completion_tokens_details && typeof usage.completion_tokens_details === 'object' ? usage.completion_tokens_details as Raw : {};
  return {
    promptTokens: count(usage.prompt_tokens), completionTokens: count(usage.completion_tokens), totalTokens: count(usage.total_tokens),
    reasoningTokens: count(completionDetails.reasoning_tokens), cachedTokens: count(promptDetails.cached_tokens), costUsd: nonnegative(usage.cost) ? usage.cost : null,
  };
}

export interface RunOptions {
  root: string;
  planPath: string;
  budgetUsd: number;
  maxRequests?: number;
  timeoutMs?: number;
  reserveUnknownUsd?: number;
  reconciliation?: string;
  signal?: AbortSignal;
}

export async function run(options: RunOptions, dependencies: { fetcher?: typeof fetch; apiKey?: string } = {}): Promise<{ path: string; runId: string; sent: number; stopReason: string }> {
  const key = dependencies.apiKey ?? process.env.OPENROUTER_API_KEY;
  check(typeof key === 'string' && key.trim().length > 0, 'Задайте OPENROUTER_API_KEY в окружении.', 'missing-key');
  check(nonnegative(options.budgetUsd) && options.budgetUsd > 0, 'Нужен положительный budgetUsd.');
  const maxRequests = options.maxRequests ?? 6;
  const timeoutMs = options.timeoutMs ?? 180000;
  check(positiveInt(maxRequests) && positiveInt(timeoutMs), 'Нужны положительные maxRequests и timeoutMs.');
  check(options.reserveUnknownUsd === undefined || nonnegative(options.reserveUnknownUsd), 'Некорректный резерв.');
  const plan = await loadPlan(options.planPath);
  const profile = validateProfile(await readJson(join(options.planPath, 'package/profile.json')));
  const schema = object(await readJson(join(options.planPath, 'package/response.schema.json')));
  const previous = await history(options.root);
  const cooldown = previous.map(attempt => Date.parse(attempt.retryAt ?? '')).filter(Number.isFinite);
  check(!cooldown.some(target => target > Date.now()), 'Сохранённый Retry-After ещё действует.', 'cooldown');
  const corrections = new Map<string, number>();
  if (options.reconciliation) {
    const reconciliation = version(await readJson(options.reconciliation));
    check(Array.isArray(reconciliation.entries), 'Некорректная сверка расходов.');
    for (const item of reconciliation.entries) {
      const entry = object(item);
      check(typeof entry.runId === 'string' && Number.isSafeInteger(entry.index) && nonnegative(entry.costUsd) && typeof entry.generationId === 'string' && entry.source === 'openrouter-generation', 'Сверке нужны generation ID, стоимость и источник openrouter-generation.');
      const attempt = previous.find(attempt => attempt.runId === entry.runId && attempt.index === entry.index);
      check(attempt && attempt.generationId === entry.generationId, 'Сверка ссылается на другую генерацию.');
      corrections.set(`${entry.runId}/${entry.index}`, entry.costUsd);
    }
  }
  const unknown = previous.filter(attempt => attempt.usage.costUsd === null && !corrections.has(`${attempt.runId}/${attempt.index}`));
  check(!unknown.length || (options.reserveUnknownUsd !== undefined && options.reserveUnknownUsd > 0), 'Есть попытки с неизвестной стоимостью; нужна сверка или явный резерв на каждую.', 'unknown-cost');
  const reservedUsd = unknown.length * (options.reserveUnknownUsd ?? 0);
  const reconciledUsd = [...corrections.values()].reduce((sum, cost) => sum + cost, 0);
  check(reservedUsd + reconciledUsd < options.budgetUsd, 'Резерв и сверка исчерпывают бюджет.', 'budget-exceeded');
  const fetcher = dependencies.fetcher ?? fetch;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  signal.throwIfAborted();
  let metadata: unknown;
  try {
    const response = await fetcher(metadataUrl, { signal, redirect: 'error' });
    check(response.ok, 'Метаданные OpenRouter недоступны.', 'metadata-unavailable');
    metadata = await response.json();
  } catch (error) {
    if (error instanceof LabError) throw error;
    throw new LabError('metadata-unavailable', 'Не удалось получить метаданные OpenRouter. Платных запросов нет.');
  }
  const rates = inspectMetadata(metadata, profile, plan.requests);
  const directory = await newDirectory(options.root, 'runs');
  const redact = (text: string): string => text.split(key).join('[REDACTED]');
  await atomicWrite(join(directory.path, 'metadata.json'), redact(json({ retrievedAt: now(), source: metadataUrl, response: metadata, rates, estimation: plan.tokenEstimation, note: 'UTF-8 bytes / 2 + max_tokens; conservative heuristic, not a tokenizer or billing guarantee' })));
  const summary = {
    version: 1, runId: directory.name, planId: plan.planId, createdAt: now(), budgetUsd: options.budgetUsd, maxRequests, timeoutMs,
    reservedUsd, reconciledUsd, priorUnknownAttempts: unknown.map(attempt => ({ runId: attempt.runId, index: attempt.index })),
    corrections: Object.fromEntries(corrections), knownCostUsd: 0, sent: 0, stopReason: 'completed',
  };
  await atomicWrite(join(directory.path, 'run.json'), json(summary));
  for (const request of plan.requests) {
    if (summary.sent >= maxRequests) { summary.stopReason = 'max-requests'; break; }
    if (options.signal?.aborted) { summary.stopReason = 'aborted'; break; }
    const estimate = request.estimatedInputTokens * rates.input + profile.maxTokens * rates.output + rates.request;
    if (summary.knownCostUsd + reservedUsd + reconciledUsd + estimate > options.budgetUsd) { summary.stopReason = 'budget-exceeded'; break; }
    const body = await readFile(within(options.planPath, request.request), 'utf8');
    const parsedBody = object(parse(body));
    check(parsedBody.model === profile.model && parsedBody.stream === false && !parsedBody.models && !parsedBody.tools && parsedBody.max_tokens === profile.maxTokens && parsedBody.temperature === profile.temperature && json(parsedBody.provider) === json(profile.provider), 'План содержит неподдержанный запрос.');
    check(!body.includes(key), 'Запрос содержит значение ключа.');
    const attempt: Attempt = {
      version: 1, runId: directory.name, planId: plan.planId, index: request.index, requestDigest: request.requestDigest,
      startedAt: now(), endedAt: null, elapsedMs: null, status: 'started', generationId: null, model: null, provider: null,
      finishReason: null, content: null, responseDigest: null, usage: emptyUsage(), error: null, retryAt: null,
    };
    const path = join(directory.path, `attempt-${request.index}.json`);
    await atomicWrite(path, json(attempt));
    const started = performance.now();
    summary.sent++;
    const deadline = AbortSignal.timeout(timeoutMs);
    const attemptSignal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    try {
      const response = await fetcher(completionUrl, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body,
        signal: attemptSignal, redirect: 'error',
      });
      if (response.status === 429) attempt.retryAt = retryAfter(response.headers.get('Retry-After'));
      let payload: Raw = {};
      try { payload = object(await response.json()); } catch { attempt.error = 'invalid-response-json'; }
      attempt.usage = usageOf(payload.usage);
      const safeString = (value: unknown): string | null => typeof value === 'string' ? redact(value) : null;
      attempt.generationId = safeString(payload.id);
      attempt.model = safeString(payload.model);
      attempt.provider = safeString(payload.provider);
      if (!response.ok || payload.error) {
        attempt.status = 'api-error';
        attempt.error = `http-${response.status}${payload.error ? '-api-error' : ''}`;
      } else {
        attempt.status = 'invalid-output';
        const choice = Array.isArray(payload.choices) && payload.choices[0] && typeof payload.choices[0] === 'object' ? payload.choices[0] as Raw : {};
        const message = choice.message && typeof choice.message === 'object' ? choice.message as Raw : {};
        attempt.finishReason = safeString(choice.finish_reason);
        attempt.content = safeString(message.content);
        attempt.responseDigest = attempt.content === null ? null : digest(attempt.content);
        if (!attempt.error && attempt.model !== profile.model) attempt.error = 'model-mismatch';
        else if (!attempt.error && (attempt.finishReason !== 'stop' || message.refusal)) attempt.error = 'unfinished-or-filtered';
        else if (!attempt.error && !attempt.content?.trim()) attempt.error = 'empty-content';
        if (!attempt.error) {
          const context = await readJson(within(options.planPath, request.context)) as Context;
          try { validateAnalysis(parse(attempt.content!), context, schema); attempt.status = 'valid'; }
          catch { attempt.error = 'invalid-analysis-v1'; }
        }
      }
    } catch {
      attempt.status = options.signal?.aborted ? 'aborted' : deadline.aborted ? 'timed-out' : 'transport-error';
      attempt.error = attempt.status;
    }
    attempt.endedAt = now();
    attempt.elapsedMs = performance.now() - started;
    await atomicWrite(path, redact(json(attempt)), true);
    if (attempt.usage.costUsd !== null) summary.knownCostUsd += attempt.usage.costUsd;
    summary.stopReason = attempt.usage.costUsd === null ? 'unknown-cost' : attempt.status === 'valid' ? 'completed' : attempt.status;
    await atomicWrite(join(directory.path, 'run.json'), json(summary), true);
    if (summary.stopReason !== 'completed') break;
  }
  await atomicWrite(join(directory.path, 'run.json'), json(summary), true);
  return { path: directory.path, runId: directory.name, sent: summary.sent, stopReason: summary.stopReason };
}
