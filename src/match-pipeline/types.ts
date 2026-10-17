import type { GroupSettings } from '../group-settings/index.js';
import type { AnalysisAttempt, AnalysisProfile, FactsBundle, GeminiAttempt, GeminiPromptPackage, PromptPackage, Side } from '../match-analysis/index.js';
import type { CompactFactsBundle } from '../match-facts/index.js';
import type { FactsOptions } from '../match-facts/index.js';
import type { Clock, MatchSnapshot, OpenDotaClient } from '../opendota/index.js';
import type { SteamHistoryClient } from '../steam/index.js';
import type { Job, PublicationInput, Storage, StoredResult } from '../storage/index.js';

export type { GroupSettings, Job, PublicationInput, Side, StoredResult, Clock };
export interface PipelineOptions {
  publicationMode?: 'automatic' | 'on-command';
  analysisProfile?: AnalysisProfile;
  historySource?: 'opendota' | 'steam'; discoveryRetryMs?: number; discoveryTimeoutMs?: number; maxDiscoveryChecksPerScan?: number;
  mode?: 'prepare-only' | 'live'; automaticSince?: number; pollIntervalMs?: number; pageSize?: number;
  maxPagesPerAccount?: number; maxCandidatesPerScan?: number; workerIdleMs?: number; pauseMs?: number;
  parseTimeoutMs?: number; parsePollMs?: number; analysisTimeoutMs?: number; publicationTimeoutMs?: number;
  maxTotalCostUsd?: number; maxEstimatedCostPerAttemptUsd?: number; allowExperimental?: boolean;
}
export type PipelineConfig = Readonly<Required<Omit<PipelineOptions, 'automaticSince' | 'maxTotalCostUsd' | 'maxEstimatedCostPerAttemptUsd'>>
  & Pick<PipelineOptions, 'automaticSince' | 'maxTotalCostUsd' | 'maxEstimatedCostPerAttemptUsd'>>;
export type PublicationContext = { analysisProfile?: 'legacy'; job: Job; analysis: AnalysisAttempt; bundle: FactsBundle; snapshot: MatchSnapshot }
  | { analysisProfile: 'gemini'; job: Job; analysis: GeminiAttempt; bundle: CompactFactsBundle; snapshot: MatchSnapshot };
export interface Publisher {
  prepare(input: PublicationContext): string;
  send(input: PublicationInput, options: { signal: AbortSignal }): Promise<{ messageId: string }>;
}
export class PublicationError extends Error {
  constructor(public readonly code: 'unavailable' | 'forbidden' | 'invalid-message' | 'rate-limited' | 'transport-error',
    public readonly outcome: 'not-sent' | 'unknown') { super(`Publication: ${code}`); this.name = 'PublicationError'; }
}
export interface PipelineEvent {
  knownCostUsd?: number; reservedCostUsd?: number; uncoveredUnknownCount?: number;
  type: 'job' | 'discovery' | 'error'; jobId?: string; matchId?: number; side?: Side; revision?: number;
  state?: Job['state']; step?: Job['step']; code?: string; accountId?: number;
  pending?: number; deferred?: number; checks?: number; accountsChecked?: number;
  pages?: number; candidates?: number; queued?: number; existing?: number; rejected?: number; requiresSide?: number; errors?: number; partial?: boolean;
}
export interface PipelineDependencies {
  settings: GroupSettings; storage: Storage; opendota: OpenDotaClient; steam?: Pick<SteamHistoryClient, 'getMatchHistory'>; facts: Pick<FactsOptions, 'dictionary'>; prompt: PromptPackage;
  geminiPrompt?: GeminiPromptPackage; heroMetricsDictionary?: unknown; managementKey?: string;
  apiKey?: string; fetcher?: typeof fetch; publisher?: Publisher; onEvent?: (event: Readonly<PipelineEvent>) => void | Promise<void>; clock?: Clock;
}
export interface RequestOptions { signal?: AbortSignal }
export type MatchRequestResult = { status: 'queued' | 'existing'; job: Job; result: StoredResult | null }
  | { status: 'awaiting-data'; matchId: number; code: string; nextCheckAt: number | null }
  | { status: 'requires-side' | 'rejected'; matchId: number; code: string };
export interface DiscoveryReport {
  status: 'complete' | 'busy'; scanAt: number; cutoff: number; pages: number; candidates: number;
  queued: string[]; existing: string[]; rejected: { matchId: number; code: string }[]; requiresSide: number[];
  errors: { accountId?: number; matchId?: number; code: string }[]; partial: boolean;
  pending?: number; deferred?: number; checks?: number; accountsChecked?: number;
}
export type ProcessResult = { status: 'idle' | 'busy' } | { status: 'processed'; job: Job };
export interface PipelineStatus { job: Job; result: StoredResult | null; attention: boolean; billingUnknown: boolean; knownCostUsd: number; reservedCostUsd: number; uncoveredUnknownCount: number; publicationMode?: 'automatic' | 'on-command' }
export interface MatchPipeline {
  readonly config: PipelineConfig;
  requestMatch(input: { matchId: number; side?: Side }, options?: RequestOptions): Promise<MatchRequestResult>;
  requestReanalysis(input: { requestId: string; matchId: number; side: Side }, options?: RequestOptions): Promise<MatchRequestResult>;
  discoverOnce(options?: RequestOptions): Promise<DiscoveryReport>;
  processNext(options?: RequestOptions): Promise<ProcessResult>;
  getStatus(input: { jobId: string }): PipelineStatus;
  run(options?: RequestOptions & { automatic?: boolean }): Promise<{ status: 'stopped' | 'already-running' }>;
  stop(): Promise<void>;
}
export type ErrorCode = 'invalid-config' | 'invalid-input' | 'automatic-since-required' | 'stopped' | 'aborted' | 'lease-lost'
  | 'storage-failure' | 'conflict' | 'not-found' | 'opendota-failure';
export class PipelineError extends Error {
  constructor(public readonly code: ErrorCode) { super(`Match pipeline: ${code}`); this.name = 'PipelineError'; }
  toJSON(): { code: ErrorCode; message: string } { return { code: this.code, message: this.message }; }
}
