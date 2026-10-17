import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, known, sha } from '../src/match-facts/values.js';
import { checkBriefSize, checkCoverage, FactsError, prepareMatchFacts, validateFactReferences, verifyFactsBundle } from '../src/match-facts/index.js';
import type { FactsBundle, FactsBundleV2, FactsOptionsV2, MatchFactsInput, Observation, Raw, Side } from '../src/match-facts/index.js';
import { canonicalSlots, orderedMetrics } from '../src/match-facts/profile.js';
import { validateAnalysisBundle } from '../src/match-analysis/input.js';
import { dictionary, match } from './helpers.js';
import { prepareAnalysis } from '../src/match-analysis/index.js';
import { bundle, prompt } from './match-analysis-helpers.js';

const options: FactsOptionsV2 = { dictionary, briefFormat: 'match-brief-v2' };
const input = (data = match(), side: Side = 'dire'): MatchFactsInput => ({ matchId: Number(data.match_id), side, data });
const build = (data = match(), side: Side = 'dire') => prepareMatchFacts(input(data, side), options);
const value = <T>(observation: Observation<T>): T => { assert.ok(known(observation)); return observation.value; };
const error = (code: string) => (error: unknown) => error instanceof FactsError && error.code === code;
const players = (data: Raw) => data.players as Raw[];
function fight(radiant = 1, dire = 2): Raw {
  return { start: 710, end: 740, deaths: radiant + dire,
    players: canonicalSlots.map((_, index) => ({ deaths: index === 0 ? radiant : index === 5 ? dire : 0, buybacks: 0, damage: index * 100, healing: 0, gold_delta: index })) };
}
function rehash(b: FactsBundleV2): void {
  b.manifest.factsDigest = sha(b.facts); b.manifest.contextDigest = sha(b.context); b.manifest.evidenceDigest = sha(b.evidence);
  const { bundleId: _, ...identity } = b.manifest; b.manifest.bundleId = sha(identity);
}

test('golden до сводок: факты, контекст, реестр, manifest и запрос V1 неизменны', () => {
  const value = bundle();
  assert.equal(sha(value.facts), '3402f82761e9219323856e8327873e6e6fb6b866a5f92b4cff4c2bd51e6e72c4');
  assert.equal(sha(value.context), '24cd0ce05e1ddde222c3488c0fe36c3e4361f30eb14d449a11c724f7962dfe23');
  assert.equal(sha(value.evidence), '4bf050c26afecbac3ed16c6e9821e36285605749214df5b22aafc96bdfcd1333');
  assert.equal(sha(value.manifest), '4a5ae4e6691e37c6012c679d2f15793c20ce9c91436ed544c3aec8f1b4a71c3e');
  assert.equal(prepareAnalysis(value, prompt).requestDigest, 'e817312415485f6ab3527cd5dff1c1667b6131e0c3c77e3388c96592dbe5d5d2');
});

test('явный V2, статические типы старых вызовов, неизменённый префикс и строгий потребитель V1', () => {
  const data = match(); data.teamfights = [fight()];
  const legacy: FactsBundle = prepareMatchFacts(input(data), { dictionary });
  const explicit: FactsBundle = prepareMatchFacts(input(data), { dictionary, briefFormat: 'match-brief-v1' });
  const modern: FactsBundleV2 = build(data);
  assert.deepEqual(explicit, legacy);
  assert.deepEqual(modern.evidence.slice(0, legacy.evidence.length), legacy.evidence);
  assert.equal(modern.context.version, 2); assert.equal(modern.context.format, 'match-brief-v2');
  assert.equal(modern.manifest.factsProfile, 'facts-profile-2'); assert.equal(modern.manifest.briefTransform, 'summarize-2');
  assert.notEqual(modern.manifest.bundleId, legacy.manifest.bundleId);
  assert.deepEqual(verifyFactsBundle(modern, input(data), options), modern);
  assert.deepEqual(verifyFactsBundle(legacy, input(data), { dictionary }), legacy);
  assert.throws(() => verifyFactsBundle(modern, input(data), { dictionary }), error('integrity-error'));
  assert.throws(() => verifyFactsBundle(legacy, input(data), options), error('integrity-error'));
  assert.throws(() => prepareMatchFacts(input(data), { dictionary, briefFormat: 'other' } as never), error('invalid-input'));
  assert.deepEqual(validateAnalysisBundle(legacy), legacy);
  assert.throws(() => validateAnalysisBundle(modern), /invalid-input/);
  for (const field of ['allies', 'opponents', 'match', 'fights', 'objectives', 'buybacks', 'quality', 'coverage', 'representations'] as const) assert.deepEqual(modern.context[field], legacy.context[field]);
  for (const mutate of [(b: FactsBundleV2) => { b.context.version = 1 as never; }, (b: FactsBundleV2) => { b.manifest.briefProfile = 'unknown'; }]) {
    const broken = structuredClone(modern); mutate(broken); rehash(broken);
    assert.throws(() => verifyFactsBundle(broken, input(data), options), error('integrity-error'));
  }
});

