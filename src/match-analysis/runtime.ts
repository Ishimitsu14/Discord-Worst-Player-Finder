import type { CompactFactsBundle } from '../match-facts/index.js';
import type { AnalysisAttempt, FactsBundle, PreparedAnalysis, StartedAttempt } from './types.js';
import type { GeminiAttempt, GeminiStartedAttempt, PreparedGeminiAnalysis } from './gemini-types.js';

export type AnalysisProfile = 'legacy' | 'gemini';
export type RuntimeBundle = FactsBundle | CompactFactsBundle;
export type RuntimePrepared = PreparedAnalysis | PreparedGeminiAnalysis;
export type RuntimeAttempt = AnalysisAttempt | GeminiAttempt;
export type RuntimeStarted = StartedAttempt | GeminiStartedAttempt;
export const isGeminiBundle = (bundle: RuntimeBundle): bundle is CompactFactsBundle => bundle.context.format === 'gemini-compact-v1';
export const isGeminiPrepared = (prepared: RuntimePrepared): prepared is PreparedGeminiAnalysis => prepared.responseFormat === 'gemini-match-analysis-v1' || prepared.responseFormat === 'gemini-match-analysis-v2';
export const isGeminiAttempt = (attempt: RuntimeAttempt): attempt is GeminiAttempt => 'responseReceived' in attempt;
export function geminiRecoveryEligible(attempt: RuntimeAttempt): attempt is GeminiAttempt {
  return isGeminiAttempt(attempt) && attempt.requestSent && ['transport-error', 'timed-out'].includes(attempt.status)
    && attempt.responseReceived === false && attempt.generationId === null && attempt.content === null && attempt.streamBytes === 0
    && Object.values(attempt.usage).every(value => value === null);
}
