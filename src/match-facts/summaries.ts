import { buildBrief } from './brief.js';
import { canonicalSlots, orderedMetrics } from './profile.js';
import { finite, known, number, Registry } from './values.js';
import type { Brief, BriefV2, BuildingCounts, DeathTotals, Dictionary, Facts, FightDeathSummary, MetricOrder, Observation, Side, Summaries, Unavailable } from './types.js';

function sum(values: (number | Unavailable)[], reason: string): number | Unavailable {
  if (values.some(value => typeof value !== 'number')) return { unavailable: 'missing', reason };
  const total = (values as number[]).reduce((total, value) => total + value, 0);
  return Number.isSafeInteger(total) ? total : { unavailable: 'invalid', reason: 'unsafe-sum' };
}

function relative(radiant: DeathTotals['radiant'], dire: DeathTotals['dire'], side: Side): DeathTotals {
  return { radiant, dire, allies: side === 'radiant' ? radiant : dire, opponents: side === 'radiant' ? dire : radiant };
}

export function buildSummaries(facts: Facts, context: Brief, registry: Registry): Summaries {
  const byFight: FightDeathSummary[] = context.fights.map(fight => {
    const values = fight.metrics.deaths.value;
    const unavailableSlots = canonicalSlots.filter(slot => typeof values[slot] !== 'number');
    const sideSum = (slots: number[]) => sum(slots.map(slot => typeof values[slot] === 'number' ? values[slot] as number : { unavailable: 'missing' }), 'incomplete-side');
    const totals = relative(sideSum(canonicalSlots.slice(0, 5)), sideSum(canonicalSlots.slice(5)), facts.side);
    const header = number(fight.header.deaths);
    const total = sum([totals.radiant, totals.dire], 'incomplete-card');
    return { index: fight.index, totals: registry.add(totals, 'fightSideDeaths', null, [`/teamfights/${fight.index}/players`], 'fight-side-deaths-v1',
      [fight.metrics.deaths.id, ...Object.values(fight.header).filter(known).map(value => value.id)], 'derived', { fightIndex: fight.index }), unavailableSlots,
      headerStatus: header === undefined || typeof total !== 'number' ? 'unknown' : header === total ? 'match' : 'mismatch' };
  });
  const allCards: Summaries['fightDeaths']['allCards'] = { sourceState: facts.fights.state, cardCount: facts.fights.count,
    totals: facts.fights.state === 'present' ? registry.add(relative(
      sum(byFight.map(fight => fight.totals.value.radiant), 'incomplete-cards'),
      sum(byFight.map(fight => fight.totals.value.dire), 'incomplete-cards'), facts.side), 'fightCardDeaths', null, ['/teamfights'], 'fight-card-deaths-v1',
    [...(known(facts.fights.count) ? [facts.fights.count.id] : []), ...byFight.map(fight => fight.totals.id)], 'derived')
      : { unavailable: facts.fights.state },
    conflictingCards: byFight.filter(fight => fight.headerStatus === 'mismatch').map(fight => fight.index) };

  let buildingCounts: Observation<BuildingCounts>;
  if (facts.objectives.state !== 'present') buildingCounts = { unavailable: facts.objectives.state };
  else {
    const counts: BuildingCounts = { byPlayerSlot: Object.fromEntries(canonicalSlots.map(slot => [slot, 0])), unassigned: 0, knownBuildingEvents: 0, otherEvents: 0, unclassifiedEvents: 0, excludedByTime: 0 };
    const otherTypes = ['CHAT_MESSAGE_FIRSTBLOOD', 'CHAT_MESSAGE_ROSHAN_KILL', 'CHAT_MESSAGE_AEGIS', 'CHAT_MESSAGE_AEGIS_STOLEN', 'CHAT_MESSAGE_AEGIS_DENIED', 'CHAT_MESSAGE_COURIER_LOST'];
    const inputs = known(facts.objectives.count) ? [facts.objectives.count.id] : [];
    if (known(facts.match.duration)) inputs.push(facts.match.duration.id);
    for (const event of facts.objectives.entries) {
      inputs.push(...Object.values(event.fields).filter(known).map(value => value.id), ...(known(event.actor) ? [event.actor.id] : []));
      const time = number(event.fields.time);
      const type = event.fields.type && known(event.fields.type) ? event.fields.type.value : undefined;
      const key = event.fields.key && known(event.fields.key) ? event.fields.key.value : undefined;
      if (time === undefined || time < 0 || time > number(facts.match.duration)!) { counts.excludedByTime++; continue; }
      if (typeof type === 'string' && otherTypes.includes(type)) { counts.otherEvents++; continue; }
      const tower = typeof key === 'string' && /^npc_dota_(?:goodguys|badguys)_tower(?:[1-3]_(?:top|mid|bot)|4(?:_(?:top|mid|bot))?)$/.test(key);
      const rax = typeof key === 'string' && /^npc_dota_(?:goodguys|badguys)_(?:melee|range)_rax_(?:top|mid|bot)$/.test(key);
      const fort = typeof key === 'string' && /^npc_dota_(?:goodguys|badguys)_fort$/.test(key);
      const building = type === 'building_kill' && (tower || rax || fort) || type === 'CHAT_MESSAGE_TOWER_KILL' && tower || type === 'CHAT_MESSAGE_BARRACKS_KILL' && rax;
      if (!building) { counts.unclassifiedEvents++; continue; }
      counts.knownBuildingEvents++;
      const actor = number(event.actor);
      if (actor !== undefined && canonicalSlots.includes(actor)) counts.byPlayerSlot[actor]++;
      else counts.unassigned++;
    }
    buildingCounts = registry.add(counts, 'buildingKillEvents', null, ['/objectives'], 'building-kill-events-v1', inputs, 'derived');
  }
  const allyMetricOrder = Object.fromEntries(orderedMetrics.map(metric => {
    const order: MetricOrder = { groups: [], unavailableSlots: [], complete: true };
    const players = [...context.allies].sort((a, b) => a.playerSlot - b.playerSlot);
    for (const player of players) {
      const value = player.metrics.value[metric];
      if (!finite(value)) { order.unavailableSlots.push(player.playerSlot); continue; }
      const group = order.groups.find(group => group.value === value);
      if (group) group.slots.push(player.playerSlot);
      else order.groups.push({ value, slots: [player.playerSlot] });
    }
    order.groups.sort((a, b) => a.value - b.value);
    order.complete = order.unavailableSlots.length === 0;
    return [metric, registry.add(order, metric, null, [], 'ally-metric-order-v1', players.flatMap(player => [player.hero.id, player.metrics.id]), 'derived')];
  }));
  return { fightDeaths: { byFight, allCards }, buildingKillEvents: { sourceState: facts.objectives.state, counts: buildingCounts }, allyMetricOrder };
}

