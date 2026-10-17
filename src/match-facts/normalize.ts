import { canonicalSlots, catalog, countMapFields, dictionaryDigest, dictionaryRevision, eventFields, fightMaps, fightMetrics, logFields, mapFields, matchFields, objectiveFields, objectiveTypes, seriesFields, signedMapFields, summaryFields } from './profile.js';
import { ensure, escapePointer, finite, integer, known, missing, number, object, positive, Registry, sha, state } from './values.js';
import type { Collection, Dictionary, Event, Facts, FactsOptions, FactsOptionsV2, Fields, Fight, Issue, MatchFactsInput, NumericMap, Objective, Observation, Player, Raw, RoleOverride } from './types.js';

const position = (value: unknown): value is number => integer(value) && value >= 1 && value <= 5;
export const sameTeam = (a: number, b: number): boolean => (a < 128) === (b < 128);
export const onSide = (slot: number, side: string): boolean => (slot < 128) === (side === 'radiant');

export function validateDictionary(dict: unknown): asserts dict is Dictionary {
  ensure(object(dict) && dict.version === 1 && dict.revision === dictionaryRevision, 'invalid-dictionary');
  try { ensure(sha(dict) === dictionaryDigest, 'invalid-dictionary'); } catch { ensure(false, 'invalid-dictionary'); }
}

export function validateInputs(input: MatchFactsInput, options: FactsOptions | FactsOptionsV2): { data: Raw; dictionary: Dictionary; overrides: RoleOverride[] } {
  ensure(object(input) && positive(input.matchId) && ['radiant', 'dire'].includes(input.side));
  sha(input.data);
  const data = input.data;
  ensure(object(data) && data.match_id === input.matchId && finite(data.duration) && data.duration > 0 && typeof data.radiant_win === 'boolean' && Array.isArray(data.players), 'unusable-match');
  const slots = new Set<number>();
  for (const player of data.players) {
    ensure(object(player) && integer(player.player_slot) && canonicalSlots.includes(player.player_slot) && !slots.has(player.player_slot) && positive(player.hero_id), 'unusable-match');
    slots.add(player.player_slot);
  }
  ensure(canonicalSlots.filter(slot => onSide(slot, input.side)).every(slot => slots.has(slot)), 'unusable-match');
  ensure(object(options), 'invalid-dictionary');
  const dict = options.dictionary;
  validateDictionary(dict);
  const overrides = options.roleOverrides === undefined ? [] : options.roleOverrides;
  ensure(Array.isArray(overrides), 'invalid-role-override');
  const seen = new Set<number>();
  for (const override of overrides) {
    ensure(object(override) && Object.keys(override).every(key => ['playerSlot', 'position'].includes(key)) && integer(override.playerSlot) && slots.has(override.playerSlot) && !seen.has(override.playerSlot) && position(override.position), 'invalid-role-override');
    ensure(!overrides.some(other => other !== override && object(other) && finite(other.playerSlot) && sameTeam(other.playerSlot, override.playerSlot) && other.position === override.position), 'invalid-role-override');
    seen.add(override.playerSlot);
  }
  return { data, dictionary: dict as unknown as Dictionary, overrides };
}

