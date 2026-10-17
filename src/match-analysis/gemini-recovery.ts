import { setTimeout as pause } from 'node:timers/promises';
import type { GeminiAttempt, GeminiRecovery, GeminiRecoveryDependencies, PreparedGeminiAnalysis } from './gemini-types.js';
import { geminiIdentity } from './gemini-prepare.js';
import { abortable } from './run.js';
import { canonical, ensure, finite, object, text } from './values.js';

export async function checkGeminiRecovery(prepared: PreparedGeminiAnalysis, attempt: GeminiAttempt, dependencies: GeminiRecoveryDependencies): Promise<GeminiRecovery> {
  const result: GeminiRecovery = { version: 1, attemptId: attempt.attemptId, requestDigest: prepared.requestDigest, status: 'not-eligible', reason: null, checks: [], costUsd: null, reserveUsd: 0 };
  if (!attempt.requestSent || attempt.responseReceived !== false || !['transport-error', 'timed-out'].includes(attempt.status)
    || attempt.generationId !== null || attempt.content !== null || attempt.streamBytes !== 0 || Object.values(attempt.usage).some(value => value !== null)) return result;
  const signal = dependencies.signal ?? new AbortController().signal, fetcher = dependencies.fetcher ?? fetch;
  let failedHttpStatus: number | null = null;
  const wait = dependencies.wait ?? ((milliseconds, signal) => pause(milliseconds, undefined, { signal }));
  const request = async (url: string, body?: unknown): Promise<unknown> => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
    const response = await abortable(() => fetcher(url, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${dependencies.managementKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: deadline, redirect: 'error' }), deadline);
    if (!response.ok) failedHttpStatus = response.status;
    ensure(response.ok, 'metadata-unavailable'); return abortable(() => response.json(), deadline);
  };
  try {
    ensure(text(dependencies.managementKey) && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(attempt.attemptId ?? ''), 'invalid-options');
    ensure(canonical(attempt.identity) === canonical(geminiIdentity(prepared)), 'integrity-error');
    ensure(!JSON.stringify({ prepared, attempt }).includes(dependencies.managementKey), 'secret-in-input');
    ensure(finite(attempt.estimatedCostUsd) && attempt.estimatedCostUsd > 0 && Number.isFinite(Date.parse(attempt.startedAt)) && Number.isFinite(Date.parse(attempt.endedAt)), 'invalid-input');
    for (const milliseconds of [10000, 20000, 30000]) {
      await abortable(() => wait(milliseconds, signal), signal);
      const checkedAt = new Date((dependencies.now ?? Date.now)()).toISOString();
      const payload = await request('https://openrouter.ai/api/v1/analytics/query', { metrics: ['request_count', 'total_usage'], dimensions: ['generation_id', 'session_id'],
        time_range: { start: new Date(Date.parse(attempt.startedAt) - 60000).toISOString(), end: checkedAt },
        filters: [{ field: 'session_id', operator: 'eq', value: attempt.attemptId }], limit: 2 });
      ensure(object(payload) && object(payload.data), 'invalid-output'); const data = payload.data;
      ensure(Array.isArray(data.data) && data.data.length <= 2 && object(data.metadata) && data.metadata.truncated === false && data.metadata.row_count === data.data.length, 'invalid-output');
      ensure(data.warnings === undefined || Array.isArray(data.warnings) && data.warnings.length === 0, 'invalid-output');
      ensure(data.cachedAt === undefined || finite(data.cachedAt) && data.cachedAt >= Date.parse(attempt.endedAt), 'invalid-output');
      const generationIds = data.data.map(row => {
        ensure(object(row) && row.session_id === attempt.attemptId && typeof row.generation_id === 'string' && /^gen-[a-zA-Z0-9-]{1,124}$/.test(row.generation_id)
          && finite(row.total_usage) && row.total_usage >= 0 && Number.isSafeInteger(Number(row.request_count)) && Number(row.request_count) > 0, 'invalid-output');
        ensure(!row.generation_id.includes(dependencies.managementKey), 'secret-in-output'); return row.generation_id;
      });
      result.checks.push({ checkedAt, status: generationIds.length ? 'recorded' : 'absent', generationIds });
      if (generationIds.length) {
        result.status = 'recorded'; result.reserveUsd = attempt.estimatedCostUsd;
        try {
          let total = 0;
          for (const id of new Set(generationIds)) {
            const metadata = await request('https://openrouter.ai/api/v1/generation?id=' + encodeURIComponent(id));
            ensure(object(metadata) && object(metadata.data) && metadata.data.id === id && finite(metadata.data.total_cost) && metadata.data.total_cost >= 0, 'invalid-output');
            total += metadata.data.total_cost;
          }
          ensure(Number.isFinite(total), 'invalid-output'); result.costUsd = total; result.reserveUsd = 0;
        } catch { result.reason = 'generation-cost-unavailable'; }
        return result;
      }
    }
    result.status = 'retry-allowed'; result.reserveUsd = attempt.estimatedCostUsd;
  } catch { result.status = signal.aborted ? 'aborted' : 'unavailable'; result.reason = signal.aborted ? 'aborted' : failedHttpStatus ? `management-http-${failedHttpStatus}` : 'management-check-failed'; }
  return result;
}
