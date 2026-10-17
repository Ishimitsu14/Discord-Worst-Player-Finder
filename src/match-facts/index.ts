import { Ajv } from 'ajv';
import { buildBrief } from './brief.js';
import { normalize } from './normalize.js';
import { briefLimitBytes, briefProfile, briefTargetBytes, canonicalSlots, countFields, countMapFields, dictionaryDigest, dictionaryRevision, factsProfile, logFields, mapFields, seriesFields, signedMapFields, summaryFields } from './profile.js';
import { canonical, ensure, escapePointer, finite, known, number, object, sha } from './values.js';
import { FactsError, type Brief, type FactsBundle, type FactsOptions, type Manifest, type MatchFactsInput, type Observation, type Player, type Raw } from './types.js';

export * from './types.js';
export { briefLimitBytes, briefTargetBytes } from './profile.js';

const validateEnvelope = new Ajv().compile({
  type: 'object', required: ['facts', 'context', 'evidence', 'manifest'], additionalProperties: false,
  properties: {
    facts: { type: 'object', required: ['version', 'format', 'players', 'fights', 'objectives', 'quality', 'derived'], properties: { version: { const: 1 }, format: { const: 'facts-v1' } } },
    context: { type: 'object', required: ['version', 'format', 'allies', 'opponents', 'fights', 'coverage'], properties: { version: { const: 1 }, format: { const: 'match-brief-v1' } } },
    evidence: { type: 'array', items: { type: 'object', required: ['id', 'value', 'playerSlot', 'metric', 'unit', 'source', 'paths', 'inputs', 'transform', 'parameters'], additionalProperties: false, properties: {
      id: { type: 'string', pattern: '^e[1-9][0-9]*$' }, value: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'boolean' }, { type: 'object' }] }, playerSlot: { type: ['number', 'null'] },
      metric: { type: 'string' }, unit: { type: 'string' }, source: { enum: ['snapshot', 'override', 'derived'] }, paths: { type: 'array', items: { type: 'string' } }, inputs: { type: 'array', items: { type: 'string' } }, transform: { type: 'string' }, parameters: { type: 'object', additionalProperties: { type: 'number' } },
    } } },
    manifest: { type: 'object', required: ['version', 'factsFormat', 'briefFormat', 'bundleId'], properties: { version: { const: 1 }, factsFormat: { const: 'facts-v1' }, briefFormat: { const: 'match-brief-v1' } } },
  },
});

export function checkBriefSize(context: Brief): { bytes: number; targetMet: boolean; limitMet: boolean } {
  const bytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
  ensure(bytes <= briefLimitBytes, 'context-too-large', { bytes, limit: briefLimitBytes });
  return { bytes, targetMet: bytes <= briefTargetBytes, limitMet: true };
}

export function prepareMatchFacts(input: MatchFactsInput, options: FactsOptions): FactsBundle {
  const { facts, registry, dictionary, overrides } = normalize(input, options);
  const context = buildBrief(facts, registry, dictionary);
  checkBriefSize(context);
  const identity: Omit<Manifest, 'bundleId'> = {
    version: 1, factsFormat: 'facts-v1', briefFormat: 'match-brief-v1', factsProfile, briefProfile,
    factsTransform: 'normalize-1', briefTransform: 'summarize-1', matchId: input.matchId, side: input.side,
    dataDigest: sha(input.data), dictionaryRevision, dictionaryDigest,
    overridesDigest: sha([...overrides].sort((a, b) => a.playerSlot - b.playerSlot)),
    factsDigest: sha(facts), contextDigest: sha(context), evidenceDigest: sha(registry.entries),
  };
  return { facts, context, evidence: registry.entries, manifest: { ...identity, bundleId: sha(identity) } };
}

function observations(value: unknown, out = new Map<string, unknown>()): Map<string, unknown> {
  if (Array.isArray(value)) value.forEach(child => observations(child, out));
  else if (object(value)) {
    if (typeof value.id === 'string' && Object.hasOwn(value, 'value')) {
      ensure(!out.has(value.id) || canonical(out.get(value.id)) === canonical(value.value), 'integrity-error');
      out.set(value.id, value.value);
    } else Object.values(value).forEach(child => observations(child, out));
  }
  return out;
}

