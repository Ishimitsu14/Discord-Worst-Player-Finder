import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMatchFacts, verifyFactsBundle, validateFactReferences, checkCoverage, checkBriefSize, FactsError } from '../src/match-facts/index.js';
import type { FactsBundle, MatchFactsInput, Observation, Raw } from '../src/match-facts/index.js';
import { canonical, escapePointer, known, sha } from '../src/match-facts/values.js';
import * as fields from '../src/match-facts/profile.js';
import { renderMatchBrief } from '../src/match-facts/summary.js';
import { contextFieldsV2 } from '../src/evaluation-lab/context.js';
import { dictionary, match } from './helpers.js';

const options = { dictionary };
const input = (data = match(), side: 'radiant' | 'dire' = 'radiant'): MatchFactsInput => ({ matchId: Number(data.match_id), side, data });
const players = (data: Raw): Raw[] => data.players as Raw[];
const value = <T>(observation: Observation<T>): T => { assert.ok(known(observation)); return observation.value; };
const error = (code: string) => (error: unknown): boolean => error instanceof FactsError && error.code === code;
const build = (data = match()): FactsBundle => prepareMatchFacts(input(data), options);
function withRoles(): Raw {
  const data = match();
  data.radiant_score = 30; data.dire_score = 20;
  players(data).forEach((player, index) => { player.position_est = index % 5 + 1; player.life_state_dead = 100; });
  return data;
}
function fight(): Raw {
  return { start: 710, end: 740, last_death: 720, deaths: 4, players: fields.canonicalSlots.map((_, i) => ({ deaths: i < 5 ? 1 : 0, buybacks: 0, damage: i * 100, healing: 10, gold_delta: i - 4, xp_delta: i - 3, xp_start: 100, xp_end: 120, ability_uses: {}, item_uses: {}, ability_targets: {}, killed: {} })) };
}

test('самостоятельный контракт: обе стороны, исходы, анонимность, отсутствие мутаций и повтор', () => {
  for (const side of ['radiant', 'dire'] as const) for (const win of [true, false]) {
    const data = match(101, win), before = canonical(data);
    const b = prepareMatchFacts(input(data, side), options);
    assert.equal(canonical(data), before);
    assert.equal(b.context.allies.length, 5);
    assert.equal(b.context.opponents.length, 5);
    assert.deepEqual(b.context.allies.map(p => p.playerSlot), side === 'radiant' ? [0, 1, 2, 3, 4] : [128, 129, 130, 131, 132]);
    assert.deepEqual(verifyFactsBundle(b, input(data, side), options), b);
    assert.deepEqual(prepareMatchFacts(input(data, side), options), b);
    assert.equal(value(b.context.match.radiant_win), win);
  }
});

test('основа отклоняет чужой ID, сторону, неполную пятёрку, дубликат и неверного героя', () => {
  assert.throws(() => prepareMatchFacts({ ...input(), matchId: 102 }, options), error('unusable-match'));
  assert.throws(() => prepareMatchFacts({ ...input(), side: 'wrong' as never }, options), error('invalid-input'));
  for (const mutate of [
    (d: Raw) => { players(d).splice(0, 1); },
    (d: Raw) => { players(d)[0].player_slot = 1; },
    (d: Raw) => { players(d)[0].hero_id = 0; },
    (d: Raw) => { d.duration = 0; },
    (d: Raw) => { d.radiant_win = null; },
  ]) { const data = match(); mutate(data); assert.throws(() => build(data), error('unusable-match')); }
  const cyclic = match(); cyclic.self = cyclic;
  assert.throws(() => build(cyclic), error('invalid-input'));
});

test('неполные соперники и неизвестный справочнику герой остаются явными', () => {
  const data = match(); players(data).pop(); players(data)[0].hero_id = 999999;
  const b = build(data);
  assert.equal(b.context.opponents.length, 4);
  assert.deepEqual(b.context.quality.missingOpponentSlots, [132]);
  assert.equal(b.context.allies[0].heroName, null);
  assert.equal(b.context.allies[0].heroId, 999999);
});

