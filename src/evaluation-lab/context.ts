import { Ajv } from 'ajv';
import { check, nonnegative, object, pointer, positiveInt, version } from './files.js';
import { inspectMatch, slotsFor } from './corpus.js';
import { augmentContext, canonicalSlots, fightMaps, fightMetrics, objectiveFields, targetFields } from './context-v2.js';
import type { Analysis, Context, Dictionary, Entry, Experiment, Fact, Profile, Raw, Review, Variant } from './types.js';

export const summaryFields = [
  'kills', 'deaths', 'assists', 'last_hits', 'denies', 'gold_per_min', 'xp_per_min', 'net_worth', 'total_gold', 'total_xp',
  'hero_damage', 'tower_damage', 'hero_healing', 'level', 'gold_spent', 'obs_placed', 'sen_placed', 'observer_kills',
  'sentry_kills', 'camps_stacked', 'rune_pickups', 'stuns', 'teamfight_participation', 'towers_killed', 'roshans_killed',
  'firstblood_claimed', 'buyback_count', 'life_state_dead', 'lane', 'lane_role', 'is_roaming', 'lane_efficiency_pct',
  'item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5', 'backpack_0', 'backpack_1', 'backpack_2', 'item_neutral',
];
export const seriesFields = ['times', 'gold_t', 'xp_t', 'lh_t', 'dn_t', 'networth_t', 'hero_damage_t', 'hero_healing_t', 'tower_damage_t'];
export const logFields = ['purchase_log', 'kills_log', 'deaths_log', 'buyback_log', 'runes_log', 'obs_log', 'sen_log', 'obs_left_log', 'sen_left_log', 'connection_log'];
export const mapFields = ['damage', 'damage_taken', 'hero_hits', 'killed', 'killed_by', 'item_uses', 'ability_uses', 'damage_inflictor', 'damage_inflictor_received', 'healing', 'gold_reasons', 'xp_reasons'];
const eventKeys = new Set(['time', 'time_dead', 'gold_fed', 'gold_lost', 'key', 'x', 'y', 'z', 'slot', 'player_slot', 'unit', 'team', 'type', 'start', 'end', 'last_death', 'deaths', 'buybacks', 'damage', 'healing', 'gold_delta', 'xp_delta', 'xp_start', 'xp_end', 'gold_start', 'gold_end', 'level', 'killed', 'players', 'ability_uses', 'ability_targets', 'item_uses', 'deaths_pos', 'null', '']);
const eventTypes = new Set(['CHAT_MESSAGE_TOWER_KILL', 'CHAT_MESSAGE_BARRACKS_KILL', 'CHAT_MESSAGE_ROSHAN_KILL', 'CHAT_MESSAGE_AEGIS', 'CHAT_MESSAGE_AEGIS_STOLEN', 'CHAT_MESSAGE_AEGIS_DENIED', 'CHAT_MESSAGE_FIRSTBLOOD', 'CHAT_MESSAGE_COURIER_LOST']);
export const matchFields = ['duration', 'radiant_win', 'game_mode', 'lobby_type', 'patch', 'start_time', 'version', 'radiant_score', 'dire_score', 'tower_status_radiant', 'tower_status_dire', 'barracks_status_radiant', 'barracks_status_dire'];
export const contextFields = {
  summary: summaryFields, series: seriesFields, logs: logFields, maps: mapFields, match: matchFields,
  eventKeys: [...eventKeys], eventTypes: [...eventTypes],
  excluded: ['chat', 'personaname', 'name', 'account_id', 'avatars', 'urls', 'unknown-fields', 'untrusted-strings'],
};
export const contextFieldsV2 = { ...contextFields, roles: ['position_est', 'roleOverrides'], targets: targetFields, fightMetrics, fightMaps, objectiveFields, objectiveTypes: [...eventTypes, 'building_kill'], buildingTokens: ['tower1-3-lane', 'tower4-with-optional-lane', 'melee-range-rax-lane', 'fort'], fightMapping: ['canonical-0-9-to-player-slot'], objectiveWindow: ['after-end-120s-temporal-only'] };
export const variantsFor = (profile: Profile): Variant[] => profile.contextVersion === 2 ? ['full-v2', 'compact-v2'] : ['full-v1', 'compact-v1'];

