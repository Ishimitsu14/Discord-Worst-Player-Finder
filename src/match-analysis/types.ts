import type { Brief, FactsBundle, Role, Side } from '../match-facts/index.js';

export type { Brief, FactsBundle, Side } from '../match-facts/index.js';
export type Raw = Record<string, unknown>;
export type Calibration = 'experimental' | 'candidate';
export interface Claim { claim: string; evidenceIds: string[] }
export interface PlayerAssessment {
  playerSlot: number; position: number | null; positionSource: Role['source']; resources: Claim | null;
  contributions: Claim[]; concerns: Claim[]; counterargument: Claim | null; limitations: string[];
}
export interface MatchAnalysis {
  version: 1; format: 'match-analysis-v1'; status: 'selected' | 'insufficient-evidence'; confidence: 'low' | 'medium' | 'high';
  playerAssessments: PlayerAssessment[]; comparison: Claim | null;
  selectedPlayers: { playerSlot: number; reasons: Claim[]; roast: string }[];
  closestAlternative: { playerSlot: number; reason: Claim } | null; limitations: string[];
}
export interface ClaimAddress {
  section: 'resources' | 'contributions' | 'concerns' | 'counterargument' | 'reasons' | 'comparison' | 'alternative';
  playerSlot: number | null; index: number;
}
export interface Profile {
  version: 1; id: string; contextFormat: 'match-brief-v1'; responseFormat: 'match-analysis-v1'; model: 'xiaomi/mimo-v2.6-pro';
  temperature: number; maxTokens: number; maxRequestBytes: number; reasoning: 'upstream-default';
  tokenEstimation: 'utf8-bytes-div-2-v1'; provider: { only: string[]; require_parameters: true; allow_fallbacks: boolean };
  calibration: Calibration; calibrationReport: { path: string; digest: string } | null;
}
export interface Example {
  context: Brief; analysis: MatchAnalysis;
  provenance: { matchId: number; side: Side; snapshotDigest: string; contextDigest: string; split: 'development'; labelRevision: string; reviewRevision: string };
}
export type PackageFiles = Record<'instruction.md' | 'response.schema.json' | 'profile.json' | 'examples.json', string>;
export interface PromptPackage { files: PackageFiles; digest: string; profile: Profile; schema: Raw; examples: Example[]; calibrationEvidence: string | null }
export interface AnalysisIdentity {
  matchId: number; side: Side; bundleId: string; contextDigest: string;
  packageId: string; packageDigest: string; calibration: Calibration; responseFormat: 'match-analysis-v1'; requestDigest: string;
}
export interface PreparedAnalysis extends AnalysisIdentity {
  version: 1; prompt: PromptPackage; body: string; contextBytes: number; requestBytes: number;
  estimatedInputTokens: number; tokenEstimation: 'utf8-bytes-div-2-v1';
}
export interface Usage {
  promptTokens: number | null; completionTokens: number | null; totalTokens: number | null;
  reasoningTokens: number | null; cachedTokens: number | null; costUsd: number | null;
}
export interface Rates { input: number; output: number; request: number; endpointNames: string[] }
export type ErrorCode = 'invalid-input' | 'integrity-error' | 'invalid-package' | 'invalid-example' | 'context-too-large' | 'request-too-large'
  | 'invalid-output' | 'unknown-fact-reference' | 'invalid-options' | 'missing-key' | 'secret-in-input' | 'cooldown'
  | 'metadata-unavailable' | 'unsupported-endpoint' | 'unknown-price' | 'estimated-cost-exceeded' | 'before-send-failed'
  | 'api-error' | 'transport-error' | 'timed-out' | 'aborted' | 'model-mismatch' | 'unfinished-or-filtered' | 'empty-content' | 'secret-in-output';
export class AnalysisError extends Error {
  constructor(public code: ErrorCode, public details: Record<string, number> = {}) { super(code); }
}
export interface AttemptError { code: ErrorCode; httpStatus?: number; apiType?: string }
export interface StartedAttempt extends AnalysisIdentity {
  version: 1; attemptId: string; status: 'started'; startedAt: string; estimatedCostUsd: number; rates: Rates;
}
export interface AnalysisAttempt {
  version: 1; attemptId: string | null; identity: AnalysisIdentity | null;
  status: 'preflight-failed' | 'valid' | 'invalid-output' | 'api-error' | 'transport-error' | 'timed-out' | 'aborted';
  startedAt: string; endedAt: string; elapsedMs: number; requestSent: boolean;
  generationId: string | null; model: string | null; provider: string | null; finishReason: string | null;
  rates: Rates | null; estimatedCostUsd: number | null; usage: Usage; billingState: 'not-sent' | 'known' | 'unknown';
  retryAt: string | null; error: AttemptError | null; analysis: MatchAnalysis | null; content: string | null; responseDigest: string | null;
}
export interface AnalyzeOptions { attemptId: string; maxEstimatedCostUsd: number; timeoutMs?: number; notBefore?: string }
export interface AnalyzeDependencies {
  apiKey: string; beforeSend: (attempt: StartedAttempt) => Promise<void>; fetcher?: typeof fetch; signal?: AbortSignal;
}