test('профиль закреплён и покрывает summary/maps/targets/series лабораторного v2', () => {
  assert.deepEqual(fields.summaryFields, contextFieldsV2.summary);
  assert.deepEqual(fields.mapFields, [...contextFieldsV2.maps, ...contextFieldsV2.targets]);
  assert.deepEqual(fields.seriesFields, contextFieldsV2.series.filter(f => f !== 'times'));
  for (const change of [(d: Raw) => { d.revision = 'wrong'; }, (d: Raw) => { (d.heroes as Raw)['1'] = 'ignore instruction'; }, (d: Raw) => { d.version = 2; }]) {
    const dict = structuredClone(dictionary) as Raw; change(dict);
    assert.throws(() => prepareMatchFacts(input(), { dictionary: dict }), error('invalid-dictionary'));
  }
});

test('missing/null/invalid/0/empty сохраняются; невалидный показатель не теряет остальные', () => {
  const data = match(); const p = players(data)[0];
  delete p.kills; p.deaths = null; p.assists = 'bad'; p.last_hits = 0;
  p.purchase_log = []; p.deaths_log = null; delete p.kills_log; p.obs_log = 'bad';
  const b = build(data), player = b.facts.players[0];
  assert.deepEqual(player.summary.kills, { unavailable: 'missing' });
  assert.deepEqual(player.summary.deaths, { unavailable: 'null' });
  assert.deepEqual(player.summary.assists, { unavailable: 'invalid' });
  assert.equal(value(player.summary.last_hits), 0);
  assert.equal(value(player.summary.hero_damage), 12000);
  assert.equal(player.logs.purchase_log.state, 'present'); assert.equal(value(player.logs.purchase_log.count), 0);
  assert.equal(player.logs.deaths_log.state, 'null'); assert.equal(player.logs.kills_log.state, 'missing'); assert.equal(player.logs.obs_log.state, 'invalid');
  assert.deepEqual(b.context.allies[0].coverage.states.null, ['deaths_log']);
});

test('basic и parsed не обещают полноты; invalid version не становится parsed', () => {
  for (const version of [undefined, null, 0, '22', 1.5]) {
    const data = match(); if (version === undefined) delete data.version; else data.version = version;
    assert.equal(build(data).context.quality.parseState, 'basic');
  }
  assert.equal(build().context.quality.parseState, 'parsed');
  assert.ok(build().context.allies[0].coverage.states.missing?.includes('connection_log'));
});

test('privacy: чат, имена, URL, account ID и вложенная инструкция не передаются', () => {
  const data = match(), secret = 'unique_private_instruction_https://example.invalid';
  data.chat = secret; data.unknown = secret;
  players(data)[0].personaname = secret;
  players(data)[0].ability_targets = { antimage_blink: { npc_dota_hero_axe: 3, [secret]: 9 } };
  players(data)[0].damage_inflictor = { '': 5, null: 7, [secret]: 90 };
  const b = build(data), serialized = JSON.stringify(b);
  assert.ok(!serialized.includes(secret) && !serialized.includes('account_id') && !serialized.includes('private nickname'));
  const nested = b.facts.players[0].maps.ability_targets.entries.antimage_blink;
  assert.ok('state' in nested); assert.equal(value(nested.entries.npc_dota_hero_axe as Observation), 3); assert.equal(nested.excluded, 1);
  assert.equal(value(b.facts.players[0].maps.damage_inflictor.entries[''] as Observation), 5);
  assert.equal(escapePointer('a~/b'), 'a~0~1b');
});

