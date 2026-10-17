import { check, object } from './files.js';
import type { Context, Dictionary, Experiment, Raw } from './types.js';

export const targetFields = ['ability_targets', 'damage_targets'];
export const fightMetrics = ['deaths', 'buybacks', 'damage', 'healing', 'gold_delta', 'xp_delta', 'xp_start', 'xp_end'];
export const fightMaps = ['ability_uses', 'ability_targets', 'item_uses', 'killed'];
export const canonicalSlots = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];
export const objectiveFields = ['time', 'type', 'key', 'unit', 'team', 'slot', 'player_slot', 'victim_player_slot', 'killer', 'value'];
export const validPosition = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 5;

export function augmentContext(context: Context, raw: Raw, dict: Dictionary, mapFields: string[], overrides: NonNullable<Experiment['roleOverrides']>): Context {
  const players = (raw.players as unknown[]).map(object);
  const add = (value: unknown, path: string, field: string, playerSlot: number | null): string => {
    const evidenceId = `e${context.evidence.length + 1}`;
    const unit = ['time', 'start', 'end'].includes(field) ? 'seconds' : field.includes('gold') ? 'gold' : field.includes('xp') ? 'xp' : field.includes('damage') || field.includes('healing') ? 'hp' : field === 'position_est' ? 'upstream-role-hypothesis' : 'count-or-upstream-value';
    context.evidence.push({ evidenceId, playerSlot, value, paths: [path], unit, transform: 'identity-v1' });
    return evidenceId;
  };
  const token = (value: string): boolean => [dict.heroes, dict.items, dict.abilities].some(values => Object.hasOwn(values, value)) || /^npc_dota_(?:goodguys|badguys)_(?:tower(?:[1-3]_(?:top|mid|bot)|4(?:_(?:top|mid|bot))?)|(?:melee|range)_rax_(?:top|mid|bot)|fort)$/.test(value);
  const numericMap = (value: unknown, path: string, field: string, slot: number): string[] => {
    if (value === null || (typeof value === 'number' && Number.isFinite(value))) return [add(value, path, field, slot)];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.entries(value).flatMap(([key, child]) => token(key) || /^\d+$/.test(key) ? numericMap(child, `${path}/${key}`, field, slot) : []);
  };
  const manual = overrides.filter(item => item.matchId === context.matchId);
  check(manual.every(item => players.some(player => player.player_slot === item.playerSlot) && validPosition(item.position)) && new Set(manual.map(item => item.playerSlot)).size === manual.length, 'Некорректное ручное назначение роли.');
  for (const slots of [canonicalSlots.slice(0, 5), canonicalSlots.slice(5)]) {
    const team = manual.filter(item => slots.includes(item.playerSlot));
    check(new Set(team.map(item => item.position)).size === team.length, 'Ручные роли команды повторяются.');
  }
  context.roles = players.map((player, index) => {
    const playerSlot = Number(player.player_slot);
    const override = manual.find(item => item.playerSlot === playerSlot);
    if (override) return { playerSlot, position: override.position, source: 'manual', evidenceId: null };
    const position = player.position_est;
    const sameTeam = (slot: number): boolean => (slot < 128) === (playerSlot < 128);
    const conflict = players.some(other => other !== player && sameTeam(Number(other.player_slot)) && other.position_est === position && !manual.some(item => item.playerSlot === other.player_slot)) || manual.some(item => sameTeam(item.playerSlot) && item.position === position);
    if (!validPosition(position) || conflict) {
      context.limitations.push(`slot ${playerSlot}: позиция неизвестна${conflict && validPosition(position) ? ' (противоречивые оценки)' : ''}.`);
      return { playerSlot, position: null, source: 'unknown', evidenceId: null };
    }
    return { playerSlot, position, source: 'opendota-estimate', evidenceId: add(position, `/players/${index}/position_est`, 'position_est', playerSlot) };
  });
  players.forEach((player, index) => {
    for (const field of [...targetFields, ...(context.variant === 'compact-v2' ? mapFields : [])]) {
      numericMap(player[field], `/players/${index}/${field}`, field, Number(player.player_slot));
    }
  });
  const objectives: { time: number; evidenceIds: string[] }[] = [];
  if (Array.isArray(raw.objectives)) raw.objectives.forEach((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    const objective = object(input);
    const evidenceIds: string[] = [];
    for (const field of objectiveFields) {
      const value = objective[field];
      if (value === null || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && (token(value) || (field === 'type' && /^(?:building_kill|CHAT_MESSAGE_(?:TOWER_KILL|BARRACKS_KILL|ROSHAN_KILL|AEGIS|AEGIS_STOLEN|AEGIS_DENIED|FIRSTBLOOD|COURIER_LOST))$/.test(value))))) evidenceIds.push(add(value, `/objectives/${index}/${field}`, field, null));
    }
    if (typeof objective.time === 'number' && Number.isFinite(objective.time)) objectives.push({ time: objective.time, evidenceIds });
  });
  context.fights = [];
  if (Array.isArray(raw.teamfights)) raw.teamfights.forEach((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      context.limitations.push(`teamfight ${index}: неизвестный формат.`);
      return;
    }
    const fight = object(input);
    const scalar = (field: string, path: string, value: unknown, slot: number | null): string | null => typeof value === 'number' && Number.isFinite(value) ? add(value, path, field, slot) : null;
    const card: NonNullable<Context['fights']>[number] = {
      index, start: scalar('start', `/teamfights/${index}/start`, fight.start, null), end: scalar('end', `/teamfights/${index}/end`, fight.end, null),
      deaths: scalar('deaths', `/teamfights/${index}/deaths`, fight.deaths, null), players: [], followingObjectives: [], limitations: [],
    };
    if (Array.isArray(fight.players) && fight.players.length === 10) {
      fight.players.forEach((input, playerIndex) => {
        const playerSlot = canonicalSlots[playerIndex];
        const player = input && typeof input === 'object' && !Array.isArray(input) ? object(input) : {};
        const path = `/teamfights/${index}/players/${playerIndex}`;
        const metrics = Object.fromEntries(fightMetrics.map(field => [field, scalar(field, `${path}/${field}`, player[field], playerSlot)]));
        const evidenceIds = fightMaps.flatMap(field => numericMap(player[field], `${path}/${field}`, field, playerSlot));
        if (Object.values(metrics).some(value => value === null)) card.limitations.push(`slot ${playerSlot}: часть показателей отсутствует.`);
        card.players.push({ playerSlot, metrics, evidenceIds });
      });
    } else card.limitations.push('Неизвестное соответствие участников слотам: нужен канонический массив из 10 элементов.');
    if (typeof fight.end === 'number' && Number.isFinite(fight.end)) card.followingObjectives = objectives.filter(item => item.time > Number(fight.end) && item.time <= Number(fight.end) + 120).flatMap(item => item.evidenceIds);
    context.fights!.push(card);
  });
  else context.limitations.push('teamfights отсутствует или имеет неизвестный формат.');
  context.limitations.push('position_est — оценка OpenDota; manual — явное назначение в эксперименте. 1 carry, 2 mid, 3 offlane, 4 soft support, 5 hard support. Роль не доказывает качество игры.');
  context.limitations.push('Карточки OpenDota охватывают выделенные алгоритмом бои с минимум тремя смертями; незакрытый последний бой может отсутствовать. Нулевой урон в карточке не доказывает AFK. followingObjectives — события в течение 120 секунд после end, только временная связь; не доказательство причины.');
  context.limitations.push('healing в карточке и итоговый hero_healing — разные показатели источника; healing сам по себе не доказывает лечение или спасение союзника.');
  return context;
}