export function validateProfile(input: unknown): Profile {
  const p = version(input);
  check(typeof p.id === 'string' && p.model === 'xiaomi/mimo-v2.6-pro' && nonnegative(p.temperature) && p.temperature <= 2 && positiveInt(p.maxTokens) && positiveInt(p.maxRequestBytes), 'Некорректный профиль модели.');
  const provider = object(p.provider);
  check(provider.require_parameters === true && Object.keys(provider).every(key => ['require_parameters', 'only', 'allow_fallbacks'].includes(key)), 'Некорректный маршрут модели.');
  check(provider.only === undefined || (Array.isArray(provider.only) && provider.only.length > 0 && provider.only.every(item => typeof item === 'string' && /^[\w/.-]+$/.test(item))), 'Некорректные провайдеры.');
  check(provider.allow_fallbacks === undefined || typeof provider.allow_fallbacks === 'boolean', 'Некорректный fallback.');
  check(p.reasoning === 'upstream-default' && typeof p.dictionary === 'string', 'Нужны версия справочника и reasoning upstream default.');
  check((p.contextVersion === undefined || p.contextVersion === 1 || p.contextVersion === 2) && (p.analysisVersion === undefined || p.analysisVersion === 1 || p.analysisVersion === 2) && (p.contextVersion ?? 1) === (p.analysisVersion ?? 1), 'Несовместимые версии контекста и ответа.');
  check(JSON.stringify(p.contextFields) === JSON.stringify(p.contextVersion === 2 ? contextFieldsV2 : contextFields), 'Allowlist полей профиля не соответствует версии контекста.');
  check(Array.isArray(p.rankedLobbyIds) && p.rankedLobbyIds.length > 0 && p.rankedLobbyIds.every(positiveInt) && Array.isArray(p.gameModeIds) && p.gameModeIds.length > 0 && p.gameModeIds.every(positiveInt), 'Некорректный профиль режимов.');
  return p as unknown as Profile;
}

export function validateDictionary(input: unknown): Dictionary {
  const d = version(input);
  check(typeof d.revision === 'string' && typeof d.source === 'string', 'Неизвестная версия справочника.');
  for (const values of [d.heroes, d.items, d.abilities]) check(Object.entries(object(values)).every(([key, value]) => /^[\w]+$/.test(key) && typeof value === 'string' && value.length < 150), 'Некорректный справочник.');
  return d as unknown as Dictionary;
}

function unit(field: string): string {
  if (['time', 'times', 'time_dead', 'start', 'end', 'duration', 'stuns', 'life_state_dead'].includes(field)) return 'seconds';
  if (field.includes('gold') || field === 'net_worth' || field === 'networth_t') return field === 'gold_per_min' ? 'gold/minute' : 'gold';
  if (field.includes('xp')) return field === 'xp_per_min' ? 'xp/minute' : 'xp';
  if (field.includes('damage') || field.includes('healing')) return 'hp';
  if (field === 'lane_role' || field === 'lane') return 'upstream-role-hypothesis';
  return 'count-or-upstream-value';
}