test('смерти по сторонам: полный набор карточек 8/15, общие 9 не становятся союзными', () => {
  const data = match(); data.teamfights = [fight(1, 2), fight(1, 2), fight(3, 0), fight(3, 1), fight(5, 2), fight(2, 1)];
  for (const side of ['radiant', 'dire'] as const) {
    const before = canonical(data), b = build(data, side), rows = b.context.summaries.fightDeaths;
    assert.equal(canonical(data), before); assert.deepEqual(build(data, side), b);
    assert.deepEqual(rows.byFight.map(row => row.totals.value.dire), [2, 2, 0, 1, 2, 1]);
    assert.deepEqual(rows.byFight.map(row => row.totals.value.radiant), [1, 1, 3, 3, 5, 2]);
    assert.deepEqual(value(rows.allCards.totals), { radiant: 15, dire: 8, allies: side === 'dire' ? 8 : 15, opponents: side === 'dire' ? 15 : 8 });
    assert.deepEqual([0, 1, 5].map(index => rows.byFight[index].totals.value.dire), [2, 2, 1]);
    assert.ok(rows.byFight.every(row => row.headerStatus === 'match'));
    assert.deepEqual(verifyFactsBundle(b, input(data, side), options), b);
  }
  players(data).reverse(); assert.deepEqual(build(data).context.summaries.fightDeaths.byFight[0].totals.value, { radiant: 1, dire: 2, allies: 2, opponents: 1 });
});

test('неполная сторона, неизвестный mapping и конфликт header не создают ложного размена', () => {
  const data = match(), card = fight(); data.teamfights = [card]; delete (card.players as Raw[])[0].deaths;
  const b = build(data), row = b.context.summaries.fightDeaths.byFight[0];
  assert.deepEqual(row.unavailableSlots, [0]); assert.equal(row.totals.value.dire, 2);
  assert.equal(typeof row.totals.value.radiant, 'object'); assert.equal(row.headerStatus, 'unknown');
  assert.equal(typeof value(b.context.summaries.fightDeaths.allCards.totals).radiant, 'object');
  assert.equal(value(b.context.summaries.fightDeaths.allCards.totals).dire, 2);
  (card.players as Raw[]).pop();
  assert.equal(build(data).context.summaries.fightDeaths.byFight[0].unavailableSlots.length, 10);
  data.teamfights = [fight()]; (data.teamfights as Raw[])[0].deaths = 4;
  const mismatch = build(data).context.summaries.fightDeaths;
  assert.equal(mismatch.byFight[0].headerStatus, 'mismatch'); assert.deepEqual(mismatch.allCards.conflictingCards, [0]);
  assert.equal(value(mismatch.allCards.totals).dire, 2);
});

test('смерти: missing/null/invalid, пустой список и небезопасная сумма различаются', () => {
  for (const [raw, state] of [[undefined, 'missing'], [null, 'null'], [false, 'invalid']] as const) {
    const data = match(); if (raw === undefined) delete data.teamfights; else data.teamfights = raw;
    const b = build(data), totals = b.context.summaries.fightDeaths.allCards;
    assert.deepEqual(totals.totals, { unavailable: state }); assert.equal(totals.sourceState, state);
    verifyFactsBundle(b, input(data), options);
  }
  assert.deepEqual(value(build().context.summaries.fightDeaths.allCards.totals), { radiant: 0, dire: 0, allies: 0, opponents: 0 });
  const data = match(), card = fight(0, 0); data.teamfights = [card];
  (card.players as Raw[])[0].deaths = Number.MAX_SAFE_INTEGER; (card.players as Raw[])[1].deaths = 1;
  const row = build(data).context.summaries.fightDeaths.byFight[0];
  assert.deepEqual(row.totals.value.radiant, { unavailable: 'invalid', reason: 'unsafe-sum' }); assert.equal(row.totals.value.dire, 0);
  data.teamfights = [fight(Number.MAX_SAFE_INTEGER, 0), fight(Number.MAX_SAFE_INTEGER, 0)];
  const all = build(data).context.summaries.fightDeaths.allCards;
  assert.deepEqual(value(all.totals).radiant, { unavailable: 'invalid', reason: 'unsafe-sum' });
  assert.equal(value(all.totals).dire, 0);
});

