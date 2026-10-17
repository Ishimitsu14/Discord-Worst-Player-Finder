import { canonicalSlots, orderedMetrics } from './profile.js';
import { canonical, ensure, finite, integer, known, number, object, state } from './values.js';
import { FactsError, type DeathTotals, type FactsBundleV2, type MatchFactsInput, type Raw } from './types.js';

export function checkSummariesCoverage(bundle: FactsBundleV2, input: MatchFactsInput): void {
  try {
    const require = (value: unknown): void => ensure(value, 'integrity-error');
    const { context, facts } = bundle, summaries = context.summaries;
    require(object(summaries) && object(summaries.fightDeaths) && object(summaries.buildingKillEvents) && object(summaries.allyMetricOrder));
    require(canonical(facts.derived.summaries) === canonical(summaries));
    const data = input.data as Raw, rawCards = Array.isArray(data.teamfights) ? data.teamfights : [];
    const byFight = summaries.fightDeaths.byFight;
    require(Array.isArray(byFight) && byFight.length === rawCards.length);
    const checkTotal = (actual: DeathTotals, radiant: number | undefined, dire: number | undefined): void => {
      for (const [key, expected] of Object.entries({ radiant, dire, allies: input.side === 'radiant' ? radiant : dire, opponents: input.side === 'radiant' ? dire : radiant })) {
        const value = actual[key as keyof DeathTotals];
        require(expected === undefined ? object(value) && ['missing', 'null', 'invalid'].includes(String(value.unavailable)) : value === expected);
      }
    };
    const expectedSides: (number | undefined)[][] = [];
    rawCards.forEach((raw, index) => {
      const players = object(raw) && Array.isArray(raw.players) && raw.players.length === 10 ? raw.players : [];
      const values = canonicalSlots.map((_, i) => object(players[i]) && integer(players[i].deaths) ? players[i].deaths as number : undefined);
      const sides = [values.slice(0, 5), values.slice(5)].map(values => {
        const total = values.reduce<number>((sum, value) => sum + (value ?? NaN), 0);
        return Number.isSafeInteger(total) ? total : undefined;
      });
      expectedSides.push(sides);
      const row = byFight[index];
      require(row.index === index && known(row.totals));
      checkTotal(row.totals.value, sides[0], sides[1]);
      require(canonical(row.unavailableSlots) === canonical(canonicalSlots.filter((_, i) => values[i] === undefined)));
      const total = sides[0] !== undefined && sides[1] !== undefined ? sides[0] + sides[1] : NaN;
      const header = object(raw) && integer(raw.deaths) ? raw.deaths : undefined;
      require(row.headerStatus === (header === undefined || !Number.isSafeInteger(total) ? 'unknown' : header === total ? 'match' : 'mismatch'));
    });
    const all = summaries.fightDeaths.allCards;
    require(all.sourceState === (Array.isArray(data.teamfights) ? 'present' : state(data.teamfights)));
    if (Array.isArray(data.teamfights)) {
      require(number(all.cardCount) === rawCards.length && known(all.totals));
      const sums = [0, 1].map(side => expectedSides.reduce((sum, values) => sum + (values[side] ?? NaN), 0)).map(value => Number.isSafeInteger(value) ? value : undefined);
      if (known(all.totals)) checkTotal(all.totals.value, sums[0], sums[1]);
    } else require(!known(all.totals) && all.totals.unavailable === state(data.teamfights));
    require(canonical(all.conflictingCards) === canonical(byFight.filter(row => row.headerStatus === 'mismatch').map(row => row.index)));

    const buildings = summaries.buildingKillEvents;
    require(buildings.sourceState === (Array.isArray(data.objectives) ? 'present' : state(data.objectives)));
    if (!Array.isArray(data.objectives)) require(!known(buildings.counts) && buildings.counts.unavailable === state(data.objectives));
    else {
      require(known(buildings.counts));
      if (!known(buildings.counts)) throw new FactsError('integrity-error');
      const counts = buildings.counts.value;
      require(canonical(Object.keys(counts.byPlayerSlot).map(Number).sort((a, b) => a - b)) === canonical(canonicalSlots));
      const eligible = data.objectives.filter(event => object(event) && finite(event.time) && event.time >= 0 && event.time <= Number(data.duration)) as Raw[];
      require(counts.excludedByTime === data.objectives.length - eligible.length);
      const buildingEvents = eligible.filter(event => {
        if (typeof event.key !== 'string') return false;
        const suffix = event.key.replace(/^npc_dota_(goodguys|badguys)_/, '');
        if (suffix === event.key) return false;
        const tower = /^tower([1-3]_(top|mid|bot)|4(_(top|mid|bot))?)$/.test(suffix);
        const rax = /^(melee|range)_rax_(top|mid|bot)$/.test(suffix);
        return event.type === 'building_kill' && (tower || rax || suffix === 'fort') || event.type === 'CHAT_MESSAGE_TOWER_KILL' && tower || event.type === 'CHAT_MESSAGE_BARRACKS_KILL' && rax;
      });
      const otherEvents = eligible.filter(event => ['CHAT_MESSAGE_FIRSTBLOOD', 'CHAT_MESSAGE_ROSHAN_KILL', 'CHAT_MESSAGE_AEGIS', 'CHAT_MESSAGE_AEGIS_STOLEN', 'CHAT_MESSAGE_AEGIS_DENIED', 'CHAT_MESSAGE_COURIER_LOST'].includes(String(event.type)));
      require(counts.knownBuildingEvents === buildingEvents.length && counts.otherEvents === otherEvents.length && counts.unclassifiedEvents === eligible.length - buildingEvents.length - otherEvents.length);
      const actors = buildingEvents.map(event => number(facts.objectives.entries.find(row => row.index === (data.objectives as unknown[]).indexOf(event))!.actor));
      for (const slot of canonicalSlots) require(counts.byPlayerSlot[slot] === actors.filter(actor => actor === slot).length);
      require(counts.unassigned === actors.filter(actor => actor === undefined).length);
    }
    require(canonical(Object.keys(summaries.allyMetricOrder).sort()) === canonical([...orderedMetrics].sort()));
    for (const metric of orderedMetrics) {
      const fact = summaries.allyMetricOrder[metric];
      require(known(fact));
      const order = fact.value;
      const knownPlayers = context.allies.filter(player => finite(player.metrics.value[metric]));
      const unknownSlots = context.allies.filter(player => !finite(player.metrics.value[metric])).map(player => player.playerSlot);
      require(canonical(order.unavailableSlots) === canonical(unknownSlots) && order.complete === (knownPlayers.length === 5));
      const seen = new Set<number>();
      let previous = -Infinity;
      for (const group of order.groups) {
        require(finite(group.value) && group.value > previous && group.slots.length > 0);
        require(canonical(group.slots) === canonical([...group.slots].sort((a, b) => a - b)));
        for (const slot of group.slots) {
          require(!seen.has(slot) && knownPlayers.some(player => player.playerSlot === slot && player.metrics.value[metric] === group.value));
          seen.add(slot);
        }
        previous = group.value;
      }
      require(seen.size === knownPlayers.length);
    }
  } catch {
    throw new FactsError('integrity-error');
  }
}
