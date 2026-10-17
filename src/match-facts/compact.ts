import { normalize, onSide, validateDictionary } from './normalize.js';
import { canonicalSlots, dictionaryDigest } from './profile.js';
import { canonical, ensure, finite, integer, known, missing, number, object, sha, state } from './values.js';
import { FactsError, type Fact, type MatchFactsInput, type Observation, type Raw, type Unavailable } from './types.js';
import type { CompactBenchmark, CompactChat, CompactContext, CompactCore, CompactFactsBundle, CompactFactsOptions, CompactManifest, CompactNumber, CompactPlayer, CompactRoleSource, KeyItemTiming } from './compact-types.js';

export const compactTargetBytes = 4096;
export const compactLimitBytes = 16384;
export const keyItems = ['blink', 'black_king_bar', 'hand_of_midas', 'radiance', 'bfury', 'blade_mail', 'greater_crit', 'swift_blink', 'overwhelming_blink', 'arcane_blink', 'rapier'];
const metrics = ['kills', 'deaths', 'assists', 'gold_per_min', 'xp_per_min', 'last_hits', 'denies', 'hero_damage', 'tower_damage', 'hero_healing', 'stuns', 'obs_placed', 'sen_placed', 'observer_kills', 'sentry_kills', 'camps_stacked', 'lane_role'] as const;
const heroMetrics = { version: 1, source: 'https://github.com/odota/dotaconstants/blob/master/build/permanent_buffs.json', revision: 'snapshot-2026-10-17', heroes: { '14': { buff: 4, metric: 'flesh_heap' }, '26': { buff: 7, metric: 'finger_stacks' }, '104': { buff: 5, metric: 'duel_damage' } } };
export const heroMetricsDictionaryDigest = sha(heroMetrics);
const unwrap = <T>(value: Observation<T>): T | Unavailable => known(value) ? value.value : value;
const unavailable = (value: unknown, reason?: string): Unavailable => missing(value, reason) as Unavailable;
const truncate = (text: string, limit: number): string => Array.from(text).slice(0, limit).join('');

export function validateCompactDictionaries(options: Pick<CompactFactsOptions, 'dictionary' | 'heroMetricsDictionary'>): void {
  ensure(object(options), 'invalid-dictionary'); validateDictionary(options.dictionary);
  try { ensure(sha(options.heroMetricsDictionary) === heroMetricsDictionaryDigest, 'invalid-dictionary'); } catch { throw new FactsError('invalid-dictionary'); }
}

export function checkCompactSize(context: CompactContext): { bytes: number; coreBytes: number; targetMet: boolean; limitMet: true } {
  const { chat: _, ...core } = context;
  const bytes = Buffer.byteLength(JSON.stringify(context), 'utf8'), coreBytes = Buffer.byteLength(JSON.stringify(core), 'utf8');
  ensure(bytes <= compactLimitBytes, 'context-too-large', { bytes, limit: compactLimitBytes });
  return { bytes, coreBytes, targetMet: coreBytes <= compactTargetBytes, limitMet: true };
}