export function normalize(input: MatchFactsInput, options: FactsOptions | FactsOptionsV2): { facts: Facts; registry: Registry; overrides: RoleOverride[]; dictionary: Dictionary } {
  const { data, dictionary, overrides } = validateInputs(input, options);
  const registry = new Registry();
  const issues: Issue[] = [];
  const issue = (code: string, scope: string, playerSlot?: number, index?: number): void => { issues.push({ code, scope, ...(playerSlot === undefined ? {} : { playerSlot }), ...(index === undefined ? {} : { index }) }); };
  const duration = data.duration as number;
  const scalar = (value: unknown, field: string, slot: number | null, path: string): Observation<number | boolean> => {
    const result = registry.scalar(value, field, slot, path);
    if ('unavailable' in result && result.unavailable === 'invalid') issue('invalid-value', field, slot ?? undefined);
    return result;
  };
  const building = (key: string): boolean => /^npc_dota_(?:goodguys|badguys)_(?:tower(?:[1-3]_(?:top|mid|bot)|4(?:_(?:top|mid|bot))?)|(?:melee|range)_rax_(?:top|mid|bot)|fort)$/.test(key);
  const token = (key: string): boolean => [dictionary.heroes, dictionary.items, dictionary.abilities].some(values => Object.hasOwn(values, key)) || building(key);
  const map = (value: unknown, field: string, slot: number, path: string): NumericMap => {
    if (!object(value)) { if (value !== undefined && value !== null) issue('invalid-map', field, slot); return { state: state(value), entries: {}, excluded: 0 }; }
    let excluded = 0;
    const entries: NumericMap['entries'] = {};
    for (const key of Object.keys(value).sort()) {
      const service = ['damage_inflictor', 'damage_inflictor_received', 'healing'].includes(field) && ['', 'null'].includes(key);
      if (!(token(key) || /^\d+$/.test(key) || service)) { excluded++; continue; }
      const child = value[key], pointer = `${path}/${escapePointer(key)}`;
      if (object(child)) { const nested = map(child, field, slot, pointer); entries[key] = nested; excluded += nested.excluded; }
      else {
        const valid = finite(child) && (child >= 0 || signedMapFields.has(field)) && (!countMapFields.has(field) || integer(child));
        entries[key] = valid ? registry.add(child, field, slot, [pointer]) : missing(child);
        if (child !== null && !valid) excluded++;
      }
    }
    if (excluded) issue('partial-map', field, slot);
    return { state: 'present', entries, excluded };
  };
  const eventValue = (value: unknown, field: string, slot: number | null, path: string, scope: string): Observation<number | string | boolean> => {
    if (['key', 'unit', 'type', 'event'].includes(field)) {
      if (field === 'key' && integer(value)) return registry.add(value, field, slot, [path]);
      const allowed = typeof value === 'string' && (token(value) || /^\d+$/.test(value) || (field === 'type' && [...objectiveTypes, ...logFields].includes(value)) || (field === 'event' && ['disconnect', 'reconnect'].includes(value)));
      if (allowed) return registry.add(value as string, field, slot, [path]);
      if (value !== undefined && value !== null) issue('unknown-token', scope, slot ?? undefined);
      if (field === 'type' && typeof value === 'string') return registry.add('unknown', field, slot, [path], 'unknown-type-v1');
      return missing(value);
    }
    return scalar(value, field, slot, path);
  };
  const events = (value: unknown, scope: string, slot: number | null, path: string, allowed = eventFields): Collection<Event> => {
    if (!Array.isArray(value)) return { state: state(value), count: missing(value), entries: [], excluded: 0 };
    let excluded = 0;
    const entries = Array.from(value, (raw, index): Event => {
      if (!object(raw)) { excluded++; issue('invalid-event', scope, slot ?? undefined, index); return { index, fields: { time: missing(raw) } }; }
      const fields: Fields = {};
      for (const field of allowed) if (Object.hasOwn(raw, field) || field === 'time' || (scope === 'deaths_log' && field === 'time_dead')) fields[field] = eventValue(raw[field], field, slot, `${path}/${index}/${field}`, scope);
      if (number(fields.time) === undefined || Object.values(fields).some(v => 'unavailable' in v && v.unavailable === 'invalid')) excluded++;
      const time = number(fields.time);
      if (time !== undefined && (time < 0 || time > duration)) issue('outside-match-time', scope, slot ?? undefined, index);
      return { index, fields };
    });
    entries.sort((a, b) => (number(a.fields.time) ?? Infinity) - (number(b.fields.time) ?? Infinity) || a.index - b.index);
    return { state: 'present', count: registry.add(value.length, 'count', slot, [path], 'array-length-v1'), entries, excluded };
  };
  const metadata: Fields = Object.fromEntries(matchFields.map(field => [field, scalar(data[field], field, null, `/${field}`)]));
  const rawPlayers = (data.players as Raw[]).map((raw, index) => ({ raw, index })).sort((a, b) => Number(a.raw.player_slot) - Number(b.raw.player_slot));
  const players = rawPlayers.map(({ raw, index }): Player => {
    const slot = raw.player_slot as number, path = `/players/${index}`;
    const heroId = raw.hero_id as number;
    if (!dictionary.heroes[String(heroId)]) issue('unknown-hero', 'hero_id', slot);
    const hero = registry.add(heroId, 'hero_id', slot, [`${path}/hero_id`]);
    const summary: Fields = Object.fromEntries(summaryFields.map(field => [field, scalar(raw[field], field, slot, `${path}/${field}`)]));
    const upstream = scalar(raw.position_est, 'position_est', slot, `${path}/position_est`);
    const manualIndex = overrides.findIndex(role => role.playerSlot === slot);
    const conflict = rawPlayers.some(other => other.raw !== raw && sameTeam(Number(other.raw.player_slot), slot) && !overrides.some(role => role.playerSlot === other.raw.player_slot) && other.raw.position_est === raw.position_est)
      || overrides.some(role => sameTeam(role.playerSlot, slot) && role.position === raw.position_est);
    const role: Player['role'] = manualIndex >= 0 ? { position: registry.add(overrides[manualIndex].position, 'position', slot, [`/roleOverrides/${manualIndex}/position`], 'identity-v1', [], 'override'), source: 'manual' }
      : position(raw.position_est) && !conflict ? { position: upstream as Observation, source: 'opendota-estimate' }
      : { position: missing(raw.position_est, conflict && position(raw.position_est) ? 'conflicting-positions' : 'unknown-position'), source: 'unknown' };
    if (role.source === 'unknown') issue('unknown-position', 'role', slot);
    const maps = Object.fromEntries(mapFields.map(field => [field, map(raw[field], field, slot, `${path}/${field}`)]));
    const logs = Object.fromEntries(logFields.map(field => [field, events(raw[field], field, slot, `${path}/${field}`)]));
    const slices: Player['slices'] = {}, deltas: Player['deltas'] = {};
    const times = raw.times;
    for (const minute of [10, 20, 30]) {
      slices[minute] = {};
      for (const field of seriesFields) {
        const values = raw[field];
        let observation: Observation = missing(undefined, 'unreached');
        if (minute * 60 <= duration) {
          if (!Array.isArray(times)) observation = missing(times, 'times-unavailable');
          else if (!Array.isArray(values)) observation = missing(values, 'series-unavailable');
          else {
            const indices = times.flatMap((time, i) => time === minute * 60 ? [i] : []);
            const at = indices[0];
            if (indices.length !== 1 || times.length !== values.length || !times.every(finite)) observation = missing('', 'inconsistent-series');
            else if (!finite(values[at]) || values[at] < 0 || ['lh_t', 'dn_t'].includes(field) && !integer(values[at])) observation = missing(values[at] === null ? null : 'invalid');
            else observation = registry.add(values[at], field, slot, [`${path}/times/${at}`, `${path}/${field}/${at}`], `slice-${minute}m-v1`);
          }
        }
        slices[minute][field] = observation;
      }
    }
    for (const [from, to] of [[10, 20], [20, 30]]) deltas[`${from}-${to}`] = Object.fromEntries(seriesFields.map(field => {
      const a = slices[from][field], b = slices[to][field];
      return [field, known(a) && known(b) ? registry.derive(b.value - a.value, field, slot, `delta-${from}-${to}m-v1`, [a, b]) : missing(undefined, 'slice-unavailable')];
    }));
    const score = metadata[slot < 128 ? 'radiant_score' : 'dire_score'];
    const kills = number(summary.kills), assists = number(summary.assists), teamScore = number(score);
    const participation = kills !== undefined && assists !== undefined && teamScore !== undefined && teamScore > 0 && kills + assists <= teamScore
      ? registry.derive((kills + assists) / teamScore, 'participation', slot, 'kill-participation-v1', [summary.kills, summary.assists, score]) : missing(undefined, 'invalid-denominator-or-counts');
    if (kills !== undefined && assists !== undefined && teamScore !== undefined && kills + assists > teamScore) issue('participation-exceeds-score', 'participation', slot);
    const dead = number(summary.life_state_dead);
    const deadShare = dead !== undefined && dead <= duration ? registry.derive(dead / duration, 'deadShare', slot, 'dead-share-v1', [summary.life_state_dead, metadata.duration]) : missing(undefined, 'invalid-dead-time');
    if (dead !== undefined && dead > duration) issue('dead-time-exceeds-duration', 'deadShare', slot);
    const deadWindows: Player['deadWindows'] = [];
    for (const event of logs.deaths_log.entries) {
      const time = number(event.fields.time), seconds = number(event.fields.time_dead);
      if (time === undefined || seconds === undefined) continue;
      const from = Math.max(0, time), to = Math.min(duration, time + seconds);
      if (to > from) deadWindows.push({ deathIndex: event.index,
        start: registry.derive(from, 'time', slot, 'dead-window-v1', [event.fields.time, event.fields.time_dead, metadata.duration], { endpoint: 0 }),
        end: registry.derive(to, 'time', slot, 'dead-window-v1', [event.fields.time, event.fields.time_dead, metadata.duration], { endpoint: 1 }),
      });
    }
    return { playerSlot: slot, heroId, heroName: dictionary.heroes[String(heroId)] ?? null, hero, role, summary: { ...summary, position_est: upstream }, maps, logs, slices, deltas, participation, deadShare, deadWindows };
  });
  const rawObjectives = events(data.objectives, 'objectives', null, '/objectives', objectiveFields);
  const objectives: Collection<Objective> = { ...rawObjectives, entries: rawObjectives.entries.map(event => {
    const raw = (data.objectives as unknown[])[event.index];
    let actor: Observation = missing(undefined, 'unconfirmed-actor');
    let actorSource: Objective['actorSource'] = 'unknown';
    if (object(raw)) {
      const playerSlot = number(event.fields.player_slot);
      const slot = number(event.fields.slot);
      const unit = event.fields.unit && known(event.fields.unit) ? event.fields.unit.value : undefined;
      const heroMatches = typeof unit === 'string' && unit.startsWith('npc_dota_hero_') ? players.filter(player => dictionary.heroes[unit] && dictionary.heroes[unit] === player.heroName) : [];
      const direct = playerSlot !== undefined && players.some(player => player.playerSlot === playerSlot) ? playerSlot : undefined;
      const mapped = slot !== undefined && slot < canonicalSlots.length && players.some(player => player.playerSlot === canonicalSlots[slot]) ? canonicalSlots[slot] : undefined;
      const creep = typeof raw.unit === 'string' && !raw.unit.startsWith('npc_dota_hero_');
      const conflict = direct !== undefined && mapped !== undefined && direct !== mapped || heroMatches.length === 1 && (direct !== undefined && direct !== heroMatches[0].playerSlot || mapped !== undefined && mapped !== heroMatches[0].playerSlot);
      if (!creep && !conflict && direct !== undefined) { actor = registry.derive(direct, 'player_slot', direct, 'objective-actor-v1', [event.fields.player_slot]); actorSource = 'player_slot'; }
      else if (!creep && !conflict && mapped !== undefined) { actor = registry.derive(mapped, 'player_slot', mapped, 'objective-actor-v1', [event.fields.slot]); actorSource = 'canonical-slot'; }
      else if (!creep && !conflict && heroMatches.length === 1) { actor = registry.derive(heroMatches[0].playerSlot, 'player_slot', heroMatches[0].playerSlot, 'objective-actor-v1', [event.fields.unit, heroMatches[0].hero]); actorSource = 'hero-unit'; }
      if (conflict) issue('conflicting-actor', 'objectives', undefined, event.index);
    }
    return { ...event, actor, actorSource };
  }) };
  const fights: Collection<Fight> = { state: Array.isArray(data.teamfights) ? 'present' : state(data.teamfights), count: Array.isArray(data.teamfights) ? registry.add(data.teamfights.length, 'count', null, ['/teamfights'], 'array-length-v1') : missing(data.teamfights), entries: [], excluded: 0 };
  if (Array.isArray(data.teamfights)) data.teamfights.forEach((value, index) => {
    const raw = object(value) ? value : {};
    const path = `/teamfights/${index}`;
    const header = Object.fromEntries(['start', 'end', 'last_death', 'deaths'].map(field => [field, scalar(raw[field], field, null, `${path}/${field}`)]));
    const card: Fight = { index, header, players: [], participantDeaths: missing(undefined), quality: [], followingObjectives: [], overlaps: [] };
    if (!object(value)) { card.quality.push('invalid-card'); fights.excluded++; }
    if (Array.isArray(raw.players) && raw.players.length === 10) raw.players.forEach((value, playerIndex) => {
      const player = object(value) ? value : {};
      const slot = canonicalSlots[playerIndex], pp = `${path}/players/${playerIndex}`;
      if (!object(value) || !Object.keys(player).length) card.quality.push(`unavailable-player-${slot}`);
      card.players.push({ playerSlot: slot,
        metrics: Object.fromEntries(fightMetrics.map(field => [field, scalar(player[field], field, slot, `${pp}/${field}`)])),
        maps: Object.fromEntries(fightMaps.map(field => [field, map(player[field], field, slot, `${pp}/${field}`)])),
      });
    }); else card.quality.push('unknown-player-mapping');
    if (card.players.length === 10 && card.players.every(player => number(player.metrics.deaths) !== undefined)) {
      card.participantDeaths = registry.derive(card.players.reduce((sum, player) => sum + number(player.metrics.deaths)!, 0), 'deaths', null, 'fight-deaths-sum-v1', card.players.map(player => player.metrics.deaths));
      if (number(header.deaths) !== undefined && number(header.deaths) !== card.participantDeaths.value) card.quality.push('inconsistent-death-counts');
    }
    const start = number(header.start), end = number(header.end);
    if (start === undefined || end === undefined || end < start) card.quality.push('invalid-fight-times');
    else {
      for (const objective of objectives.entries) {
        const time = number(objective.fields.time);
        if (time !== undefined && time > end && time <= end + 120) card.followingObjectives.push({ objectiveIndex: objective.index, time: registry.derive(time, 'time', null, 'following-objectives-v1', [header.end, objective.fields.time]) });
      }
      for (const player of players) for (const window of player.deadWindows) {
        const from = Math.max(start, window.start.value), to = Math.min(end, window.end.value);
        if (to > from) card.overlaps.push({ playerSlot: player.playerSlot, deathIndex: window.deathIndex,
          start: registry.derive(from, 'time', player.playerSlot, 'interval-overlap-v1', [window.start, window.end, header.start, header.end], { endpoint: 0 }),
          end: registry.derive(to, 'time', player.playerSlot, 'interval-overlap-v1', [window.start, window.end, header.start, header.end], { endpoint: 1 }),
        });
      }
    }
    fights.entries.push(card);
  });
  const parseState = positive(data.version) ? 'parsed' : 'basic';
  const facts: Facts = { version: 1, format: 'facts-v1', matchId: input.matchId, side: input.side, match: metadata, catalog: structuredClone(catalog), players, fights, objectives,
    quality: { parseState, missingOpponentSlots: canonicalSlots.filter(slot => !onSide(slot, input.side) && !players.some(player => player.playerSlot === slot)), issues }, derived: {},
  };
  return { facts, registry, overrides, dictionary };
}