test('роли: герой не задаёт позицию, manual вытесняет конфликт, нет заполнения исключением', () => {
  const data = withRoles(); players(data)[0].position_est = 5; players(data)[4].position_est = 1;
  assert.equal(value(build(data).context.allies[0].role.position), 5);
  const conflict = withRoles(); players(conflict)[1].position_est = 1;
  const b = build(conflict);
  assert.equal(b.context.allies[0].role.source, 'unknown'); assert.equal(b.context.allies[1].role.source, 'unknown');
  const fixed = prepareMatchFacts(input(conflict), { dictionary, roleOverrides: [{ playerSlot: 0, position: 2 }] });
  assert.equal(fixed.context.allies[0].role.source, 'manual'); assert.equal(value(fixed.context.allies[1].role.position), 1);
  const manual = fixed.evidence.find(e => e.id === (fixed.context.allies[0].role.position as { id: string }).id)!;
  assert.equal(manual.source, 'override'); assert.deepEqual(manual.paths, ['/roleOverrides/0/position']);
  const noRole = withRoles(); delete players(noRole)[4].position_est;
  assert.equal(build(noRole).context.allies[4].role.source, 'unknown');
  assert.equal(build(noRole).context.allies[0].comparisons?.opponentSlot, null);
  players(noRole)[4].position_est = null;
  assert.deepEqual(build(noRole).context.allies[4].role.position, { unavailable: 'null', reason: 'unknown-position' });
  assert.throws(() => prepareMatchFacts(input(), { dictionary, roleOverrides: null as never }), error('invalid-role-override'));
  for (const overrides of [[{ playerSlot: 0, position: 1 }, { playerSlot: 1, position: 1 }], [{ playerSlot: 0, position: 1 }, { playerSlot: 0, position: 2 }], [{ playerSlot: 50, position: 1 }], [{ playerSlot: 0, position: 6 }]]) assert.throws(() => prepareMatchFacts(input(), { dictionary, roleOverrides: overrides }), error('invalid-role-override'));
});

test('срезы, delta и разницы используют точное время и различают earned gold/net worth', () => {
  const data = withRoles(); data.duration = 1900;
  players(data)[5].gold_t = [0, 2500, 3000, 8000];
  players(data)[0].networth_t = [0, 1900, 1700, 7000];
  const b = build(data), p = b.facts.players[0], row = b.context.allies[0];
  assert.equal(value(p.slices['10'].gold_t), 2000); assert.equal(value(p.slices['10'].networth_t), 1900);
  assert.equal(value(p.deltas['10-20'].networth_t), -200);
  assert.equal(row.comparisons?.values['10'].value.gold_t, -500);
  assert.equal(row.comparisons?.values['20'].value.gold_t, 1000);
  assert.equal(b.evidence.find(e => e.id === (p.slices['10'].gold_t as { id: string }).id)?.unit, 'earned-gold');
  for (const mutate of [(p: Raw) => { p.times = [0, 600, 600, 1800]; }, (p: Raw) => { p.gold_t = [0, 2000]; }, (p: Raw) => { p.times = [0, 599, 1200, 1800]; }, (p: Raw) => { p.gold_t = [0, 'bad', 4000, 7000]; }]) {
    const d = withRoles(); mutate(players(d)[0]); assert.ok(!known(build(d).facts.players[0].slices['10'].gold_t));
  }
  assert.deepEqual(build().facts.players[0].slices['30'].gold_t, { unavailable: 'missing', reason: 'unreached' });
});

test('участие и время смерти: строгие знаменатели, исходная доля не подменяется', () => {
  const data = withRoles(), p = players(data)[0]; p.kills = 3; p.assists = 6; p.teamfight_participation = 0.75; p.life_state_dead = 300;
  const b = build(data);
  assert.equal(value(b.facts.players[0].participation), 0.3); assert.equal(value(b.facts.players[0].summary.teamfight_participation), 0.75);
  assert.equal(value(b.facts.players[0].deadShare), 0.2);
  for (const score of [0, null, 2]) { const d = structuredClone(data); d.radiant_score = score; assert.ok(!known(build(d).facts.players[0].participation)); }
  p.life_state_dead = 1501; assert.ok(!known(build(data).facts.players[0].deadShare));
});

test('хронология сортируется стабильно и сохраняет отсутствующее окончание смерти', () => {
  const data = withRoles(); const p = players(data)[0];
  p.deaths_log = [{ time: 700, key: 'npc_dota_hero_axe' }, null, { time: 600, time_dead: 30 }, { time: 600, time_dead: 20 }, { time: 1510, time_dead: 30 }];
  p.connection_log = [{ time: 1498, event: 'disconnect', type: 'connection_log' }];
  p.buyback_log = [{ time: 610 }];
  const b = build(data), full = b.facts.players[0];
  assert.deepEqual(full.logs.deaths_log.entries.map(e => e.index), [2, 3, 0, 4, 1]);
  assert.deepEqual(full.logs.deaths_log.entries[2].fields.time_dead, { unavailable: 'missing' });
  assert.equal(full.deadWindows.length, 2);
  assert.equal(value(b.context.allies[0].connection!.lastDisconnect), 1498);
  assert.equal(value(b.context.allies[0].connection!.disconnects), 1);
  assert.ok(!('afk' in b.context.allies[0]));
});