export function prepareCompactMatchFacts(input: MatchFactsInput, options: CompactFactsOptions): CompactFactsBundle {
  ensure(object(options) && Object.keys(options).every(key => ['dictionary', 'heroMetricsDictionary', 'roleOverrides'].includes(key)));
  validateCompactDictionaries(options);
  const { facts: base, registry, overrides } = normalize(input, options);
  const data = input.data as Raw, rawPlayers = data.players as Raw[], duration = Number(data.duration);
  const groups: CompactContext['coverage']['groups'] = {};
  const group = <T extends object>(value: T, metric: string, slot: number | null, paths: string[], inputs: string[] = [], sourceState: unknown = {}): Fact<T> => {
    groups[`${slot ?? 'match'}:${metric}`] = { source_state: object(sourceState) || Array.isArray(sourceState) ? 'present' : state(sourceState), unavailable_fields: Object.entries(value).filter(([, value]) => object(value) && 'unavailable' in value).map(([key]) => key) };
    return registry.add(value, metric, slot, paths, 'compact-group-v1', inputs, 'derived');
  };
  const roleSource = (source: string): CompactRoleSource => source === 'opendota-estimate' ? 'position_est' : source === 'manual' ? 'manual' : 'unknown';
  const score = base.match[input.side === 'radiant' ? 'radiant_score' : 'dire_score'];
  const match_info = group({ match_id: input.matchId, duration_sec: duration, duration_min: Math.round(duration / 60), side: input.side, won: data.radiant_win === (input.side === 'radiant'), total_team_kills: unwrap(score) as CompactNumber }, 'compact-match', null,
    ['/match_id', '/duration', '/radiant_win', `/${input.side}_score`], Object.values(base.match).filter(known).map(value => value.id));
  const extraPlayers: CompactFactsBundle['facts']['extras']['players'] = [];
  const players: CompactPlayer[] = [], opponents: CompactContext['opponents'] = [];
  for (const player of base.players) {
    const slot = player.playerSlot, rawIndex = rawPlayers.findIndex(raw => raw.player_slot === slot), raw = rawPlayers[rawIndex], path = `/players/${rawIndex}`;
    const common = { player_slot: slot, hero_id: player.heroId, hero_name: player.heroName, position: unwrap(player.role.position), position_source: roleSource(player.role.source), networth: unwrap(player.summary.net_worth) as CompactNumber };
    if (!onSide(slot, input.side)) { opponents.push(group(common, 'compact-opponent', slot, [path], [player.hero.id, ...[player.role.position, player.summary.net_worth].filter(known).map(value => value.id)])); continue; }
    const validName = typeof raw.personaname === 'string' && raw.personaname.trim().length > 0;
    const fullName = validName ? raw.personaname as string : null, player_name = fullName === null ? 'Anonymous' : truncate(fullName, 64);
    const kills = number(player.summary.kills), assists = number(player.summary.assists), teamKills = number(score);
    const participation = kills !== undefined && assists !== undefined && teamKills !== undefined && teamKills > 0 && kills + assists <= teamKills
      ? registry.derive(Math.round((kills + assists) / teamKills * 100), 'kill_participation_pct', slot, 'rounded-kp-percent-v1', [player.summary.kills, player.summary.assists, score])
      : missing(undefined, 'invalid-kp-inputs');
    const core = group({ ...common, player_name, name_source: validName ? 'present' as const : state(raw.personaname), name_truncated: fullName !== null && fullName !== player_name,
      ...Object.fromEntries(metrics.map(field => [field, unwrap(player.summary[field])])), kill_participation_pct: unwrap(participation) } as CompactCore,
      'compact-player', slot, [path], [player.hero, player.role.position, participation, ...Object.values(player.summary)].filter(known).map(value => value.id));
    const log = raw.purchase_log;
    const timings: Record<string, KeyItemTiming> = Object.fromEntries(keyItems.map(item => {
      if (!Array.isArray(log)) return [item, unavailable(log)];
      const times = log.filter(entry => object(entry) && entry.key === item && finite(entry.time) && entry.time >= 0 && entry.time <= duration).map(entry => (entry as Raw).time as number);
      return [item, times.length ? { first_purchase_sec: Math.min(...times), rounded_min: Math.round(Math.min(...times) / 60) } : unavailable(undefined, 'no-confirmed-purchase')];
    }));
    const benchmarks: Record<string, CompactBenchmark> = Object.fromEntries(['gold_per_min', 'hero_damage_per_min'].map(metric => {
      if (!object(raw.benchmarks)) return [metric, unavailable(raw.benchmarks)];
      const benchmark = raw.benchmarks[metric];
      if (!object(benchmark)) return [metric, unavailable(benchmark)];
      return [metric, { raw: finite(benchmark.raw) && benchmark.raw >= 0 ? benchmark.raw : unavailable(benchmark.raw), pct: finite(benchmark.pct) && benchmark.pct >= 0 && benchmark.pct <= 1 ? benchmark.pct : unavailable(benchmark.pct) }];
    }));
    const special: Record<string, CompactNumber> = {};
    const rule = heroMetrics.heroes[String(player.heroId) as keyof typeof heroMetrics.heroes];
    if (rule) {
      const buffs = raw.permanent_buffs;
      const entries = Array.isArray(buffs) ? buffs.filter(entry => object(entry) && entry.permanent_buff === rule.buff) as Raw[] : [];
      special[rule.metric] = !Array.isArray(buffs) ? unavailable(buffs) : entries.length !== 1 ? unavailable(entries.length ? false : undefined, entries.length ? 'ambiguous-buff' : 'missing-buff')
        : integer(entries[0].stack_count) ? entries[0].stack_count : unavailable(entries[0].stack_count);
    }
    if (player.heroId === 14) special.hook_accuracy = unavailable(undefined, 'no-verified-hit-source');
    const extras = {
      key_item_timings: group(timings, 'compact-items', slot, [`${path}/purchase_log`], [], log),
      benchmarks: group(benchmarks, 'compact-benchmarks', slot, [`${path}/benchmarks`], [], raw.benchmarks),
      special_metrics: group(special, 'compact-special', slot, [`${path}/hero_id`, `${path}/permanent_buffs`], [], raw.permanent_buffs),
    };
    players.push({ core, ...extras }); extraPlayers.push({ player_slot: slot, player_name: fullName, groups: extras });
  }
  const fullChat: CompactChat[] = [], excluded: Record<string, number> = {};
  const exclude = (reason: string): void => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
  if (Array.isArray(data.chat)) data.chat.forEach((entry, source_index) => {
    if (!object(entry) || entry.type !== 'chat') { exclude('not-text-chat'); return; }
    if (typeof entry.key !== 'string' || !entry.key.trim()) { exclude('invalid-text'); return; }
    if (!finite(entry.time) || entry.time < 0 || entry.time > duration) { exclude('invalid-time'); return; }
    const hasCanonical = Object.hasOwn(entry, 'player_slot'), hasSlot = Object.hasOwn(entry, 'slot');
    const canonicalSlot = integer(entry.player_slot) && canonicalSlots.includes(entry.player_slot) ? entry.player_slot : undefined;
    const mappedSlot = integer(entry.slot) && entry.slot < canonicalSlots.length ? canonicalSlots[entry.slot] : undefined;
    if (hasCanonical && canonicalSlot === undefined || hasSlot && mappedSlot === undefined || hasCanonical && hasSlot && canonicalSlot !== mappedSlot) { exclude('invalid-author'); return; }
    const slot = canonicalSlot ?? mappedSlot;
    if (slot === undefined || !base.players.some(player => player.playerSlot === slot)) { exclude('unknown-author'); return; }
    if (!onSide(slot, input.side)) { exclude('opponent'); return; }
    fullChat.push({ source_index, player_slot: slot, time_sec: entry.time, rounded_min: Math.round(entry.time / 60), text: entry.key, truncated: false });
  });
  fullChat.sort((a, b) => a.time_sec - b.time_sec || a.source_index - b.source_index);
  const selectedChat = fullChat.slice(-20);
  if (fullChat.length > selectedChat.length) excluded['message-limit'] = fullChat.length - selectedChat.length;
  const chat = selectedChat.map(entry => {
    const text = truncate(entry.text, 240), value = { ...entry, text, truncated: text !== entry.text };
    return registry.add(value, 'compact-chat', entry.player_slot, [`/chat/${entry.source_index}`], 'chat-prefix-v1', [], 'derived', { maxCodePoints: 240 });
  });
  const context: CompactContext = { version: 1, format: 'gemini-compact-v1', match_info, players, opponents, chat, coverage: {
    parse_state: base.quality.parseState, missing_opponent_slots: base.quality.missingOpponentSlots, groups,
    chat: { source_state: Array.isArray(data.chat) ? 'present' : state(data.chat), source_count: Array.isArray(data.chat) ? data.chat.length : 0, eligible_count: fullChat.length, sent_count: chat.length, truncated_count: chat.filter(row => row.value.truncated).length, excluded },
  } };
  checkCompactSize(context);
  const facts: CompactFactsBundle['facts'] = { ...base, format: 'gemini-facts-v1', extras: { players: extraPlayers, chat: fullChat } };
  const identity: Omit<CompactManifest, 'bundleId'> = { version: 1, format: 'gemini-compact-manifest-v1', profile: 'gemini-compact-v1', transform: 'compact-1', matchId: input.matchId, side: input.side,
    sourceDataDigest: sha(data), optionsDigest: sha({ roleOverrides: [...overrides].sort((a, b) => a.playerSlot - b.playerSlot) }), dictionaryDigest, heroMetricsDictionaryDigest,
    factsDigest: sha(facts), contextDigest: sha(context), evidenceDigest: sha(registry.entries) };
  return { facts, context, evidence: registry.entries, manifest: { ...identity, bundleId: sha(identity) } };
}

