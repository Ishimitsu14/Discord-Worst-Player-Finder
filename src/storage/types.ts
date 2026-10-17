import type { GroupSettings } from '../group-settings/index.js';
import type { AnalysisAttempt, FactsBundle, PreparedAnalysis, Side, StartedAttempt } from '../match-analysis/index.js';
import type { MatchSnapshot, OpenDotaErrorSummary } from '../opendota/index.js';

export type { GroupSettings, AnalysisAttempt, FactsBundle, PreparedAnalysis, Side, StartedAttempt, MatchSnapshot };
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
export interface Job {
  id: string; matchId: number; side: Side; revision: number; origin: 'manual' | 'automatic'; settings: GroupSettings;
  state: JobState; step: Step; version: number; createdAt: number; updatedAt: number; nextRunAt: number;
  leaseToken: string | null; leaseUntil: number | null; reason: string | null; refs: ArtifactRefs; resultAttemptId: string | null;
}
export interface Claim { jobId: string; token: string; version: number }
export interface ClaimedJob { job: Job; claim: Claim }
export interface Inputs { snapshot?: MatchSnapshot; bundle?: FactsBundle; prepared?: PreparedAnalysis }
export interface JobArtifacts { snapshot: MatchSnapshot | null; bundle: FactsBundle | null; prepared: PreparedAnalysis | null }
export interface EnqueueInput { matchId: number; side: Side; origin: Job['origin']; settings: GroupSettings }
export interface RevisionInput { requestId: string; matchId: number; side: Side; settings: GroupSettings }
export type ParseOutcome = { jobId: string } | { error: OpenDotaErrorSummary };
export type PublicationOutcome = { messageId: string } | { state: 'not-sent' | 'unknown'; code: string };
export type AttemptKind = 'parse' | 'analysis' | 'publication';
export interface ParseInput { version: 1; matchId: number }
export interface PublicationInput { version: 1; guildId: string; channelId: string; analysisAttemptId: string; message: string }
export interface ResolutionInput {
  resolutionId: string; jobId: string; expectedVersion: number; attemptId: string; decision: 'allow-new-attempt' | 'accept-outcome';
  state: 'waiting' | 'failed'; reason: string; evidenceRef: string; notSentOutcome?: AnalysisAttempt;
}
export interface Resolution extends ResolutionInput { createdAt: number }
export interface Receipt {
  id: string; jobId: string; kind: AttemptKind; state: 'prepared' | 'started' | 'finished' | 'interrupted';
  createdAt: number; updatedAt: number; unresolved: boolean; released: boolean; inputRef: string; input: PreparedAnalysis | ParseInput | PublicationInput;
  started: StartedAttempt | null; outcome: AnalysisAttempt | ParseOutcome | PublicationOutcome | null; resolutions: Resolution[];
}
export interface BillingSummary { knownCostUsd: number; unknownCount: number; unfinishedEstimatedCostUsd: number }
export interface StoredResult { job: Job; attempt: AnalysisAttempt; publications: Receipt[] }
export interface StorageOptions { path: string; clock?: { now(): number } }
