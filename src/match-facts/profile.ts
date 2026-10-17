import type { CatalogEntry } from './types.js';

export const dictionaryRevision = '5c0242df9057848fa2036ca3fafe9f2bd4508163';
export const dictionaryDigest = 'c77d5cc3c4f60989e47f96e15065199cc484c59d01c2241eb2901890c8c1eb97';
export const factsProfile = 'facts-profile-1';
export const briefProfile = 'brief-profile-1';
export const briefTargetBytes = 32768;
export const briefLimitBytes = 65536;
export const canonicalSlots = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];
export const summaryFields = [
  'kills', 'deaths', 'assists', 'last_hits', 'denies', 'gold_per_min', 'xp_per_min', 'net_worth', 'total_gold', 'total_xp',
  'hero_damage', 'tower_damage', 'hero_healing', 'level', 'gold_spent', 'obs_placed', 'sen_placed', 'observer_kills',
  'sentry_kills', 'camps_stacked', 'rune_pickups', 'stuns', 'teamfight_participation', 'towers_killed', 'roshans_killed',
  'firstblood_claimed', 'buyback_count', 'life_state_dead', 'lane', 'lane_role', 'is_roaming', 'lane_efficiency_pct',
  'item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5', 'backpack_0', 'backpack_1', 'backpack_2', 'item_neutral',
];
export const seriesFields = ['gold_t', 'xp_t', 'lh_t', 'dn_t', 'networth_t', 'hero_damage_t', 'hero_healing_t', 'tower_damage_t'];
export const logFields = ['purchase_log', 'kills_log', 'deaths_log', 'buyback_log', 'runes_log', 'obs_log', 'sen_log', 'obs_left_log', 'sen_left_log', 'connection_log'];
export const mapFields = ['damage', 'damage_taken', 'hero_hits', 'killed', 'killed_by', 'item_uses', 'ability_uses', 'damage_inflictor', 'damage_inflictor_received', 'healing', 'gold_reasons', 'xp_reasons', 'ability_targets', 'damage_targets'];
export const countMapFields = new Set(['hero_hits', 'killed', 'killed_by', 'item_uses', 'ability_uses', 'ability_targets']);
export const signedMapFields = new Set(['gold_reasons', 'xp_reasons']);
export const matchFields = ['duration', 'radiant_win', 'game_mode', 'lobby_type', 'patch', 'start_time', 'version', 'radiant_score', 'dire_score', 'tower_status_radiant', 'tower_status_dire', 'barracks_status_radiant', 'barracks_status_dire'];
export const fightMetrics = ['deaths', 'buybacks', 'damage', 'healing', 'gold_delta', 'xp_delta', 'xp_start', 'xp_end'];
export const fightMaps = ['ability_uses', 'ability_targets', 'item_uses', 'killed'];
export const objectiveFields = ['time', 'type', 'key', 'unit', 'team', 'slot', 'player_slot', 'victim_player_slot', 'killer', 'value'];
export const eventFields = ['time', 'time_dead', 'gold_fed', 'gold_lost', 'key', 'slot', 'player_slot', 'unit', 'team', 'type', 'event'];
export const objectiveTypes = ['building_kill', 'CHAT_MESSAGE_TOWER_KILL', 'CHAT_MESSAGE_BARRACKS_KILL', 'CHAT_MESSAGE_ROSHAN_KILL', 'CHAT_MESSAGE_AEGIS', 'CHAT_MESSAGE_AEGIS_STOLEN', 'CHAT_MESSAGE_AEGIS_DENIED', 'CHAT_MESSAGE_FIRSTBLOOD', 'CHAT_MESSAGE_COURIER_LOST'];
export const itemFields = summaryFields.filter(field => field.startsWith('item_') || field.startsWith('backpack_'));
export const allyMetrics = ['kills', 'deaths', 'assists', 'gold_per_min', 'xp_per_min', 'net_worth', 'last_hits', 'hero_damage', 'tower_damage', 'hero_healing', 'stuns', 'life_state_dead', 'obs_placed', 'sen_placed', 'observer_kills', 'sentry_kills', 'camps_stacked', 'buyback_count'];
export const opponentMetrics = ['kills', 'deaths', 'assists', 'gold_per_min', 'xp_per_min', 'net_worth', 'hero_damage', 'tower_damage', 'stuns', 'life_state_dead'];
export const briefSeries = ['gold_t', 'networth_t', 'xp_t', 'lh_t'];
export const briefFightMetrics = ['deaths', 'buybacks', 'damage', 'healing', 'gold_delta'];
export const phaseLogs = ['deaths_log', 'kills_log', 'obs_log', 'sen_log', 'purchase_log'];
export const countFields = new Set(['kills', 'deaths', 'assists', 'last_hits', 'denies', 'level', 'obs_placed', 'sen_placed', 'observer_kills', 'sentry_kills', 'camps_stacked', 'rune_pickups', 'towers_killed', 'roshans_killed', 'firstblood_claimed', 'buyback_count', 'buybacks', ...itemFields, 'hero_id', 'position_est', 'lane', 'lane_role', 'game_mode', 'lobby_type', 'patch', 'version', 'start_time', 'radiant_score', 'dire_score', 'tower_status_radiant', 'tower_status_dire', 'barracks_status_radiant', 'barracks_status_dire', 'slot', 'player_slot', 'victim_player_slot', 'killer', 'team', 'event', 'value']);
export const signedFields = new Set(['time', 'start', 'end', 'last_death', 'gold_delta', 'xp_delta']);
export function unit(field: string): string {
  if (['time', 'time_dead', 'start', 'end', 'last_death', 'duration', 'stuns', 'life_state_dead', 'deadOverlap'].includes(field)) return 'seconds';
  if (field === 'gold_per_min') return 'gold/minute';
  if (field === 'xp_per_min') return 'xp/minute';
  if (field.includes('networth') || field === 'net_worth') return 'net-worth';
  if (field === 'gold_t') return 'earned-gold';
  if (field.includes('gold') || field === 'purchase_log') return 'gold';
  if (field.includes('xp')) return 'xp';
  if (field.includes('damage') || field.includes('healing')) return 'hp';
  if (['participation', 'deadShare', 'teamfight_participation'].includes(field)) return 'ratio';
  if (field === 'lane_efficiency_pct') return 'percent';
  if (['key', 'type', 'unit'].includes(field)) return 'token';
  if (['position_est', 'position'].includes(field)) return 'position-hypothesis';
  return 'count';
}
export const limitations = [
  'position 1 carry, 2 mid, 3 offlane, 4 soft support, 5 hard support; opendota-estimate is a hypothesis, manual is an assignment.',
  'Missing is not zero. Local-only details are not evidence supplied to the analyst. Parsed does not guarantee complete logs.',
  'OpenDota fight cards cover algorithm-selected fights (at least three deaths); the last fight can be absent. Zero card damage does not imply AFK.',
  'Card healing and hero_healing differ; neither proves an ally was saved. Stuns may sum across targets.',
  'gold_t is earned gold, not net worth. Resource differences are ally minus same-position opponent, without causal attribution.',
  'Known death windows do not reconstruct respawn, position or buyback availability. Missing overlap does not establish presence.',
  'First purchase is a timing of an item type, not continuous ownership or readiness. Uses do not establish target or timeliness.',
  'Connection events do not measure AFK duration. Objective actor is a confirmed last-hit actor, not total contribution. Following-objectives means temporal proximity only (end < time <= end+120).',
  'Counts in phases are known logged events, not guaranteed totals. Events outside match time are retained locally and excluded from phases.',
];
export const catalog: Record<string, CatalogEntry> = Object.fromEntries([...new Set([...summaryFields, ...seriesFields, ...matchFields, ...fightMetrics, 'hero_id', 'position', 'time', 'time_dead', 'start', 'end', 'last_death', 'participation', 'deadShare', 'deadOverlap'])].map(field => [field, { unit: unit(field), meaning: field }]));
