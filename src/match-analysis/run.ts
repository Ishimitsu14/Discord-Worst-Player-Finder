import { performance } from 'node:perf_hooks';
import { validateMatchAnalysis } from './analysis.js';
import { completionUrl, emptyUsage, inspectMetadata, metadataUrl, retryAt, usageOf } from './openrouter.js';
import { analysisIdentity, verifyPreparedAnalysis } from './prepare.js';
import { AnalysisError, type AnalysisAttempt, type AnalyzeDependencies, type AnalyzeOptions, type AttemptError, type FactsBundle, type PreparedAnalysis, type Raw } from './types.js';
import { digest, ensure, finite, object, parse, positive, text } from './values.js';

function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

const apiTypes = new Set(['context_length_exceeded', 'max_tokens_exceeded', 'token_limit_exceeded', 'string_too_long', 'authentication', 'rate_limit_exceeded', 'provider_overloaded', 'provider_unavailable', 'content_policy_violation', 'refusal', 'server', 'timeout', 'unmapped']);

function readResponse(payload: unknown, response: Response, attempt: AnalysisAttempt, prepared: PreparedAnalysis, bundle: FactsBundle, key: string): void {
  const data = object(payload) ? payload : {};
  attempt.usage = usageOf(data.usage);
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const choice = object(choices[0]) ? choices[0] : {};
  const message = object(choice.message) ? choice.message : {};
  const strings = { generationId: data.id, model: data.model, provider: data.provider, finishReason: choice.finish_reason, content: message.content };
  ensure(!Object.values(strings).some(value => typeof value === 'string' && value.includes(key)), 'secret-in-output');
  const string = (value: unknown): string | null => typeof value === 'string' ? value : null;
  attempt.generationId = string(strings.generationId); attempt.model = string(strings.model); attempt.provider = string(strings.provider);
  attempt.finishReason = string(strings.finishReason); attempt.content = string(strings.content);
  attempt.responseDigest = attempt.content === null ? null : digest(attempt.content);
  if (!response.ok || data.error != null || choice.error != null) {
    const error = object(data.error) ? data.error : object(choice.error) ? choice.error : {};
    const metadata = object(error.metadata) ? error.metadata : {};
    const apiType = typeof metadata.error_type === 'string' && apiTypes.has(metadata.error_type) ? metadata.error_type : undefined;
    attempt.status = 'api-error'; attempt.error = { code: 'api-error', httpStatus: response.status, ...(apiType ? { apiType } : {}) };
    return;
  }
  ensure(attempt.model === prepared.prompt.profile.model, 'model-mismatch');
  ensure(choices.length === 1 && message.role === 'assistant' && attempt.finishReason === 'stop' && message.refusal == null && message.function_call == null && (message.tool_calls == null || Array.isArray(message.tool_calls) && message.tool_calls.length === 0), 'unfinished-or-filtered');
  ensure(text(attempt.content), 'empty-content');
  attempt.analysis = validateMatchAnalysis(parse(attempt.content, 'invalid-output'), bundle);
  attempt.status = 'valid';
}