export function compactReferences(context: CompactContext): Map<string, { kind: 'game' | 'chat'; slot: number | null; value: unknown }> {
  const entries = new Map<string, { kind: 'game' | 'chat'; slot: number | null; value: unknown }>();
  const add = (fact: Fact<unknown>, kind: 'game' | 'chat', slot: number | null): void => {
    ensure(object(fact) && /^e[1-9][0-9]*$/.test(fact.id) && !entries.has(fact.id), 'integrity-error'); entries.set(fact.id, { kind, slot, value: fact.value });
  };
  add(context.match_info, 'game', null);
  context.players.forEach(player => Object.values(player).forEach(fact => add(fact, 'game', player.core.value.player_slot)));
  context.opponents.forEach(player => add(player, 'game', player.value.player_slot));
  context.chat.forEach(chat => add(chat, 'chat', chat.value.player_slot));
  return entries;
}

export function validateCompactReferences(ids: string[], bundle: CompactFactsBundle): void {
  ensure(Array.isArray(ids) && ids.every(id => typeof id === 'string'), 'unknown-fact-reference');
  const sent = compactReferences(bundle.context), entries = new Map(bundle.evidence.map(entry => [entry.id, entry]));
  for (const id of ids) ensure(sent.has(id) && entries.has(id) && canonical(sent.get(id)!.value) === canonical(entries.get(id)!.value) && sent.get(id)!.slot === entries.get(id)!.playerSlot, 'unknown-fact-reference');
}

export function verifyCompactFactsBundle(bundle: unknown, input: MatchFactsInput, options: CompactFactsOptions): CompactFactsBundle {
  try {
    ensure(canonical(bundle) === canonical(prepareCompactMatchFacts(input, options)), 'integrity-error');
    return bundle as CompactFactsBundle;
  } catch { throw new FactsError('integrity-error'); }
}

export function renderCompactContext(context: CompactContext): string {
  return `# Компактные факты ${context.match_info.value.match_id}/${context.match_info.value.side}\n\nФормат: ${context.format}. Не рейтинг качества.\n\n${context.players.map(player => `- [${player.core.id}] ${player.core.value.player_slot}: ${JSON.stringify(player.core.value)}`).join('\n')}\n\n## Чат для roast\n\n${context.chat.map(row => `- [${row.id}] ${row.value.time_sec}s, слот ${row.value.player_slot}${row.value.truncated ? ' (сокращено)' : ''}: ${JSON.stringify(row.value.text)}`).join('\n')}\n`;
}
