import { allyMetrics, briefFightMetrics, briefSeries, catalog, itemFields, limitations, logFields, mapFields, opponentMetrics, phaseLogs } from './profile.js';
import { onSide } from './normalize.js';
import { known, missing, number, Registry } from './values.js';
import type { Brief, BriefPlayer, Collection, Coverage, Dictionary, Event, Facts, Fields, NumericMap, Observation, Phase, Player } from './types.js';

const pick = <T>(values: Record<string, T>, fields: string[]): Record<string, T> => Object.fromEntries(fields.map(field => [field, values[field]]));
const count = (log: Collection<unknown>): number | undefined => number(log.count);
const coverage = (log: Collection<unknown>, representation: Coverage['representation'], reportedCount: number, excluded = log.excluded): Coverage => ({ sourceState: log.state, representation, ...(count(log) === undefined ? {} : { sourceCount: count(log), reportedCount }), ...(excluded ? { excluded } : {}) });

export function buildBrief(facts: Facts, registry: Registry, dictionary: Dictionary): Brief {
  const duration = number(facts.match.duration)!;
  const ally = (player: Player): boolean => onSide(player.playerSlot, facts.side);
  const completeRoles = facts.players.length === 10 && [true, false].every(team => {
    const positions = facts.players.filter(player => (player.playerSlot < 128) === team).map(player => number(player.role.position));
    return positions.length === 5 && positions.every(value => value !== undefined) && new Set(positions).size === 5;
  });
  const playerBrief = (player: Player): BriefPlayer => {
    const isAlly = ally(player), slot = player.playerSlot;
    const row: BriefPlayer = {
      playerSlot: slot, heroId: player.heroId, heroName: player.heroName, hero: player.hero, role: player.role,
      metrics: registry.group({ ...pick(player.summary, isAlly ? allyMetrics : opponentMetrics), ...(isAlly ? { participation: player.participation, deadShare: player.deadShare } : {}) }, 'summary-group', slot),
      economy: Object.fromEntries([10, 20, 30].map(minute => [minute, registry.group(pick(player.slices[minute], briefSeries), 'economy-group', slot)])), coverage: { states: {}, sourceCounts: {}, reportedCounts: {}, defaultReportedCount: 0, excluded: {} },
    };
    const addCoverage = (field: string, value: Coverage): void => {
      (row.coverage.states[value.sourceState] ??= []).push(field);
      if (value.sourceCount !== undefined) row.coverage.sourceCounts[field] = value.sourceCount;
      if (value.reportedCount) row.coverage.reportedCounts[field] = value.reportedCount;
      if (value.excluded) row.coverage.excluded[field] = value.excluded;
    };
    for (const [field, log] of Object.entries(player.logs)) {
      const aggregated = isAlly && [...phaseLogs, 'connection_log', 'buyback_log'].includes(field);
      const reported = field === 'buyback_log' ? log.entries.filter(event => number(event.fields.time) !== undefined).length : aggregated ? 4 : 0;
      const unassigned = phaseLogs.includes(field) ? log.entries.filter(event => { const time = number(event.fields.time); return time === undefined || time < 0 || time > duration; }).length : log.excluded;
      addCoverage(field, coverage(log, aggregated ? 'aggregate' : 'local-only', reported, unassigned));
    }
    for (const [field, map] of Object.entries(player.maps)) addCoverage(field, { sourceState: map.state, representation: isAlly && field === 'ability_uses' ? 'direct' : 'local-only', ...(map.state === 'present' ? { sourceCount: Object.keys(map.entries).length, reportedCount: isAlly && field === 'ability_uses' ? Object.values(map.entries).filter(value => 'id' in value).length : 0 } : {}), ...(map.excluded ? { excluded: map.excluded } : {}) });
    addCoverage('summary', { sourceState: 'present', representation: 'direct', sourceCount: Object.keys(player.summary).length, reportedCount: Object.keys(row.metrics.value).length });
    addCoverage('slices', { sourceState: 'present', representation: 'direct', sourceCount: 24, reportedCount: 12 });
    if (!isAlly) return row;
    const opponent = completeRoles ? facts.players.find(other => !ally(other) && number(other.role.position) === number(player.role.position)) : undefined;
    row.comparisons = { opponentSlot: opponent?.playerSlot ?? null, ...(!opponent ? { reason: 'incomplete-or-ambiguous-roles' } : {}), values: {} };
    for (const minute of [10, 20, 30]) row.comparisons.values[minute] = registry.group(Object.fromEntries(['gold_t', 'networth_t', 'xp_t'].map(field => {
      const a = player.slices[minute][field], b = opponent?.slices[minute][field];
      return [field, opponent && known(a) && b && known(b) ? registry.derive(a.value - b.value, field, slot, 'same-position-difference-v1', [a, b, player.role.position, opponent.role.position]) : missing(undefined, opponent ? 'slice-unavailable' : 'roles-unavailable')];
    })), 'same-position-group', slot);
    row.items = pick(player.summary, itemFields);
    const uniqueItems = itemFields.filter((field, i) => { const id = number(player.summary[field]); return id !== undefined && id > 0 && itemFields.findIndex(other => number(player.summary[other]) === id) === i; });
    row.itemTypes = uniqueItems.map(field => {
      const item = player.summary[field], id = number(item)!, name = dictionary.items[String(id)] ?? null;
      const aliases = name === null ? [] : Object.keys(dictionary.items).filter(key => !/^\d+$/.test(key) && dictionary.items[key] === name);
      let firstPurchase: Observation = missing(undefined, id === 0 ? 'empty-slot' : aliases.length !== 1 ? 'ambiguous-item-token' : 'no-known-purchase');
      let uses: Observation = missing(undefined, aliases.length !== 1 ? 'ambiguous-item-token' : 'uses-unavailable');
      if (aliases.length === 1) {
        const events = player.logs.purchase_log.entries.filter(event => event.fields.key && known(event.fields.key) && event.fields.key.value === aliases[0] && number(event.fields.time) !== undefined);
        if (events.length) firstPurchase = registry.derive(Math.min(...events.map(event => number(event.fields.time)!)), 'time', slot, 'first-final-item-purchase-v1', [item, ...events.flatMap(event => [event.fields.time, event.fields.key])]);
        const use = player.maps.item_uses.entries[aliases[0]];
        if (use && !('state' in use)) uses = use;
      }
      return { itemId: id, name, firstPurchase, uses };
    });
    const abilities = player.maps.ability_uses;
    row.abilities = { ...abilities, entries: Object.fromEntries(Object.entries(abilities.entries).filter(([, value]) => !('state' in value))) };
    row.phases = [0, 600, 1200, 1800].map((from, phase): Phase => {
      const reached = from <= duration, to = Math.min(duration, [600, 1200, 1800, duration][phase]);
      const inside = (event: Event): boolean => { const time = number(event.fields.time); return reached && time !== undefined && time >= from && (phase === 3 || to === duration && duration < [600, 1200, 1800, Infinity][phase] ? time <= to : time < to); };
      const counts: Record<string, Observation> = {};
      for (const field of phaseLogs) {
        const log = player.logs[field], selected = log.entries.filter(inside);
        counts[field] = reached && log.state === 'present' ? registry.derive(selected.length, 'count', slot, 'phase-count-v1', [log.count, ...selected.map(event => event.fields.time)], { phase, from, to, log: phaseLogs.indexOf(field) }) : missing(undefined, reached ? 'log-unavailable' : 'unreached');
      }
      const killers: Phase['killers'] = {};
      let unknownKillers = 0;
      const events = player.logs.deaths_log.entries.filter(inside);
      for (const event of events) {
        const key = event.fields.key && known(event.fields.key) ? event.fields.key.value : undefined;
        const hero = typeof key === 'string' && key.startsWith('npc_dota_hero_') && dictionary.heroes[key] ? key : undefined;
        if (!hero) { unknownKillers++; continue; }
        if (killers[hero]) continue;
        const matching = events.filter(other => other.fields.key && known(other.fields.key) && other.fields.key.value === hero);
        killers[hero] = registry.derive(matching.length, 'count', slot, 'phase-killer-count-v1', matching.flatMap(event => [event.fields.time, event.fields.key]), { phase, from, to });
      }
      return { from, to: Math.max(from, to), reached, counts: registry.group(counts, 'phase-group', slot), killers, unknownKillers };
    });
    const log = player.logs.connection_log;
    const connectionValue = (type: string, last: boolean): Observation => {
      if (log.state !== 'present') return missing(undefined, 'log-unavailable');
      const matching = log.entries.filter(event => event.fields.event && known(event.fields.event) && event.fields.event.value === type && number(event.fields.time) !== undefined);
      return last && !matching.length ? missing(undefined, 'no-known-event') : registry.derive(last ? Math.max(...matching.map(event => number(event.fields.time)!)) : matching.length, last ? 'time' : 'count', slot, 'connection-summary-v1', [log.count, ...matching.flatMap(event => [event.fields.event, event.fields.time])]);
    };
    row.connection = { disconnects: connectionValue('disconnect', false), reconnects: connectionValue('reconnect', false), lastDisconnect: connectionValue('disconnect', true), lastReconnect: connectionValue('reconnect', true) };
    return row;
  };
  const allies = facts.players.filter(ally).map(playerBrief), opponents = facts.players.filter(player => !ally(player)).map(playerBrief);
  const fights: Brief['fights'] = facts.fights.entries.map(fight => ({
    index: fight.index, header: fight.header, participantDeaths: fight.participantDeaths, quality: fight.quality,
    metrics: Object.fromEntries(briefFightMetrics.map(field => [field, registry.group(Object.fromEntries(fight.players.map(player => [player.playerSlot, player.metrics[field]])), field, null)])),
    deadOverlap: Object.fromEntries(fight.players.filter(player => onSide(player.playerSlot, facts.side)).map(player => {
      const row: { seconds: Observation; lowerBound: boolean } = { seconds: missing(undefined), lowerBound: false };
      const full = facts.players.find(other => other.playerSlot === player.playerSlot)!;
      const log = full.logs.deaths_log;
      const start = number(fight.header.start), end = number(fight.header.end);
      const windows = full.deadWindows;
      row.lowerBound = log.entries.some(event => number(event.fields.time_dead) === undefined || number(event.fields.time) === undefined);
      if (start === undefined || end === undefined || end < start || log.state !== 'present' || log.entries.length > 0 && windows.length === 0) row.seconds = missing(undefined, 'no-known-window-or-times');
      else {
        const overlaps = fight.overlaps.filter(overlap => overlap.playerSlot === player.playerSlot).sort((a, b) => a.start.value - b.start.value);
        let total = 0, lastEnd = -Infinity;
        for (const overlap of overlaps) { total += Math.max(0, overlap.end.value - Math.max(lastEnd, overlap.start.value)); lastEnd = Math.max(lastEnd, overlap.end.value); }
        row.seconds = registry.derive(total, 'deadOverlap', player.playerSlot, 'known-dead-overlap-v1', [fight.header.start, fight.header.end, log.count, ...windows.flatMap(window => [window.start, window.end])]);
      }
      return [player.playerSlot, row];
    })),
  }));
  const grouped = new Map<string, Brief['quality']['issues'][number]>();
  for (const issue of facts.quality.issues) {
    const key = `${issue.code}:${issue.scope}`;
    const group = grouped.get(key) ?? { code: issue.code, scope: issue.scope, count: 0, slots: [], indices: [] };
    group.count++;
    if (issue.playerSlot !== undefined && !group.slots.includes(issue.playerSlot)) group.slots.push(issue.playerSlot);
    if (issue.index !== undefined && !group.indices.includes(issue.index)) group.indices.push(issue.index);
    grouped.set(key, group);
  }
  const context: Brief = {
    version: 1, format: 'match-brief-v1', matchId: facts.matchId, side: facts.side, match: facts.match,
    catalog: structuredClone(Object.fromEntries(Object.entries(catalog).filter(([key]) => [...allyMetrics, ...opponentMetrics, ...briefSeries, ...briefFightMetrics, ...Object.keys(facts.match), 'hero_id', 'position', 'time', 'time_dead', 'start', 'end', 'last_death', 'participation', 'deadShare', 'deadOverlap'].includes(key)))),
    limitations: [...limitations], quality: { parseState: facts.quality.parseState, missingOpponentSlots: facts.quality.missingOpponentSlots, issues: [...grouped.values()] }, allies, opponents, fights,
    objectives: facts.objectives.entries.map(event => ({ index: event.index, fields: pick(event.fields, ['time', 'type', 'key'].filter(field => field in event.fields)), actor: event.actor })),
    buybacks: facts.players.filter(ally).flatMap(player => player.logs.buyback_log.entries.filter(event => number(event.fields.time) !== undefined).map(event => ({ playerSlot: player.playerSlot, time: event.fields.time }))),
    coverage: { teamfights: coverage(facts.fights, 'aggregate', fights.length), objectives: coverage(facts.objectives, 'direct', facts.objectives.entries.length) },
    representations: {
      allies: { direct: ['summary', 'slices', 'ability_uses'], aggregate: [...phaseLogs, 'connection_log', 'buyback_log'], 'local-only': [...logFields.filter(field => ![...phaseLogs, 'connection_log', 'buyback_log'].includes(field)), ...mapFields.filter(field => field !== 'ability_uses')] },
      opponents: { direct: ['summary', 'slices'], aggregate: [], 'local-only': [...logFields, ...mapFields] },
    },
  };
  facts.derived = { players: [...allies, ...opponents].map(row => ({ playerSlot: row.playerSlot, metrics: row.metrics, economy: row.economy, ...(row.comparisons ? { comparisons: row.comparisons, itemTypes: row.itemTypes, phases: row.phases, connection: row.connection } : {}) })), fights: fights.map(fight => ({ index: fight.index, metrics: fight.metrics, deadOverlap: fight.deadOverlap })) };
  return context;
}