export function buildBriefV2(facts: Facts, registry: Registry, dictionary: Dictionary): BriefV2 {
  const base = buildBrief(facts, registry, dictionary);
  const summaries = buildSummaries(facts, base, registry);
  facts.derived.summaries = summaries;
  const catalog = {
    ...base.catalog,
    fightSideDeaths: { unit: 'count', meaning: 'deaths-in-card-by-side' },
    fightCardDeaths: { unit: 'count', meaning: 'sum-over-provided-cards' },
    buildingKillEvents: { unit: 'count', meaning: 'known-building-kill-log-events' },
  };
  Object.assign(facts.catalog, catalog);
  return { ...base, version: 2, format: 'match-brief-v2', summaries, catalog,
    limitations: [...base.limitations,
      'Death summaries sum participant observations in provided fight cards, not unique deaths of the match. Cards can overlap or be absent. Header conflicts remain unresolved. All-card totals do not describe an arbitrary subset.',
      'Building counts are classified log entries with confirmed last-hit actors, not unique buildings or total contribution. Unassigned/unclassified/excluded entries limit coverage; zero confirmed events does not mean no contribution. Repeated entries are not deduplicated.',
      'Metric groups ascend by exact observed value among all five allies. Ties share a group; incomplete orders only compare known values. Values are not a quality ranking or role thresholds.'],
  };
}