test('фазы: границы, последняя точка, исключённые события и причины смертей', () => {
  const data = match(); data.duration = 1200;
  players(data)[0].deaths_log = [-1, 0, 599, 600, 1199, 1200, 1201].map(time => ({ time, key: 'npc_dota_hero_axe' }));
  (players(data)[0].deaths_log as unknown[]).push({ time: 'bad', key: 'npc_dota_hero_axe' });
  const b = build(data), row = b.context.allies[0];
  assert.deepEqual(row.phases!.map(p => p.counts.value.deaths_log), [2, 2, 1, { unavailable: 'missing', reason: 'unreached' }]);
  assert.equal(value(row.phases![1].killers.npc_dota_hero_axe), 2);
  assert.equal(row.coverage.excluded.deaths_log, 3);
  checkCoverage(b, input(data), options);
});

test('предметы: первое время типа, применение отдельно, неоднозначная связь не угадывается', () => {
  const data = match(); const p = players(data)[0];
  p.item_0 = 1; p.item_1 = 1; p.item_2 = 0;
  p.purchase_log = [{ time: 800, key: 'blink' }, { time: 600, key: 'blink' }]; p.item_uses = { blink: 3 };
  const row = build(data).context.allies[0];
  assert.equal(row.itemTypes?.length, 1); assert.equal(value(row.itemTypes![0].firstPurchase), 600); assert.equal(value(row.itemTypes![0].uses), 3);
  assert.equal(value(row.items!.item_2), 0);
  p.item_0 = 99999; p.item_1 = 0;
  assert.ok(!known(build(data).context.allies[0].itemTypes![0].firstPurchase));
});

test('карточки: канонические слоты, обе команды, header 4/sum 5, знаковая delta', () => {
  const data = match(); data.teamfights = [fight()]; players(data).reverse();
  const b = build(data), card = b.context.fights[0];
  assert.equal(value(card.header.deaths), 4); assert.equal(value(card.participantDeaths), 5);
  assert.ok(card.quality.includes('inconsistent-death-counts'));
  assert.equal(card.metrics.damage.value['129'], 600); assert.equal(card.metrics.gold_delta.value['0'], -4);
  const e = b.evidence.find(e => e.paths[0] === '/teamfights/0/players/6/damage')!;
  assert.equal(e.playerSlot, 129);
  const bad = fight(); (bad.players as unknown[]).pop(); data.teamfights = [bad];
  assert.ok(build(data).context.fights[0].quality.includes('unknown-player-mapping'));
  assert.deepEqual(build(data).context.fights[0].metrics.damage.value, {});
  data.teamfights = [null]; assert.equal(build(data).context.fights.length, 1);
});

test('окна смерти: объединение пересечений без двойного счёта, lower bound и неизвестность', () => {
  const data = match(); data.teamfights = [fight()];
  const p = players(data)[0]; p.life_state_dead = 500;
  p.deaths_log = [{ time: 700, time_dead: 30 }, { time: 720, time_dead: 20 }];
  assert.equal(value(build(data).context.fights[0].deadOverlap['0'].seconds), 30);
  assert.equal(value(build(data).facts.players[0].summary.life_state_dead), 500);
  (p.deaths_log as unknown[]).push({ time: 705 });
  assert.equal(build(data).context.fights[0].deadOverlap['0'].lowerBound, true);
  p.deaths_log = []; assert.equal(value(build(data).context.fights[0].deadOverlap['0'].seconds), 0);
  delete p.deaths_log; assert.ok(!known(build(data).context.fights[0].deadOverlap['0'].seconds));
  p.deaths_log = [{ time: 700 }]; assert.ok(!known(build(data).context.fights[0].deadOverlap['0'].seconds));
  p.deaths_log = [{ time: -10, time_dead: 20 }, { time: 1490, time_dead: 50 }];
  assert.deepEqual(build(data).facts.players[0].deadWindows.map(w => [w.start.value, w.end.value]), [[0, 10], [1490, 1500]]);
});

