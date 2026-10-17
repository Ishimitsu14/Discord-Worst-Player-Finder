import type { CompactFactsBundle, Side } from '../match-facts/index.js';
import type { AnalysisAttempt, AnalysisIdentity, AnalyzeDependencies, Claim, PackageFiles, Profile, StartedAttempt } from './types.js';

export interface GeminiProfile extends Omit<Profile, 'contextFormat' | 'responseFormat' | 'model' | 'reasoning' | 'calibration' | 'calibrationReport'> {
  contextFormat: 'gemini-compact-v1'; responseFormat: GeminiAnalysis['format']; model: 'google/gemini-3.8-flash';
  reasoning: 'low'; timeoutMs: number; calibration: 'experimental'; calibrationReport: null;
}
export interface GeminiAnalysisV1 {
  version: 1; format: 'gemini-match-analysis-v1'; selectedPlayerSlot: number; nomination: string;
  facts: Claim[]; quoteId: string | null; verdict: string; confidence: 'low' | 'medium' | 'high'; limitations: string[];
}
export interface GeminiAnalysisV2 extends Omit<GeminiAnalysisV1, 'version' | 'format'> {
  version: 2; format: 'gemini-match-analysis-v2'; teamFacts: Claim[];
}
export type GeminiAnalysis = GeminiAnalysisV1 | GeminiAnalysisV2;
export interface GeminiPromptPackage { files: PackageFiles; digest: string; profile: GeminiProfile; schema: Record<string, unknown> }
export interface GeminiIdentity extends Omit<AnalysisIdentity, 'responseFormat' | 'calibration'> { responseFormat: GeminiAnalysis['format']; calibration: 'experimental' }
export interface PreparedGeminiAnalysis extends GeminiIdentity {
  version: 1; prompt: GeminiPromptPackage; body: string; contextBytes: number; requestBytes: number;
  estimatedInputTokens: number; tokenEstimation: 'utf8-bytes-div-2-v1';
}
export interface GeminiStartedAttempt extends Omit<StartedAttempt, keyof AnalysisIdentity>, GeminiIdentity {}
export interface GeminiAttempt extends Omit<AnalysisAttempt, 'identity' | 'analysis'> {
  identity: GeminiIdentity | null; analysis: GeminiAnalysis | null; firstContentMs: number | null; streamBytes: number; responseReceived: boolean;
}
export interface GeminiRecoveryCheck {
  checkedAt: string; status: 'absent' | 'recorded'; generationIds: string[];
}
export interface GeminiRecovery {
  version: 1; attemptId: string | null; requestDigest: string; status: 'not-eligible' | 'unavailable' | 'aborted' | 'recorded' | 'retry-allowed';
  reason: string | null; checks: GeminiRecoveryCheck[]; costUsd: number | null; reserveUsd: number;
}
export interface GeminiRecoveryDependencies {
  managementKey: string; fetcher?: typeof fetch; signal?: AbortSignal; wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}
export interface GeminiDependencies extends Omit<AnalyzeDependencies, 'beforeSend'> { beforeSend: (attempt: GeminiStartedAttempt) => Promise<void> }
export interface GeminiPresentation {
  matchId: number; side: Side; won: boolean; playerSlot: number; playerName: string; heroName: string | null;
  nomination: string; facts: Claim[]; quote: CompactFactsBundle['context']['chat'][number]['value'] | null;
  verdict: string; confidence: GeminiAnalysis['confidence']; limitations: string[]; teamFacts?: Claim[];
}
