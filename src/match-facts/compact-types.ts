import type { Evidence, Fact, Facts, FactsOptions, Side, State, Unavailable } from './types.js';

export interface CompactFactsOptions extends Omit<FactsOptions, 'briefFormat'> { heroMetricsDictionary: unknown }
export type CompactNumber = number | Unavailable;
export type CompactRoleSource = 'position_est' | 'manual' | 'unknown';
export interface CompactCore {
  player_slot: number; hero_id: number; hero_name: string | null; player_name: string;
  name_source: State; name_truncated: boolean; position: CompactNumber; position_source: CompactRoleSource;
  lane_role: CompactNumber; kills: CompactNumber; deaths: CompactNumber; assists: CompactNumber;
  gold_per_min: CompactNumber; xp_per_min: CompactNumber; networth: CompactNumber;
  last_hits: CompactNumber; denies: CompactNumber; hero_damage: CompactNumber; tower_damage: CompactNumber;
  hero_healing: CompactNumber; stuns: CompactNumber; obs_placed: CompactNumber; sen_placed: CompactNumber;
  observer_kills: CompactNumber; sentry_kills: CompactNumber; camps_stacked: CompactNumber;
  kill_participation_pct: CompactNumber;
}
export interface CompactOpponent { player_slot: number; hero_id: number; hero_name: string | null; position: CompactNumber; position_source: CompactRoleSource; networth: CompactNumber }
export interface CompactChat { source_index: number; player_slot: number; time_sec: number; rounded_min: number; text: string; truncated: boolean }
export type KeyItemTiming = { first_purchase_sec: number; rounded_min: number } | Unavailable;
export type CompactBenchmark = { raw: CompactNumber; pct: CompactNumber } | Unavailable;
export interface CompactPlayer {
  core: Fact<CompactCore>; key_item_timings: Fact<Record<string, KeyItemTiming>>;
  benchmarks: Fact<Record<string, CompactBenchmark>>; special_metrics: Fact<Record<string, CompactNumber>>;
}
export interface CompactContext {
  version: 1; format: 'gemini-compact-v1';
  match_info: Fact<{ match_id: number; duration_sec: number; duration_min: number; side: Side; won: boolean; total_team_kills: CompactNumber }>;
  players: CompactPlayer[]; opponents: Fact<CompactOpponent>[]; chat: Fact<CompactChat>[];
  coverage: {
    parse_state: 'basic' | 'parsed'; missing_opponent_slots: number[];
    groups: Record<string, { source_state: State; unavailable_fields: string[] }>;
    chat: { source_state: State; source_count: number; eligible_count: number; sent_count: number; truncated_count: number; excluded: Record<string, number> };
  };
}
export interface CompactFacts extends Omit<Facts, 'format'> {
  format: 'gemini-facts-v1'; extras: {
    players: { player_slot: number; player_name: string | null; groups: Omit<CompactPlayer, 'core'> }[];
    chat: CompactChat[];
  };
}
export interface CompactManifest {
  version: 1; format: 'gemini-compact-manifest-v1'; profile: 'gemini-compact-v1'; transform: 'compact-1';
  matchId: number; side: Side; sourceDataDigest: string; optionsDigest: string;
  dictionaryDigest: string; heroMetricsDictionaryDigest: string;
  factsDigest: string; contextDigest: string; evidenceDigest: string; bundleId: string;
}
export interface CompactFactsBundle { facts: CompactFacts; context: CompactContext; evidence: Evidence[]; manifest: CompactManifest }