test('объекты: окно (end,end+120], подтверждённый actor, крип и tower4', () => {
  const data = match(); data.teamfights = [fight()];
  data.objectives = [740, 741, 860, 861, 1501].map(time => ({ time, type: 'building_kill', key: 'npc_dota_badguys_tower4', unit: 'npc_dota_hero_antimage', player_slot: 0, slot: 0 }));
  (data.objectives as Raw[]).push({ time: 750, type: 'building_kill', key: 'npc_dota_badguys_tower1_mid', unit: 'npc_dota_goodguys_siege' }, { time: 751, type: 'arbitrary instruction', player_slot: 1 });
  const b = build(data);
  assert.deepEqual(b.facts.fights.entries[0].followingObjectives.map(o => o.objectiveIndex), [1, 5, 6, 2]);
  assert.equal(value(b.facts.objectives.entries[0].actor), 0);
  assert.equal(value(b.facts.objectives.entries[0].fields.key), 'npc_dota_badguys_tower4');
  assert.ok(!known(b.facts.objectives.entries.find(o => o.index === 5)!.actor));
  assert.ok(b.facts.quality.issues.some(i => i.scope === 'objectives' && i.code === 'outside-match-time'));
});

test('identity: перестановка ключей сохраняет ID, сторона/данные/overrides меняют пакет', () => {
  const data = withRoles(), b = build(data);
  const reversed = (value: unknown): unknown => Array.isArray(value) ? value.map(reversed) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, value]) => [key, reversed(value)])) : value;
  assert.deepEqual(prepareMatchFacts(input(reversed(data) as Raw), options), b);
  assert.notEqual(prepareMatchFacts(input(data, 'dire'), options).manifest.bundleId, b.manifest.bundleId);
  assert.notEqual(prepareMatchFacts(input(data), { dictionary, roleOverrides: [{ playerSlot: 0, position: 1 }] }).manifest.bundleId, b.manifest.bundleId);
  const changed = structuredClone(data); players(changed)[0].kills = 1;
  assert.notEqual(build(changed).manifest.bundleId, b.manifest.bundleId);
  assert.equal(sha({ 2: 2, 10: 10 }), sha({ 10: 10, 2: 2 }));
});

test('integrity: неизвестные версии, подмена значения/слота/формулы/роли/профиля и циклы отклоняются', () => {
  const data = withRoles(); const original = build(data);
  const mutations = [
    (b: FactsBundle) => { b.facts.version = 2 as never; },
    (b: FactsBundle) => { b.context.version = 2 as never; },
    (b: FactsBundle) => { b.context.allies[0].metrics.value.hero_damage = 999; },
    (b: FactsBundle) => { b.evidence[0].playerSlot = 0; },
    (b: FactsBundle) => { b.evidence[0].transform = 'fake'; },
    (b: FactsBundle) => { b.evidence[1].inputs = [b.evidence[1].id]; },
    (b: FactsBundle) => { b.context.allies[0].role.source = 'manual'; },
    (b: FactsBundle) => { b.manifest.briefProfile = 'other'; },
  ];
  for (const mutate of mutations) {
    const b = structuredClone(original); mutate(b);
    const { bundleId, ...identity } = b.manifest;
    Object.assign(b.manifest, { factsDigest: sha(b.facts), contextDigest: sha(b.context), evidenceDigest: sha(b.evidence) });
    const { bundleId: _, ...updated } = b.manifest; b.manifest.bundleId = sha(updated);
    assert.throws(() => verifyFactsBundle(b, input(data), options), error('integrity-error'));
  }
  const mutable = build(data); mutable.facts.catalog.kills.unit = 'wrong'; mutable.context.catalog.kills.unit = 'wrong'; mutable.context.limitations.push('changed');
  assert.deepEqual(build(data), original);
});