export async function analyzeMatch(prepared: PreparedAnalysis, input: FactsBundle, options: AnalyzeOptions, dependencies: AnalyzeDependencies): Promise<AnalysisAttempt> {
  const clock = performance.now();
  const attempt: AnalysisAttempt = {
    version: 1, attemptId: null, identity: null, status: 'preflight-failed', startedAt: new Date().toISOString(), endedAt: '', elapsedMs: 0, requestSent: false,
    generationId: null, model: null, provider: null, finishReason: null, rates: null, estimatedCostUsd: null,
    usage: emptyUsage(), billingState: 'not-sent', retryAt: null, error: null, analysis: null, content: null, responseDigest: null,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new AbortController();
  let signal: AbortSignal = deadline.signal;
  let stage: 'preflight' | 'metadata' | 'callback' | 'post' = 'preflight';
  try {
    ensure(object(dependencies) && text(dependencies.apiKey), 'missing-key');
    const key = dependencies.apiKey;
    ensure(object(options) && Object.keys(options).every(name => ['attemptId', 'maxEstimatedCostUsd', 'timeoutMs', 'notBefore'].includes(name)) && typeof options.attemptId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(options.attemptId) && finite(options.maxEstimatedCostUsd) && options.maxEstimatedCostUsd > 0, 'invalid-options');
    ensure(typeof dependencies.beforeSend === 'function' && (dependencies.fetcher === undefined || typeof dependencies.fetcher === 'function') && (dependencies.signal === undefined || dependencies.signal instanceof AbortSignal), 'invalid-options');
    const timeoutMs = options.timeoutMs ?? 180000;
    const maxEstimatedCostUsd = options.maxEstimatedCostUsd;
    ensure(positive(timeoutMs) && timeoutMs <= 2147483647, 'invalid-options');
    const bundle = structuredClone(input);
    const verified = verifyPreparedAnalysis(prepared, bundle);
    ensure(!JSON.stringify({ verified, options }).includes(key), 'secret-in-input');
    attempt.attemptId = options.attemptId;
    attempt.identity = analysisIdentity(verified);
    signal = dependencies.signal ? AbortSignal.any([deadline.signal, dependencies.signal]) : deadline.signal;
    signal.throwIfAborted();
    if (options.notBefore !== undefined) {
      ensure(typeof options.notBefore === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(options.notBefore) && Number.isFinite(Date.parse(options.notBefore)), 'invalid-options');
      if (Date.parse(options.notBefore) > Date.now()) { attempt.retryAt = options.notBefore; throw new AnalysisError('cooldown'); }
    }
    timer = setTimeout(() => deadline.abort(), timeoutMs);
    const fetcher = dependencies.fetcher ?? fetch;
    stage = 'metadata';
    const metadataResponse = await abortable(() => fetcher(metadataUrl, { signal, redirect: 'error' }), signal);
    if (!metadataResponse.ok) attempt.retryAt = retryAt(metadataResponse.headers.get('Retry-After'), metadataResponse.status);
    ensure(metadataResponse.ok, 'metadata-unavailable', { httpStatus: metadataResponse.status });
    const rates = inspectMetadata(await abortable(() => metadataResponse.json(), signal), verified);
    ensure(!JSON.stringify(rates).includes(key), 'secret-in-output');
    attempt.rates = rates;
    const estimate = verified.estimatedInputTokens * rates.input + verified.prompt.profile.maxTokens * rates.output + rates.request;
    ensure(Number.isFinite(estimate), 'estimated-cost-exceeded');
    attempt.estimatedCostUsd = estimate;
    ensure(estimate <= maxEstimatedCostUsd, 'estimated-cost-exceeded');
    stage = 'callback';
    await abortable(() => dependencies.beforeSend(structuredClone({
      ...attempt.identity!, version: 1, attemptId: attempt.attemptId!, status: 'started', startedAt: attempt.startedAt,
      rates, estimatedCostUsd: attempt.estimatedCostUsd!,
    })), signal);
    signal.throwIfAborted();
    stage = 'post';
    const response = await abortable(() => {
      attempt.requestSent = true;
      return fetcher(completionUrl, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: verified.body, signal, redirect: 'error' });
    }, signal);
    if (!response.ok) attempt.retryAt = retryAt(response.headers.get('Retry-After'), response.status);
    let payload: unknown;
    try { payload = await abortable(() => response.json(), signal); }
    catch (error) {
      if (signal.aborted) throw error;
      if (!response.ok) { attempt.status = 'api-error'; attempt.error = { code: 'api-error', httpStatus: response.status }; }
      else throw new AnalysisError('invalid-output');
    }
    if (payload !== undefined) {
      readResponse(payload, response, attempt, verified, bundle, key);
      if (attempt.status === 'api-error' && attempt.retryAt === null) attempt.retryAt = retryAt(response.headers.get('Retry-After'), response.status);
    }
  } catch (error) {
    const code = dependencies?.signal?.aborted ? 'aborted' : deadline.signal.aborted ? 'timed-out'
      : stage === 'callback' ? 'before-send-failed' : error instanceof AnalysisError ? error.code : stage === 'metadata' ? 'metadata-unavailable' : stage === 'post' ? 'transport-error' : 'invalid-input';
    attempt.status = code === 'aborted' || code === 'timed-out' ? code : attempt.requestSent ? code === 'transport-error' ? 'transport-error' : 'invalid-output' : 'preflight-failed';
    const httpStatus = error instanceof AnalysisError ? error.details.httpStatus : undefined;
    const failure: AttemptError = { code, ...(positive(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}) };
    attempt.error = failure;
    attempt.analysis = null;
    if (code === 'secret-in-output') { attempt.content = null; attempt.responseDigest = null; attempt.generationId = null; attempt.model = null; attempt.provider = null; attempt.finishReason = null; }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    attempt.endedAt = new Date().toISOString();
    attempt.elapsedMs = performance.now() - clock;
    attempt.billingState = !attempt.requestSent ? 'not-sent' : attempt.usage.costUsd === null ? 'unknown' : 'known';
  }
  return attempt;
}