test('строения: четыре здания и First Blood, отдельные Aegis/Roshan/courier и партиции', () => {
  const data = match();
  data.objectives = ['tower1_mid', 'tower2_mid', 'melee_rax_mid', 'fort'].map(key => ({ time: 900, type: 'building_kill', key: `npc_dota_goodguys_${key}`, player_slot: 132 }));
  (data.objectives as Raw[]).push(...['CHAT_MESSAGE_FIRSTBLOOD', 'CHAT_MESSAGE_AEGIS', 'CHAT_MESSAGE_ROSHAN_KILL', 'CHAT_MESSAGE_COURIER_LOST'].map(type => ({ time: 1000, type, player_slot: 132 })),
    { time: 1000, type: 'CHAT_MESSAGE_TOWER_KILL', key: 'npc_dota_goodguys_tower4', player_slot: 130 },
    { time: 1000, type: 'CHAT_MESSAGE_BARRACKS_KILL', key: 'npc_dota_goodguys_range_rax_mid', player_slot: 130 },
    { time: 1000, type: 'CHAT_MESSAGE_TOWER_KILL', key: 'npc_dota_goodguys_fort', player_slot: 132 });
  const b = build(data), counts = value(b.context.summaries.buildingKillEvents.counts);
  assert.equal(counts.byPlayerSlot['132'], 4); assert.equal(counts.byPlayerSlot['130'], 2); assert.equal(counts.knownBuildingEvents, 6);
  assert.equal(counts.otherEvents, 4); assert.equal(counts.unclassifiedEvents, 1);
  assert.equal(counts.knownBuildingEvents, Object.values(counts.byPlayerSlot).reduce((a, b) => a + b, 0) + counts.unassigned);
  assert.equal(counts.knownBuildingEvents + counts.otherEvents + counts.unclassifiedEvents + counts.excludedByTime, (data.objectives as Raw[]).length);
  verifyFactsBundle(b, input(data), options);
});

test('строения: unassigned, конфликт, время, повтор tower4, пропуски и неизвестные типы', () => {
  const data = match(), base = { time: 900, type: 'building_kill', key: 'npc_dota_goodguys_tower4' };
  data.objectives = [{ ...base, player_slot: 130 }, { ...base, player_slot: 130 }, { ...base, unit: 'npc_dota_goodguys_siege' },
    { ...base }, { ...base, player_slot: 130, slot: 0 }, { ...base, time: 1501 }, { ...base, time: null },
    { ...base, type: 'untrusted instruction' }, { ...base, key: 'untrusted key' }, null];
  const b = build(data), counts = value(b.context.summaries.buildingKillEvents.counts);
  assert.equal(counts.byPlayerSlot['130'], 2); assert.equal(counts.unassigned, 3); assert.equal(counts.excludedByTime, 3); assert.equal(counts.unclassifiedEvents, 2);
  assert.ok(!JSON.stringify(b.context).includes('untrusted')); verifyFactsBundle(b, input(data), options);
  for (const [raw, state] of [[undefined, 'missing'], [null, 'null'], [false, 'invalid']] as const) {
    if (raw === undefined) delete data.objectives; else data.objectives = raw;
    assert.deepEqual(build(data).context.summaries.buildingKillEvents, { sourceState: state, counts: { unavailable: state } });
  }
  assert.equal(value(build().context.summaries.buildingKillEvents.counts).knownBuildingEvents, 0);
});