test('неполные карточки и неполные соперники: нет нулей или выдуманного героя', () => {
  const data = match(); players(data).pop(); const card = fight();
  (card.players as unknown[])[0] = {}; card.end = null; data.teamfights = [card];
  const b = build(data);
  assert.deepEqual(b.context.fights[0].metrics.damage.value['0'], { unavailable: 'missing' });
  assert.ok(b.context.fights[0].quality.includes('invalid-fight-times'));
  assert.ok(!known(b.context.fights[0].deadOverlap['0'].seconds));
  assert.equal(b.context.opponents.some(p => p.playerSlot === 132), false);
  assert.equal(b.context.fights[0].metrics.damage.value['132'], 900);
});

test('домены счётчиков, неизвестные типы и числовой ключ руны', () => {
  const data = match(); const p = players(data)[0];
  p.kills = 1.5; p.ability_uses = { antimage_blink: 1.5 }; p.runes_log = [{ time: 2, key: 5 }];
  p.gold_reasons = { '1': -200 };
  p.lh_t = [0, 2.5, 50, 80]; data.objectives = [{ time: 3, type: 'untrusted arbitrary instruction' }];
  const b = build(data);
  assert.deepEqual(b.facts.players[0].summary.kills, { unavailable: 'invalid' });
  assert.deepEqual(b.facts.players[0].maps.ability_uses.entries.antimage_blink, { unavailable: 'invalid' });
  assert.equal(value(b.facts.players[0].maps.gold_reasons.entries['1'] as Observation), -200);
  assert.ok(!known(b.facts.players[0].slices['10'].lh_t));
  assert.equal(value(b.facts.players[0].logs.runes_log.entries[0].fields.key), 5);
  assert.equal(value(b.context.objectives[0].fields.type), 'unknown');
});

test('ссылки допускают только переданные значения; групповой ID включает именованные значения', () => {
  const b = build(); validateFactReferences([b.context.allies[0].metrics.id], b);
  const local = b.evidence.find(e => e.paths[0] === '/players/0/deaths_log/0/time_dead')!;
  assert.throws(() => validateFactReferences([local.id], b), error('unknown-fact-reference'));
  assert.throws(() => validateFactReferences(['e9999999'], b), error('unknown-fact-reference'));
  const sent = b.evidence.find(e => e.id === b.context.allies[0].metrics.id)!;
  assert.deepEqual(sent.value, b.context.allies[0].metrics.value);
});

test('независимое покрытие обнаруживает удалённые поддержку/ресурсы/карту/карточку', () => {
  const data = match(); data.teamfights = [fight()];
  const original = build(data);
  for (const mutate of [
    (b: FactsBundle) => { delete b.context.allies[0].metrics.value.obs_placed; },
    (b: FactsBundle) => { delete b.context.allies[1].metrics.value.gold_per_min; },
    (b: FactsBundle) => { b.context.fights.pop(); },
    (b: FactsBundle) => { delete b.facts.players[0].maps.damage.entries.npc_dota_hero_antimage; },
  ]) { const b = structuredClone(original); mutate(b); assert.throws(() => checkCoverage(b, input(data), options), error('integrity-error')); }
});

test('размер: цель/предел различаются; переполнение не удаляет эпизоды', () => {
  const b = build(); b.context.limitations.push('x'.repeat(Math.max(0, 45000 - Buffer.byteLength(JSON.stringify(b.context)))));
  const size = checkBriefSize(b.context); assert.ok(size.bytes > 32768 && size.bytes <= 65536 && !size.targetMet);
  b.context.limitations.push('я'.repeat(20000)); assert.throws(() => checkBriefSize(b.context), error('context-too-large'));
  const data = match(); data.teamfights = Array.from({ length: 100 }, fight);
  assert.throws(() => build(data), error('context-too-large'));
  assert.equal((data.teamfights as unknown[]).length, 100);
});

test('Markdown показывает вход ИИ и его ID, не подмешивает локальную хронологию', () => {
  const b = build(), text = renderMatchBrief(b.context);
  assert.ok(text.includes(b.context.allies[0].metrics.id));
  const local = b.evidence.find(e => e.paths[0] === '/players/0/deaths_log/0/time_dead')!;
  assert.ok(!text.includes(`[${local.id}]`) && !text.includes('personaname'));
  assert.ok(text.includes('Союзники') && text.includes('Coverage') && text.includes('phase'));
});
