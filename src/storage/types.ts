import type { GroupSettings } from '../group-settings/index.js';
import type { AnalysisAttempt, FactsBundle, PreparedAnalysis, Side, StartedAttempt } from '../match-analysis/index.js';
import type { AnalysisProfile, RuntimeAttempt, RuntimeBundle, RuntimePrepared, RuntimeStarted, GeminiAttempt, GeminiRecovery, PreparedGeminiAnalysis } from '../match-analysis/index.js';
import type { CompactFactsBundle } from '../match-facts/index.js';
import type { MatchSnapshot, OpenDotaErrorSummary } from '../opendota/index.js';

export type { GroupSettings, AnalysisAttempt, FactsBundle, PreparedAnalysis, Side, StartedAttempt, MatchSnapshot };
export type { AnalysisProfile, RuntimeAttempt, RuntimeBundle, RuntimePrepared, RuntimeStarted };
export type ErrorCode = 'invalid-input' | 'too-large' | 'incompatible-schema' | 'integrity-error' | 'not-found' | 'conflict'
  | 'lease-lost' | 'attempt-already-started' | 'busy' | 'io-error' | 'closed';
export class StorageError extends Error {
  constructor(public readonly code: ErrorCode, public readonly operation: string) { super(`Storage: ${code}`); this.name = 'StorageError'; }
  toJSON(): { code: ErrorCode; operation: string; message: string } { return { code: this.code, operation: this.operation, message: this.message }; }
}
export type JobState = 'queued' | 'running' | 'waiting' | 'needs-attention' | 'succeeded' | 'failed';
export type Step = 'load-match' | 'wait-parse' | 'build-facts' | 'analyze' | 'publish';
export interface ArtifactRefs { snapshot: string | null; bundle: string | null; prepared: string | null }
export interface MatchRecord { matchId: number; firstSeenAt: number; lastSeenAt: number }
export interface DiscoveryCandidate {
  contextKey: string; matchId: number; firstSeenAt: number; lastSeenAt: number; expiresAt: number;
  state: 'pending' | 'admitted' | 'ignored' | 'needs-attention'; nextCheckAt: number | null; reason: string | null;
}
export interface DiscoveryObservation { contextKey: string; matchId: number; observedAt: number; expiresAt: number }
export interface DiscoveryDecision { contextKey: string; matchId: number; state: DiscoveryCandidate['state']; nextCheckAt: number | null; reason: string | null }
export interface Job {
  analysisProfile: AnalysisProfile;
  id: string; matchId: number; side: Side; revision: number; origin: 'manual' | 'automatic'; settings: GroupSettings;
  state: JobState; step: Step; version: number; createdAt: number; updatedAt: number; nextRunAt: number;
  leaseToken: string | null; leaseUntil: number | null; reason: string | null; publicationRequested: boolean; refs: ArtifactRefs; resultAttemptId: string | null;
}
export interface Claim { jobId: string; token: string; version: number }
export interface ClaimedJob { job: Job; claim: Claim }
export interface Inputs { snapshot?: MatchSnapshot; bundle?: RuntimeBundle; prepared?: RuntimePrepared }
export interface LegacyJobArtifacts { analysisProfile: 'legacy'; snapshot: MatchSnapshot | null; bundle: FactsBundle | null; prepared: PreparedAnalysis | null }
export interface GeminiJobArtifacts { analysisProfile: 'gemini'; snapshot: MatchSnapshot | null; bundle: CompactFactsBundle | null; prepared: PreparedGeminiAnalysis | null }
export type JobArtifacts = LegacyJobArtifacts | GeminiJobArtifacts;
export interface EnqueueInput { matchId: number; side: Side; origin: Job['origin']; settings: GroupSettings; analysisProfile?: AnalysisProfile }
export interface RevisionInput { requestId: string; matchId: number; side: Side; settings: GroupSettings; analysisProfile?: AnalysisProfile }
export type ParseOutcome = { jobId: string } | { error: OpenDotaErrorSummary };
export type PublicationOutcome = { messageId: string } | { state: 'not-sent' | 'unknown'; code: string };
export type AttemptKind = 'parse' | 'analysis' | 'publication';
export interface ParseInput { version: 1; matchId: number }
export interface PublicationInput { version: 1; guildId: string; channelId: string; analysisAttemptId: string; message: string }
export interface ResolutionInput {
  resolutionId: string; jobId: string; expectedVersion: number; attemptId: string; decision: 'allow-new-attempt' | 'accept-outcome';
  state: 'waiting' | 'failed'; reason: string; evidenceRef: string; notSentOutcome?: RuntimeAttempt;
}
export interface Resolution extends ResolutionInput { createdAt: number }
export interface Receipt {
  id: string; jobId: string; kind: AttemptKind; state: 'prepared' | 'started' | 'finished' | 'interrupted';
  createdAt: number; updatedAt: number; unresolved: boolean; released: boolean; inputRef: string; input: RuntimePrepared | ParseInput | PublicationInput;
  started: RuntimeStarted | null; outcome: RuntimeAttempt | ParseOutcome | PublicationOutcome | null; resolutions: Resolution[];
}
export interface BillingSummary { knownCostUsd: number; unknownCount: number; unfinishedEstimatedCostUsd: number; reservedCostUsd: number; uncoveredUnknownCount: number }
export type StoredResult = { analysisProfile: 'legacy'; job: Job; attempt: AnalysisAttempt; publications: Receipt[] }
  | { analysisProfile: 'gemini'; job: Job; attempt: GeminiAttempt; publications: Receipt[] };
export interface StoredGeminiRecovery { parentAttemptId: string; recovery: GeminiRecovery; retryAttemptId: string | null; createdAt: number }
export interface StorageOptions { path: string; clock?: { now(): number } }