test('порядок восьми метрик: Sven, равенства, точность и неполнота', () => {
  const data = match(); players(data).slice(5).forEach((player, index) => { player.stuns = [83.06691, 91.16751, 11.133545, 78.466965, 24.23296][index]; });
  const b = build(data), order = b.context.summaries.allyMetricOrder;
  assert.deepEqual(Object.keys(order), orderedMetrics); assert.deepEqual(order.stuns.value.groups.map(group => group.slots), [[130], [132], [131], [128], [129]]);
  assert.equal(order.stuns.value.complete, true); assert.deepEqual(order.gold_per_min.value.groups, [{ value: 350, slots: [128, 129, 130, 131, 132] }]);
  assert.deepEqual(order.hero_healing.value, { groups: [], unavailableSlots: [128, 129, 130, 131, 132], complete: false });
  players(data)[5].stuns = 11.133545; players(data)[6].stuns = 11.133546; players(data)[8].stuns = null;
  const partial = build(data).context.summaries.allyMetricOrder.stuns.value;
  assert.deepEqual(partial.groups[0], { value: 11.133545, slots: [128, 130] }); assert.equal(partial.groups[1].value, 11.133546);
  assert.deepEqual(partial.unavailableSlots, [131]); assert.equal(partial.complete, false);
  verifyFactsBundle(build(data), input(data), options);
});

test('основания новых ссылок, нулей и неизвестности; локальная ссылка не передана', () => {
  const b = build(), s = b.context.summaries;
  const ids = [s.fightDeaths.allCards.totals, s.buildingKillEvents.counts, s.allyMetricOrder.hero_healing].map(observation => {
    assert.ok('id' in observation); return observation.id;
  });
  validateFactReferences(ids, b);
  for (const id of ids) {
    const entry = b.evidence.find(entry => entry.id === id)!; assert.equal(entry.source, 'derived'); assert.ok(entry.inputs.length > 0);
  }
  const building = b.evidence.find(entry => entry.id === ids[1])!; assert.deepEqual(building.paths, ['/objectives']);
  const local = b.evidence.find(entry => entry.paths[0] === '/players/0/deaths_log/0/time_dead')!;
  assert.throws(() => validateFactReferences([local.id], b), error('unknown-fact-reference'));
  assert.notEqual(build(match(), 'radiant').manifest.bundleId, b.manifest.bundleId);
});

test('coverage и replay отвергают удалённые группы и согласованную подмену с новыми digests', () => {
  const data = match(); data.teamfights = [fight()]; const original = build(data);
  const mutations = [
    (b: FactsBundleV2) => { b.context.summaries.fightDeaths.byFight.pop(); },
    (b: FactsBundleV2) => { delete b.context.summaries.allyMetricOrder.stuns; },
    (b: FactsBundleV2) => { b.context.summaries.allyMetricOrder.gold_per_min.value.groups[0].slots.pop(); },
    (b: FactsBundleV2) => { b.context.summaries.fightDeaths.byFight[0].totals.value.dire = 9; },
    (b: FactsBundleV2) => { value(b.context.summaries.buildingKillEvents.counts).otherEvents = 9; },
  ];
  for (const mutate of mutations) {
    const b = structuredClone(original); mutate(b); b.facts.derived.summaries = structuredClone(b.context.summaries);
    const summaries = b.context.summaries;
    for (const fact of [...summaries.fightDeaths.byFight.map(row => row.totals), summaries.fightDeaths.allCards.totals,
      summaries.buildingKillEvents.counts, ...Object.values(summaries.allyMetricOrder)]) {
      if ('id' in fact) b.evidence.find(entry => entry.id === fact.id)!.value = structuredClone(fact.value);
    }
    rehash(b); assert.throws(() => checkCoverage(b, input(data), options), error('integrity-error'));
    assert.throws(() => verifyFactsBundle(b, input(data), options), error('integrity-error'));
  }
  const b = structuredClone(original), target = b.evidence.at(-1)!; target.transform = 'unknown'; rehash(b);
  assert.throws(() => verifyFactsBundle(b, input(data), options), error('integrity-error'));
});

test('V2 overflow сообщает точные bytes без удаления данных или fallback', () => {
  const b = build(); b.context.limitations.push('я'.repeat(65536));
  assert.throws(() => checkBriefSize(b.context), error('context-too-large')); assert.equal(b.context.format, 'match-brief-v2'); assert.equal(b.context.allies.length, 5);
  const data = match(); data.teamfights = Array.from({ length: 100 }, () => fight());
  assert.throws(() => build(data), error('context-too-large')); assert.equal((data.teamfights as Raw[]).length, 100);
});
