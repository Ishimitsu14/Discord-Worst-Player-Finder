import { geminiRecoveryEligible, type GeminiAttempt, type GeminiRecovery, type RuntimeAttempt } from '../match-analysis/index.js';
import { ensure, id, iso, keys, money } from './values.js';

export function eligibleRecovery(value: RuntimeAttempt | null): value is GeminiAttempt { return value !== null && geminiRecoveryEligible(value); }
export function validateRecovery(value: GeminiRecovery, attempt: GeminiAttempt, attemptId: string, requestDigest: string): void {
  keys(value, ['version', 'attemptId', 'requestDigest', 'status', 'reason', 'checks', 'costUsd', 'reserveUsd']);
  ensure(value.version === 1 && value.attemptId === attemptId && value.requestDigest === requestDigest && id(attemptId), 'integrity-error');
  ensure(['not-eligible', 'unavailable', 'aborted', 'recorded', 'retry-allowed'].includes(value.status));
  ensure(value.reason === null || typeof value.reason === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value.reason));
  ensure(Array.isArray(value.checks) && value.checks.length <= 3 && (value.costUsd === null || money(value.costUsd)) && money(value.reserveUsd));
  let previous = Date.parse(attempt.endedAt);
  for (const [index, check] of value.checks.entries()) {
    keys(check, ['checkedAt', 'status', 'generationIds']); ensure(iso(check.checkedAt) && Date.parse(check.checkedAt) >= previous + [10000, 20000, 30000][index]);
    previous = Date.parse(check.checkedAt);
    ensure(Array.isArray(check.generationIds) && check.generationIds.length <= 2 && check.generationIds.every(value => typeof value === 'string' && /^gen-[a-zA-Z0-9-]{1,124}$/.test(value)));
    ensure(check.status === (check.generationIds.length ? 'recorded' : 'absent'));
    ensure(index === value.checks.length - 1 || check.status === 'absent');
  }
  const recorded = value.checks.some(check => check.status === 'recorded');
  if (value.status === 'retry-allowed') ensure(value.checks.length === 3 && !recorded && value.costUsd === null && value.reserveUsd === attempt.estimatedCostUsd && value.reserveUsd > 0);
  else if (value.status === 'recorded') ensure(recorded && value.reserveUsd === (value.costUsd === null ? attempt.estimatedCostUsd : 0));
  else ensure(!recorded && value.reserveUsd === 0 && value.costUsd === null);
}
