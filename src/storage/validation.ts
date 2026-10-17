import type { AnalysisAttempt, AnalysisIdentity, PreparedAnalysis, StartedAttempt } from '../match-analysis/index.js';
import { validateMatchAnalysis } from '../match-analysis/index.js';
import type { FactsBundle, ParseOutcome, PublicationOutcome } from './types.js';
import { canonical, ensure, hash, id, integer, iso, keys, money, object, shortText, snowflake } from './values.js';

const identityKeys = ['matchId', 'side', 'bundleId', 'contextDigest', 'packageId', 'packageDigest', 'calibration', 'responseFormat', 'requestDigest'];
const analysisErrors = ['invalid-input', 'integrity-error', 'invalid-package', 'invalid-example', 'context-too-large', 'request-too-large', 'invalid-output',
  'unknown-fact-reference', 'invalid-options', 'missing-key', 'secret-in-input', 'cooldown', 'metadata-unavailable', 'unsupported-endpoint', 'unknown-price',
  'estimated-cost-exceeded', 'before-send-failed', 'api-error', 'transport-error', 'timed-out', 'aborted', 'model-mismatch', 'unfinished-or-filtered', 'empty-content', 'secret-in-output'];
const apiTypes = ['context_length_exceeded', 'max_tokens_exceeded', 'token_limit_exceeded', 'string_too_long', 'authentication', 'rate_limit_exceeded',
  'provider_overloaded', 'provider_unavailable', 'content_policy_violation', 'refusal', 'server', 'timeout', 'unmapped'];
export function identity(prepared: PreparedAnalysis): AnalysisIdentity { return Object.fromEntries(identityKeys.map(key => [key, (prepared as unknown as Record<string, unknown>)[key]])) as unknown as AnalysisIdentity; }
function rates(value: unknown): void {
  keys(value, ['input', 'output', 'request', 'endpointNames']);
  ensure(money(value.input) && money(value.output) && money(value.request) && Array.isArray(value.endpointNames) && value.endpointNames.length > 0 && value.endpointNames.every(shortText));
}
export function validateStarted(value: StartedAttempt, prepared: PreparedAnalysis, attemptId: string): void {
  keys(value, [...identityKeys, 'version', 'attemptId', 'status', 'startedAt', 'estimatedCostUsd', 'rates']);
  ensure(value.version === 1 && value.attemptId === attemptId && value.status === 'started' && iso(value.startedAt) && money(value.estimatedCostUsd)); rates(value.rates);
  const actual = Object.fromEntries(identityKeys.map(key => [key, (value as unknown as Record<string, unknown>)[key]]));
  ensure(canonical(actual) === canonical(identity(prepared)), 'integrity-error');
  ensure(value.estimatedCostUsd === prepared.estimatedInputTokens * value.rates.input + prepared.prompt.profile.maxTokens * value.rates.output + value.rates.request, 'integrity-error');
}
export function validateAttempt(value: AnalysisAttempt, prepared: PreparedAnalysis, bundle: FactsBundle, attemptId: string, started: StartedAttempt | null): void {
  keys(value, ['version', 'attemptId', 'identity', 'status', 'startedAt', 'endedAt', 'elapsedMs', 'requestSent', 'generationId', 'model', 'provider', 'finishReason',
    'rates', 'estimatedCostUsd', 'usage', 'billingState', 'retryAt', 'error', 'analysis', 'content', 'responseDigest']);
  ensure(value.version === 1 && ['preflight-failed', 'valid', 'invalid-output', 'api-error', 'transport-error', 'timed-out', 'aborted'].includes(value.status));
  ensure(iso(value.startedAt) && iso(value.endedAt) && money(value.elapsedMs) && typeof value.requestSent === 'boolean' && (value.retryAt === null || iso(value.retryAt)));
  ensure(value.attemptId === attemptId || value.attemptId === null && !value.requestSent && !started);
  if (value.identity === null) ensure(!value.requestSent && !started && value.analysis === null);
  else { keys(value.identity, identityKeys); ensure(canonical(value.identity) === canonical(identity(prepared)), 'integrity-error'); }
  for (const field of ['generationId', 'model', 'provider', 'finishReason'] as const) ensure(value[field] === null || shortText(value[field]));
  ensure(value.estimatedCostUsd === null || money(value.estimatedCostUsd)); if (value.rates !== null) rates(value.rates);
  keys(value.usage, ['promptTokens', 'completionTokens', 'totalTokens', 'reasoningTokens', 'cachedTokens', 'costUsd']);
  for (const [key, item] of Object.entries(value.usage)) ensure(item === null || (key === 'costUsd' ? money(item) : integer(item)));
  ensure(value.billingState === (value.requestSent ? value.usage.costUsd === null ? 'unknown' : 'known' : 'not-sent'));
  if (!value.requestSent) ensure(value.status !== 'valid' && value.analysis === null && (value.usage.costUsd === null || value.usage.costUsd === 0));
  if (value.error !== null) {
    keys(value.error, ['code'], ['httpStatus', 'apiType']); ensure(analysisErrors.includes(value.error.code));
    ensure(value.error.httpStatus === undefined || integer(value.error.httpStatus) && value.error.httpStatus >= 100 && value.error.httpStatus <= 599);
    ensure(value.error.apiType === undefined || apiTypes.includes(value.error.apiType));
  }
  ensure(value.content === null ? value.responseDigest === null : typeof value.content === 'string' && value.responseDigest === hash(value.content), 'integrity-error');
  if (value.requestSent) {
    ensure(started && value.identity && value.startedAt === started.startedAt && canonical(value.rates) === canonical(started.rates) && value.estimatedCostUsd === started.estimatedCostUsd, 'integrity-error');
    ensure(value.status !== 'preflight-failed');
  }
  if (value.status === 'valid') {
    ensure(value.requestSent && value.error === null && value.analysis !== null && value.model === prepared.prompt.profile.model && value.finishReason === 'stop' && typeof value.content === 'string', 'integrity-error');
    try { validateMatchAnalysis(value.analysis, bundle); ensure(canonical(JSON.parse(value.content!)) === canonical(value.analysis), 'integrity-error'); } catch { ensure(false, 'integrity-error'); }
  } else ensure(value.analysis === null && value.error !== null);
}
export function validateParse(value: ParseOutcome): void {
  ensure(object(value));
  if ('jobId' in value) { keys(value, ['jobId']); ensure(typeof value.jobId === 'string' && /^[1-9][0-9]*$/.test(value.jobId) && integer(Number(value.jobId))); }
  else {
    keys(value, ['error']); keys(value.error, ['code', 'operation', 'requestMayHaveSucceeded'], ['httpStatus', 'retryAt']);
    const error = value.error;
    ensure(['invalid_argument', 'not_found', 'unauthorized', 'forbidden', 'bad_request', 'rate_limited', 'network_error', 'timeout', 'upstream_error', 'invalid_response', 'aborted'].includes(error.code));
    ensure(error.operation === 'requestParse' && typeof error.requestMayHaveSucceeded === 'boolean');
    ensure(error.httpStatus === undefined || integer(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599);
    ensure(error.retryAt === undefined || integer(error.retryAt));
  }
}
export function validatePublication(value: PublicationOutcome): void {
  ensure(object(value));
  if ('messageId' in value) { keys(value, ['messageId']); ensure(snowflake(value.messageId)); }
  else { keys(value, ['state', 'code']); ensure(['not-sent', 'unknown'].includes(value.state) && id(value.code)); }
}