export function validateFactReferences(ids: string[], bundle: FactsBundle): void {
  ensure(Array.isArray(ids) && ids.every(id => typeof id === 'string'), 'unknown-fact-reference');
  const sent = observations(bundle.context);
  const entries = new Map(bundle.evidence.map(entry => [entry.id, entry]));
  for (const id of ids) ensure(sent.has(id) && entries.has(id) && canonical(sent.get(id)) === canonical(entries.get(id)!.value), 'unknown-fact-reference');
}

export function checkCoverage(bundle: FactsBundle, input: MatchFactsInput, options: FactsOptions): { facts: true; brief: true; players: number; fights: number } {
  const data = input.data as Raw, rawPlayers = data.players as Raw[];
  const full = bundle.facts, brief = bundle.context;
  const require = (value: unknown): void => ensure(value, 'integrity-error');
  const dictionary = options.dictionary as { heroes: Raw; items: Raw; abilities: Raw };
  const safeKey = (key: string, field: string): boolean => /^\d+$/.test(key) || [dictionary.heroes, dictionary.items, dictionary.abilities].some(values => Object.hasOwn(values, key)) || /^npc_dota_(?:goodguys|badguys)_(?:tower(?:[1-3]_(?:top|mid|bot)|4(?:_(?:top|mid|bot))?)|(?:melee|range)_rax_(?:top|mid|bot)|fort)$/.test(key) || (['damage_inflictor', 'damage_inflictor_received', 'healing'].includes(field) && ['', 'null'].includes(key));
  const identities = new Map(bundle.evidence.filter(entry => entry.transform === 'identity-v1' && entry.source === 'snapshot').map(entry => [entry.paths[0], entry]));
  const requireIdentity = (path: string, value: unknown): void => require(identities.has(path) && canonical(identities.get(path)!.value) === canonical(value));
  require(full.players.length === rawPlayers.length && brief.allies.length === 5 && brief.opponents.length === rawPlayers.length - 5);
  for (const raw of rawPlayers) {
    const rawIndex = rawPlayers.indexOf(raw), path = `/players/${rawIndex}`;
    const player = full.players.find(player => player.playerSlot === raw.player_slot);
    const row = [...brief.allies, ...brief.opponents].find(player => player.playerSlot === raw.player_slot);
    require(player && row && player.heroId === raw.hero_id);
    require([...summaryFields, 'position_est'].every(field => field in player!.summary));
    require(mapFields.every(field => field in player!.maps));
    for (const field of summaryFields) {
      const value = raw[field];
      const valid = finite(value) && value >= 0 && (!countFields.has(field) || Number.isSafeInteger(value)) || field === 'is_roaming' && typeof value === 'boolean';
      if (valid) { requireIdentity(`${path}/${field}`, value); require(known(player!.summary[field]) && (player!.summary[field] as { value: unknown }).value === value); }
    }
    const checkMap = (rawMap: unknown, normalized: Player['maps'][string], field: string, path: string): void => {
      if (!object(rawMap)) { require(normalized.state === (rawMap === undefined ? 'missing' : rawMap === null ? 'null' : 'invalid')); return; }
      require(normalized.state === 'present');
      for (const [key, value] of Object.entries(rawMap)) {
        if (!safeKey(key, field)) continue;
        if (object(value)) { const child = normalized.entries[key]; require(child && 'state' in child); checkMap(value, child as Player['maps'][string], field, `${path}/${escapePointer(key)}`); }
        else if (finite(value) && (value >= 0 || signedMapFields.has(field)) && (!countMapFields.has(field) || Number.isSafeInteger(value))) { requireIdentity(`${path}/${escapePointer(key)}`, value); const child = normalized.entries[key]; require(child && 'id' in child && child.value === value); }
      }
    };
    for (const field of mapFields) checkMap(raw[field], player!.maps[field], field, `${path}/${field}`);
    const covered = Object.values(row!.coverage.states).flat();
    require(logFields.every(field => field in player!.logs && covered.includes(field)));
    require(mapFields.every(field => field in player!.maps && covered.includes(field)));
    require([10, 20, 30].every(minute => seriesFields.every(field => field in player!.slices[minute])));
    const requiredMetrics = (Number(raw.player_slot) < 128) === (input.side === 'radiant')
      ? ['kills', 'deaths', 'assists', 'gold_per_min', 'xp_per_min', 'net_worth', 'last_hits', 'hero_damage', 'tower_damage', 'hero_healing', 'stuns', 'life_state_dead', 'participation', 'deadShare', 'obs_placed', 'sen_placed', 'observer_kills', 'sentry_kills', 'camps_stacked', 'buyback_count']
      : ['kills', 'deaths', 'assists', 'gold_per_min', 'xp_per_min', 'net_worth', 'hero_damage', 'tower_damage', 'stuns', 'life_state_dead'];
    require(requiredMetrics.every(field => field in row!.metrics.value));
    for (const field of requiredMetrics.filter(field => field in raw)) {
      const value = row!.metrics.value[field];
      if (typeof value === 'number') require(value === raw[field]);
    }
    for (const field of logFields) {
      const log = player!.logs[field], rawLog = raw[field];
      if (Array.isArray(rawLog)) require(log.state === 'present' && number(log.count) === rawLog.length && log.entries.length === rawLog.length && row!.coverage.sourceCounts[field] === rawLog.length);
    }
    if (brief.allies.includes(row!)) {
      require(row!.phases?.length === 4 && row!.items && Object.keys(row!.items).length === 10 && row!.abilities && row!.connection && row!.comparisons);
      for (const phase of row!.phases!) for (const field of ['deaths_log', 'kills_log', 'obs_log', 'sen_log', 'purchase_log']) {
        const rawLog = raw[field], observation = phase.counts.value[field];
        if (!Array.isArray(rawLog) || !phase.reached) { require(object(observation) && 'unavailable' in observation); continue; }
        const phaseIndex = row!.phases!.indexOf(phase);
        const expected = rawLog.filter(event => object(event) && finite(event.time) && event.time >= phase.from && event.time <= Number(data.duration) && (phaseIndex === 3 || event.time < [600, 1200, 1800][phaseIndex])).length;
        require(observation === expected);
      }
    }
  }
  const rawFights = Array.isArray(data.teamfights) ? data.teamfights : [];
  require(full.fights.entries.length === rawFights.length && brief.fights.length === rawFights.length);
  for (let i = 0; i < rawFights.length; i++) {
    require(full.fights.entries[i].index === i && brief.fights[i].index === i);
    const raw = rawFights[i];
    if (object(raw) && Array.isArray(raw.players) && raw.players.length === 10) {
      for (const field of ['deaths', 'buybacks', 'damage', 'healing', 'gold_delta']) {
        const values = brief.fights[i].metrics[field].value;
        require(Object.keys(values).length === 10 && canonicalSlots.every(slot => String(slot) in values));
        raw.players.forEach((player, index) => {
          if (!object(player)) return;
          const value = player[field];
          if (finite(value) && (field === 'gold_delta' || value >= 0) && (!['deaths', 'buybacks'].includes(field) || Number.isSafeInteger(value))) require(values[canonicalSlots[index]] === value);
        });
      }
    }
  }
  require(full.objectives.entries.length === (Array.isArray(data.objectives) ? data.objectives.length : 0) && brief.objectives.length === full.objectives.entries.length);
  const fullValues = observations(full);
  for (const [id, value] of observations(brief)) require(fullValues.has(id) && canonical(fullValues.get(id)) === canonical(value));
  return { facts: true, brief: true, players: rawPlayers.length, fights: rawFights.length };
}

export function verifyFactsBundle(bundle: unknown, input: MatchFactsInput, options: FactsOptions): FactsBundle {
  try {
    ensure(validateEnvelope(bundle), 'integrity-error');
    const value = bundle as FactsBundle;
    const seen = new Set<string>();
    for (const entry of value.evidence) {
      ensure(!seen.has(entry.id) && entry.inputs.every(id => seen.has(id)), 'integrity-error');
      ensure(entry.source === 'derived' || entry.paths.length > 0, 'integrity-error');
      seen.add(entry.id);
    }
    const { bundleId, ...identity } = value.manifest;
    ensure(sha(identity) === bundleId && sha(value.facts) === identity.factsDigest && sha(value.context) === identity.contextDigest && sha(value.evidence) === identity.evidenceDigest, 'integrity-error');
    checkCoverage(value, input, options);
    const expected = prepareMatchFacts(input, options);
    ensure(canonical(value) === canonical(expected), 'integrity-error');
    return value;
  } catch (error) {
    if (error instanceof FactsError && error.code === 'integrity-error') throw error;
    throw new FactsError('integrity-error');
  }
}
