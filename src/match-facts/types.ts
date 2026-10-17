export type Side = 'radiant' | 'dire';
export type Raw = Record<string, unknown>;
export type State = 'present' | 'missing' | 'null' | 'invalid';
export type Fact<T = number> = { id: string; value: T };
export type Observation<T = number> = Fact<T> | { unavailable: Exclude<State, 'present'>; reason?: string };
export type Fields = Record<string, Observation<number | string | boolean>>;
export type Group = Fact<Record<string, number | string | boolean | { unavailable: Exclude<State, 'present'>; reason?: string }>>;
export interface Collection<T> { state: State; count: Observation; entries: T[]; excluded: number }
export interface NumericMap { state: State; entries: Record<string, Observation | NumericMap>; excluded: number }
export interface Event { index: number; fields: Fields }
export interface Role { position: Observation; source: 'opendota-estimate' | 'manual' | 'unknown' }
export interface RoleOverride { playerSlot: number; position: number }
export interface MatchFactsInput { matchId: number; side: Side; data: unknown }
export interface FactsOptions { dictionary: unknown; roleOverrides?: RoleOverride[] }
export interface Dictionary {
  version: 1; source: string; revision: string;
  heroes: Record<string, string>; items: Record<string, string>; abilities: Record<string, string>;
}
export interface Issue { code: string; scope: string; playerSlot?: number; index?: number }
export interface Quality { parseState: 'basic' | 'parsed'; missingOpponentSlots: number[]; issues: Issue[] }
export interface Evidence {
  id: string; value: unknown; playerSlot: number | null; metric: string; unit: string;
  source: 'snapshot' | 'override' | 'derived'; paths: string[]; inputs: string[]; transform: string; parameters: Record<string, number>;
}
export interface Player {
  playerSlot: number; heroId: number; heroName: string | null; hero: Fact; role: Role;
  summary: Fields; maps: Record<string, NumericMap>; logs: Record<string, Collection<Event>>;
  slices: Record<string, Record<string, Observation>>; deltas: Record<string, Record<string, Observation>>;
  participation: Observation; deadShare: Observation;
  deadWindows: { deathIndex: number; start: Fact; end: Fact }[];
}
export interface FightPlayer { playerSlot: number; metrics: Fields; maps: Record<string, NumericMap> }
export interface Fight {
  index: number; header: Fields; players: FightPlayer[]; participantDeaths: Observation;
  quality: string[]; followingObjectives: { objectiveIndex: number; time: Fact }[];
  overlaps: { playerSlot: number; deathIndex: number; start: Fact; end: Fact }[];
}
export interface Objective extends Event { actor: Observation; actorSource: 'player_slot' | 'canonical-slot' | 'hero-unit' | 'unknown' }
export interface CatalogEntry { unit: string; meaning: string }
export interface Facts {
  version: 1; format: 'facts-v1'; matchId: number; side: Side; match: Fields;
  catalog: Record<string, CatalogEntry>; players: Player[]; fights: Collection<Fight>; objectives: Collection<Objective>;
  quality: Quality; derived: Record<string, unknown>;
}
export interface Coverage {
  sourceState: State; representation: 'direct' | 'aggregate' | 'local-only';
  sourceCount?: number; reportedCount?: number; excluded?: number;
}
export interface Phase {
  from: number; to: number; reached: boolean; counts: Group;
  killers: Record<string, Fact>; unknownKillers: number;
}
export interface BriefPlayer {
  playerSlot: number; heroId: number; heroName: string | null; hero: Fact; role: Role; metrics: Group;
  economy: Record<string, Group>;
  comparisons?: { opponentSlot: number | null; reason?: string; values: Record<string, Group> };
  items?: Fields;
  itemTypes?: { itemId: number; name: string | null; firstPurchase: Observation; uses: Observation }[];
  abilities?: NumericMap; phases?: Phase[];
  connection?: { disconnects: Observation; reconnects: Observation; lastDisconnect: Observation; lastReconnect: Observation };
  coverage: { states: Partial<Record<State, string[]>>; sourceCounts: Record<string, number>; reportedCounts: Record<string, number>; defaultReportedCount: 0; excluded: Record<string, number> };
}
export interface Brief {
  version: 1; format: 'match-brief-v1'; matchId: number; side: Side; match: Fields;
  catalog: Record<string, CatalogEntry>; limitations: string[];
  quality: { parseState: Quality['parseState']; missingOpponentSlots: number[]; issues: { code: string; scope: string; count: number; slots: number[]; indices: number[] }[] };
  allies: BriefPlayer[]; opponents: BriefPlayer[];
  fights: { index: number; header: Fields; participantDeaths: Observation; quality: string[];
    metrics: Record<string, Group>;
    deadOverlap: Record<string, { seconds: Observation; lowerBound: boolean }> }[];
  objectives: { index: number; fields: Fields; actor: Observation }[];
  buybacks: { playerSlot: number; time: Observation<number | string | boolean> }[];
  coverage: Record<string, Coverage>;
  representations: { allies: Record<Coverage['representation'], string[]>; opponents: Record<Coverage['representation'], string[]> };
}
export interface Manifest {
  version: 1; factsFormat: 'facts-v1'; briefFormat: 'match-brief-v1'; factsProfile: string; briefProfile: string;
  factsTransform: string; briefTransform: string; matchId: number; side: Side; dataDigest: string;
  dictionaryRevision: string; dictionaryDigest: string; overridesDigest: string;
  factsDigest: string; contextDigest: string; evidenceDigest: string; bundleId: string;
}
export interface FactsBundle { facts: Facts; context: Brief; evidence: Evidence[]; manifest: Manifest }
export type ErrorCode = 'invalid-input' | 'unusable-match' | 'invalid-dictionary' | 'invalid-role-override' | 'context-too-large' | 'integrity-error' | 'unknown-fact-reference';
export class FactsError extends Error {
  constructor(public code: ErrorCode, public details: Record<string, number> = {}) { super(code); }
}
