import { performance } from 'node:perf_hooks';
import type { CompactFactsBundle } from '../match-facts/index.js';
import { validateGeminiAnalysis } from './gemini-analysis.js';
import { geminiIdentity, verifyPreparedGeminiAnalysis } from './gemini-prepare.js';
import { geminiApiError, readGeminiMetadata, readGeminiStream } from './gemini-stream.js';
import { abortable } from './run.js';
import { completionUrl, emptyUsage, inspectMetadata, retryAt } from './openrouter.js';
import type { GeminiAttempt, GeminiDependencies, PreparedGeminiAnalysis } from './gemini-types.js';
import { AnalysisError, type AnalyzeOptions } from './types.js';
import { digest, ensure, finite, object, parse, positive, text } from './values.js';

export const geminiMetadataUrl = 'https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints';
export async function analyzeGeminiMatch(prepared: PreparedGeminiAnalysis, input: CompactFactsBundle, options: AnalyzeOptions, dependencies: GeminiDependencies): Promise<GeminiAttempt> {
  const clock = performance.now(), deadline = new AbortController();
  const attempt: GeminiAttempt = { version: 1, attemptId: null, identity: null, status: 'preflight-failed', startedAt: new Date().toISOString(), endedAt: '', elapsedMs: 0, requestSent: false,
    generationId: null, model: null, provider: null, finishReason: null, rates: null, estimatedCostUsd: null, usage: emptyUsage(), billingState: 'not-sent', retryAt: null,
    error: null, analysis: null, content: null, responseDigest: null, firstContentMs: null, streamBytes: 0, responseReceived: false };
  let timer: ReturnType<typeof setTimeout> | undefined, signal = deadline.signal;
  let stage: 'preflight' | 'metadata' | 'callback' | 'post' = 'preflight';
  try {
    ensure(object(dependencies) && text(dependencies.apiKey), 'missing-key'); const key = dependencies.apiKey;
    ensure(object(options) && Object.keys(options).every(key => ['attemptId', 'maxEstimatedCostUsd', 'timeoutMs', 'notBefore'].includes(key)) && typeof options.attemptId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(options.attemptId)
      && finite(options.maxEstimatedCostUsd) && options.maxEstimatedCostUsd > 0, 'invalid-options');
    ensure(typeof dependencies.beforeSend === 'function' && (dependencies.fetcher === undefined || typeof dependencies.fetcher === 'function') && (dependencies.signal === undefined || dependencies.signal instanceof AbortSignal), 'invalid-options');
    const bundle = structuredClone(input), verified = verifyPreparedGeminiAnalysis(prepared, bundle);
    const timeoutMs = options.timeoutMs ?? verified.prompt.profile.timeoutMs; ensure(positive(timeoutMs) && timeoutMs <= 2147483647, 'invalid-options');
    ensure(!JSON.stringify({ verified, options }).includes(key), 'secret-in-input');
    attempt.attemptId = options.attemptId; attempt.identity = geminiIdentity(verified);
    signal = dependencies.signal ? AbortSignal.any([dependencies.signal, deadline.signal]) : deadline.signal; signal.throwIfAborted();
    if (options.notBefore !== undefined) {
      ensure(typeof options.notBefore === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(options.notBefore) && Number.isFinite(Date.parse(options.notBefore)), 'invalid-options');
      if (Date.parse(options.notBefore) > Date.now()) { attempt.retryAt = options.notBefore; throw new AnalysisError('cooldown'); }
    }
    timer = setTimeout(() => deadline.abort(), timeoutMs);
    const fetcher = dependencies.fetcher ?? fetch; stage = 'metadata';
    const metadata = await abortable(() => fetcher(geminiMetadataUrl, { signal, redirect: 'error' }), signal);
    if (!metadata.ok) attempt.retryAt = retryAt(metadata.headers.get('Retry-After'), metadata.status);
    ensure(metadata.ok, 'metadata-unavailable', { httpStatus: metadata.status });
    const rates = inspectMetadata(await abortable(() => metadata.json(), signal), verified);
    ensure(!JSON.stringify(rates).includes(key), 'secret-in-output'); attempt.rates = rates;
    const estimate = verified.estimatedInputTokens * rates.input + verified.prompt.profile.maxTokens * rates.output + rates.request;
    ensure(Number.isFinite(estimate), 'estimated-cost-exceeded'); attempt.estimatedCostUsd = estimate;
    ensure(estimate <= options.maxEstimatedCostUsd, 'estimated-cost-exceeded'); stage = 'callback';
    await abortable(() => dependencies.beforeSend(structuredClone({ ...attempt.identity!, version: 1, attemptId: attempt.attemptId!, status: 'started', startedAt: attempt.startedAt, estimatedCostUsd: estimate, rates })), signal);
    signal.throwIfAborted(); stage = 'post';
    const response = await abortable(() => { attempt.requestSent = true; return fetcher(completionUrl, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'x-session-id': options.attemptId }, body: verified.body, signal, redirect: 'error' }); }, signal);
    attempt.responseReceived = true;
    const headerId = response.headers.get('x-generation-id') ?? response.headers.get('x-openrouter-generation-id');
    if (headerId) readGeminiMetadata({ id: headerId }, attempt, key);
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      attempt.retryAt = retryAt(response.headers.get('Retry-After'), response.status);
      attempt.status = 'api-error'; attempt.error = geminiApiError({}, response.status);
      let payload: unknown; try { payload = await abortable(() => response.json(), signal); } catch (error) { if (signal.aborted) throw error; }
      if (object(payload)) { readGeminiMetadata(payload, attempt, key); attempt.error = geminiApiError(payload, response.status); }
      if (response.ok && (!object(payload) || payload.error == null)) throw new AnalysisError('invalid-output');
    } else {
      await readGeminiStream(response, attempt, key, signal, clock);
      ensure(attempt.model === verified.prompt.profile.model, 'model-mismatch'); ensure(text(attempt.content), 'empty-content');
      const analysis = validateGeminiAnalysis(parse(attempt.content, 'invalid-output'), bundle);
      ensure(analysis.format === verified.responseFormat, 'invalid-output'); attempt.analysis = analysis; attempt.status = 'valid';
    }
  } catch (error) {
    const code = dependencies?.signal?.aborted ? 'aborted' : deadline.signal.aborted ? 'timed-out' : stage === 'callback' ? 'before-send-failed'
      : error instanceof AnalysisError ? error.code : stage === 'metadata' ? 'metadata-unavailable' : stage === 'post' ? 'transport-error' : 'invalid-input';
    attempt.status = code === 'aborted' || code === 'timed-out' ? code : !attempt.requestSent ? 'preflight-failed' : code === 'api-error' ? 'api-error' : code === 'transport-error' ? 'transport-error' : 'invalid-output';
    const httpStatus = error instanceof AnalysisError ? error.details.httpStatus : undefined;
    if (code !== 'api-error' || attempt.error === null) attempt.error = { code, ...(positive(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}) };
    attempt.analysis = null;
    if (code === 'secret-in-output') { attempt.content = null; attempt.generationId = null; attempt.model = null; attempt.provider = null; attempt.finishReason = null; }
  } finally {
    if (timer !== undefined) clearTimeout(timer); attempt.endedAt = new Date().toISOString(); attempt.elapsedMs = performance.now() - clock;
    attempt.responseDigest = attempt.content === null ? null : digest(attempt.content);
    attempt.billingState = !attempt.requestSent ? 'not-sent' : attempt.usage.costUsd === null ? 'unknown' : 'known';
  }
  return attempt;
}