export function buildContext(raw: unknown, entry: Entry, variant: Variant, profile: Profile, dict: Dictionary, overrides: NonNullable<Experiment['roleOverrides']> = []): Context {
  check(variantsFor(profile).includes(variant), 'Контекст не соответствует версии профиля.');
  check(variant.endsWith('v2') || !overrides.length, 'Ручные роли поддерживаются в v2.');
  const { data, players, limitations } = inspectMatch(raw, entry, profile);
  const context: Context = {
    version: 1, variant, matchId: entry.matchId, side: entry.side, duration: Number(data.duration), radiantWin: Boolean(data.radiant_win),
    parseState: typeof data.version === 'number' && data.version > 0 ? 'parsed' : 'basic', dictionaryRevision: dict.revision,
    indexToSlot: players.map(player => Number(player.player_slot)),
    players: players.map(player => ({ playerSlot: Number(player.player_slot), heroId: Number(player.hero_id), heroName: dict.heroes[String(player.hero_id)] ?? null, assumedRole: null })),
    items: [], limitations, evidence: [],
  };
  if (entry.source === 'derived-fixture') limitations.push('Производная фикстура; это не наблюдавшееся состояние API.');
  for (const player of context.players) if (player.heroName === null) limitations.push(`Неизвестный hero ID ${player.heroId}.`);
  const add = (value: unknown, path: string, field: string, slot: number | null, transform = 'identity-v1', paths = [path]): void => {
    context.evidence.push({ evidenceId: `e${context.evidence.length + 1}`, playerSlot: slot, value, unit: unit(field), paths, transform });
  };
  const token = (value: string): boolean => Object.hasOwn(dict.items, value) || Object.hasOwn(dict.heroes, value) || Object.hasOwn(dict.abilities, value) || eventTypes.has(value) || /^npc_dota_(?:goodguys|badguys)_(?:tower[1-4]_(?:top|mid|bot)|(?:melee|range)_rax_(?:top|mid|bot)|fort)$/.test(value);
  const walk = (value: unknown, path: string, field: string, slot: number | null): void => {
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && token(value))) add(value, path, field, slot);
    else if (Array.isArray(value)) {
      if (!value.length) add([], path, field, slot);
      value.forEach((v, index) => walk(v, `${path}/${index}`, field, slot));
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) if (eventKeys.has(key) || /^\d+$/.test(key) || token(key)) walk(child, `${path}/${key}`, key, slot);
    }
  };
  for (const field of matchFields) {
    if (Object.hasOwn(data, field)) walk(data[field], `/${field}`, field, null);
  }
  players.forEach((player, index) => {
    const slot = Number(player.player_slot);
    for (const field of ['hero_id', ...summaryFields]) if (Object.hasOwn(player, field)) walk(player[field], `/players/${index}/${field}`, field, slot);
    for (const field of summaryFields.filter(field => field.startsWith('item_') || field.startsWith('backpack_'))) {
      const item = player[field];
      if (typeof item === 'number' && item > 0 && !context.items.some(value => value.itemId === item)) context.items.push({ itemId: item, name: dict.items[String(item)] ?? null });
      if (typeof item === 'number' && item > 0 && !dict.items[String(item)]) limitations.push(`slot ${slot}: неизвестный item ID ${item}.`);
    }
    if (variant.startsWith('full-')) {
      for (const field of [...seriesFields, ...logFields, ...mapFields]) if (Object.hasOwn(player, field)) walk(player[field], `/players/${index}/${field}`, field, slot);
    } else {
      for (const minute of [10, 20, 30]) {
        const times = player.times;
        if (context.duration < minute * 60 || !Array.isArray(times)) continue;
        const at = times.indexOf(minute * 60);
        if (at < 0) continue;
        for (const field of seriesFields.filter(field => field !== 'times')) {
          const values = player[field];
          if (Array.isArray(values) && at < values.length && nonnegative(values[at])) {
            add(values[at], `/players/${index}/${field}/${at}`, field, slot, `slice-${minute}m-v1`, [`/players/${index}/times/${at}`, `/players/${index}/${field}/${at}`]);
          }
        }
      }
      for (const [from, to] of [[10, 20], [20, 30]]) {
        const times = player.times;
        if (context.duration < to * 60 || !Array.isArray(times)) continue;
        const first = times.indexOf(from * 60), last = times.indexOf(to * 60);
        if (first < 0 || last < 0) continue;
        for (const field of seriesFields.filter(field => field !== 'times')) {
          const values = player[field];
          if (Array.isArray(values) && nonnegative(values[first]) && nonnegative(values[last])) {
            add(values[last] - values[first], '', field, slot, `delta-${from}-${to}m-v1`, [`/players/${index}/times/${first}`, `/players/${index}/${field}/${first}`, `/players/${index}/times/${last}`, `/players/${index}/${field}/${last}`]);
          }
        }
      }
      for (const field of logFields) {
        const events = player[field];
        if (Array.isArray(events)) {
          add(events.length, `/players/${index}/${field}`, 'count', slot, 'array-length-v1');
          if (['purchase_log', 'buyback_log', 'kills_log', 'deaths_log'].includes(field)) walk(events, `/players/${index}/${field}`, field, slot);
        } else if (Object.hasOwn(player, field)) walk(events, `/players/${index}/${field}`, field, slot);
      }
    }
  });
  for (const field of [...(variant.endsWith('v1') ? ['objectives'] : []), ...(variant === 'full-v1' ? ['teamfights'] : []), ...(variant.startsWith('full-') ? ['radiant_gold_adv', 'radiant_xp_adv'] : [])]) {
    if (Object.hasOwn(data, field)) walk(data[field], `/${field}`, field, null);
  }
  if (variant === 'compact-v1' && Array.isArray(data.teamfights)) add(data.teamfights.length, '/teamfights', 'count', null, 'array-length-v1');
  limitations.push('lane/lane_role — предположение OpenDota, не подтверждённое назначение роли. Отсутствие событий не заполняется нулями.');
  return variant.endsWith('v2') ? augmentContext(context, data, dict, mapFields, overrides) : context;
}

