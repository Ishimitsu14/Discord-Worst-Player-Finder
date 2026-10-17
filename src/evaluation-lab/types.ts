export type Side = 'radiant' | 'dire';
export type Split = 'development' | 'holdout';
export type Variant = 'full-v1' | 'compact-v1' | 'full-v2' | 'compact-v2';
export type Raw = Record<string, unknown>;

export interface Entry {
  matchId: number;
  side: Side;
  split: Split;
  snapshot: string;
  digest: string;
  retrievedAt: string | null;
  importedAt: string;
  source: 'api' | 'import' | 'derived-fixture';
  originalMatchId: number;
  parentDigest: string | null;
  usedForTuning: boolean;
}

export interface Corpus {
  version: 1;
  revision: string;
  entries: Entry[];
}

export interface Label {
  matchId: number;
  side: Side;
  snapshotDigest: string;
  status: 'unlabeled' | 'selection' | 'insufficient-evidence';
  acceptableSelections: number[][];
  modelOutputSeen: boolean;
  reasons: { playerSlot: number | null; subjective: boolean; paths: string[]; comment: string }[];
}

export interface Labels {
  version: 1;
  revision: string;
  previousRevision: string | null;
  createdAt: string;
  entries: Label[];
}

export interface Profile {
  version: 1;
  contextVersion?: 1 | 2;
  analysisVersion?: 1 | 2;
  id: string;
  model: string;
  temperature: number;
  maxTokens: number;
  maxRequestBytes: number;
  provider: { require_parameters: true; only?: string[]; allow_fallbacks?: boolean };
  reasoning: 'upstream-default';
  rankedLobbyIds: number[];
  gameModeIds: number[];
  dictionary: string;
  contextFields: Record<string, string[]>;
}

export interface Dictionary {
  version: 1;
  source: string;
  revision: string;
  heroes: Record<string, string>;
  items: Record<string, string>;
  abilities: Record<string, string>;
}

export interface Evidence {
  evidenceId: string;
  playerSlot: number | null;
  value: unknown;
  unit: string;
  paths: string[];
  transform: string;
}

export interface Context {
  version: 1;
  variant: Variant;
  matchId: number;
  side: Side;
  duration: number;
  radiantWin: boolean;
  parseState: 'basic' | 'parsed';
  dictionaryRevision: string;
  indexToSlot: number[];
  players: { playerSlot: number; heroId: number; heroName: string | null; assumedRole: null }[];
  items: { itemId: number; name: string | null }[];
  limitations: string[];
  evidence: Evidence[];
  roles?: { playerSlot: number; position: number | null; source: 'opendota-estimate' | 'manual' | 'unknown'; evidenceId: string | null }[];
  fights?: {
    index: number;
    start: string | null;
    end: string | null;
    deaths: string | null;
    players: { playerSlot: number; metrics: Record<string, string | null>; evidenceIds: string[] }[];
    followingObjectives: string[];
    limitations: string[];
  }[];
}

export interface Fact { claim: string; evidenceIds: string[] }

export interface Analysis {
  status: 'selected' | 'insufficient-evidence';
  selectedPlayers: {
    playerSlot: number;
    explanation: string;
    roast: string;
    reasons: { claim: string; evidenceIds: string[] }[];
  }[];
  comparison: string;
  limitations: string[];
  confidence?: 'low' | 'medium' | 'high';
  playerAssessments?: {
    playerSlot: number;
    position: number | null;
    resources: Fact | null;
    contributions: Fact[];
    concerns: Fact[];
    counterargument: Fact | null;
    limitations: string[];
  }[];
  closestAlternative?: { playerSlot: number; reason: Fact } | null;
}

export interface Examples {
  version: 1;
  entries: { matchId: number; snapshotDigest: string; context: Context; analysis: Analysis }[];
}

export interface Experiment {
  version: 1;
  corpus: string;
  labels: string;
  prompt: string;
  matches: { matchId: number; side: Side }[];
  repeats: number;
  holdoutUntouched: boolean;
  roleOverrides?: { matchId: number; playerSlot: number; position: number }[];
}

export interface RequestEntry {
  index: number;
  matchId: number;
  side: Side;
  split: Split;
  snapshotDigest: string;
  variant: Variant;
  repeat: number;
  request: string;
  context: string;
  requestDigest: string;
  bytes: number;
  estimatedInputTokens: number;
}

export interface Plan {
  version: 1;
  planId: string;
  createdAt: string;
  packageDigest: string;
  corpusRevision: string;
  labelsRevision: string;
  holdoutUntouched: boolean;
  requests: RequestEntry[];
  tokenEstimation: 'utf8-bytes-div-2-v1';
  artifacts: Record<string, string>;
}

export type AttemptStatus = 'started' | 'valid' | 'invalid-output' | 'api-error' | 'transport-error' | 'timed-out' | 'aborted';
export interface Attempt {
  version: 1;
  runId: string;
  planId: string;
  index: number;
  requestDigest: string;
  startedAt: string;
  endedAt: string | null;
  elapsedMs: number | null;
  status: AttemptStatus;
  generationId: string | null;
  model: string | null;
  provider: string | null;
  finishReason: string | null;
  content: string | null;
  responseDigest: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; reasoningTokens: number | null; cachedTokens: number | null; costUsd: number | null };
  error: string | null;
  retryAt: string | null;
}

export interface Review {
  runId: string;
  index: number;
  responseDigest: string;
  labelsRevision: string;
  status: 'unreviewed' | 'reviewed';
  agreement: 'agree' | 'partly' | 'disagree' | 'cannot-assess';
  claims: { playerSlot: number; reasonIndex: number; section?: 'selected' | 'resources' | 'contributions' | 'concerns' | 'counterargument' | 'alternative'; verdict: 'supported' | 'unsupported' | 'uncertain' }[];
  roleError: boolean;
  causalityError: boolean;
  roast: 'usable' | 'needs-edit' | 'unusable';
  comment: string;
}

export interface Reviews {
  version: 1;
  revision: string;
  previousRevision: string | null;
  createdAt: string;
  entries: Review[];
  recommendation: null | {
    variant: Variant;
    conclusion: 'candidate' | 'not-confirmed';
    matchFacts: string[];
    matchAnalysis: string[];
    limitations: string[];
  };
}