export function verifyEvidence(context: Context, raw: Raw): void {
  const players = raw.players;
  check(Array.isArray(players) && context.indexToSlot.every((slot, i) => object(players[i]).player_slot === slot), 'Нарушена связь индекса со слотом.');
  for (const evidence of context.evidence) {
    const values = evidence.paths.map(path => pointer(raw, path));
    const value = evidence.transform === 'array-length-v1' ? (check(Array.isArray(values[0]), 'Нет массива для счётчика.'), values[0].length)
      : evidence.transform.startsWith('delta-') ? Number(values[3]) - Number(values[1]) : values.at(-1);
    check(JSON.stringify(value) === JSON.stringify(evidence.value), 'Основание не совпадает со снимком.');
    for (const path of evidence.paths) {
      const match = /^\/players\/(\d+)\//.exec(path);
      if (match) check(context.indexToSlot[Number(match[1])] === evidence.playerSlot, 'Основание относится к другому слоту.');
      const fight = /^\/teamfights\/\d+\/players\/(\d+)\//.exec(path);
      if (fight && context.variant.endsWith('v2')) check(canonicalSlots[Number(fight[1])] === evidence.playerSlot, 'Участник драки относится к другому слоту.');
    }
  }
}

export function validateAnalysis(input: unknown, context: Context, schema: object): Analysis {
  const ajv = new Ajv({ allErrors: false });
  const validate = ajv.compile(schema);
  check(validate(input), `Ответ не соответствует analysis-${context.variant.endsWith('v2') ? 'v2' : 'v1'}.`, 'invalid-output');
  const data = input as Analysis;
  const players = data.selectedPlayers;
  check(data.status === 'selected' ? players.length >= 1 && players.length <= 2 : players.length === 0 && data.limitations.length > 0, 'Выбор не соответствует статусу.', 'invalid-output');
  const slots = slotsFor(context.side);
  check(new Set(players.map(player => player.playerSlot)).size === players.length && players.every(player => slots.includes(player.playerSlot)), 'Выбран повторный или вражеский слот.', 'invalid-output');
  const evidenceIds = new Set(context.evidence.map(evidence => evidence.evidenceId));
  check(players.every(player => player.reasons.every(reason => reason.evidenceIds.every(evidenceId => evidenceIds.has(evidenceId)))), 'Ссылка на отсутствующее основание.', 'invalid-output');
  if (context.variant.endsWith('v2')) {
    check(['low', 'medium', 'high'].includes(String(data.confidence)) && Array.isArray(data.playerAssessments) && data.playerAssessments.length === 5, 'Нужны уверенность и оценки пятерых.', 'invalid-output');
    const assessments = data.playerAssessments!;
    check(new Set(assessments.map(player => player.playerSlot)).size === 5 && assessments.every(player => slots.includes(player.playerSlot) && player.position === context.roles?.find(role => role.playerSlot === player.playerSlot)?.position), 'Состав или позиции оценок не совпадают с контекстом.', 'invalid-output');
    check(assessments.every(player => (player.resources !== null && player.counterargument !== null && player.contributions.length + player.concerns.length > 0) || player.limitations.length > 0), 'Пропуски оценки требуют объяснения.', 'invalid-output');
    if (data.status === 'selected' && players.length === 1) check(data.closestAlternative && slots.includes(data.closestAlternative.playerSlot) && !players.some(player => player.playerSlot === data.closestAlternative!.playerSlot), 'Нужна ближайшая союзная альтернатива.', 'invalid-output');
    else check(data.closestAlternative === null, 'Альтернатива нужна только при выборе одного игрока.', 'invalid-output');
    check(analysisClaims(data).every(claim => claim.fact.evidenceIds.length > 0 && claim.fact.evidenceIds.every(id => evidenceIds.has(id))), 'Ссылка оценки на отсутствующее основание.', 'invalid-output');
  }
  return data;
}

export function analysisClaims(analysis: Analysis): { address: Omit<Review['claims'][number], 'verdict'>; fact: Fact }[] {
  const claims: ReturnType<typeof analysisClaims> = analysis.selectedPlayers.flatMap(player => player.reasons.map((fact, reasonIndex) => ({ address: { playerSlot: player.playerSlot, reasonIndex }, fact })));
  for (const player of analysis.playerAssessments ?? []) {
    for (const section of ['resources', 'contributions', 'concerns', 'counterargument'] as const) {
      const value = player[section];
      const facts = value === null ? [] : Array.isArray(value) ? value : [value];
      claims.push(...facts.map((fact, reasonIndex) => ({ address: { playerSlot: player.playerSlot, section, reasonIndex }, fact })));
    }
  }
  if (analysis.closestAlternative) claims.push({ address: { playerSlot: analysis.closestAlternative.playerSlot, section: 'alternative', reasonIndex: 0 }, fact: analysis.closestAlternative.reason });
  return claims;
}
