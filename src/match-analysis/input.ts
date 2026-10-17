import { Ajv } from 'ajv';
import { checkBriefSize, validateFactReferences } from '../match-facts/index.js';
import type { Brief, FactsBundle, Raw } from './types.js';
import { AnalysisError } from './types.js';
import { canonical, ensure, object, sha } from './values.js';

const obj = (properties: Raw, required = Object.keys(properties)): Raw => ({ type: 'object', properties, required, additionalProperties: false });
const list = (items: Raw): Raw => ({ type: 'array', items });
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const scalar = { type: 'number' };
const boolean = { type: 'boolean' };
const token = { type: 'string', pattern: '^[a-zA-Z0-9_.-]+$' };
const states = ['present', 'missing', 'null', 'invalid'];
const slot = { enum: [0, 1, 2, 3, 4, 128, 129, 130, 131, 132] };
const nullableSlot = { enum: [null, ...slot.enum] };
const unavailable = obj({ unavailable: { enum: states.slice(1) }, reason: { type: 'string', pattern: '^[a-z0-9-]+$' } }, ['unavailable']);
const fact = (value: Raw): Raw => obj({ id: { type: 'string', pattern: '^e[1-9][0-9]*$' }, value });
const observation = (value: Raw = scalar): Raw => ({ anyOf: [fact(value), unavailable] });
const record = (value: Raw, names?: string[]): Raw => ({ type: 'object', additionalProperties: value, propertyNames: names ? { enum: names } : token });
const fields = (names: string[], value: Raw = observation()): Raw => obj(Object.fromEntries(names.map(name => [name, value])));
const group = (names: string[], required = true): Raw => fact({ ...fields(names, { anyOf: [scalar, boolean, unavailable] }), ...(required ? {} : { required: [] }) });
const maps = ['damage', 'damage_taken', 'hero_hits', 'killed', 'killed_by', 'item_uses', 'ability_uses', 'damage_inflictor', 'damage_inflictor_received', 'healing', 'gold_reasons', 'xp_reasons', 'ability_targets', 'damage_targets'];
const logs = ['purchase_log', 'kills_log', 'deaths_log', 'buyback_log', 'runes_log', 'obs_log', 'sen_log', 'obs_left_log', 'sen_left_log', 'connection_log'];
const phases = ['deaths_log', 'kills_log', 'obs_log', 'sen_log', 'purchase_log'];
const coverageFields = [...maps, ...logs, 'summary', 'slices'];
const matchFields = ['duration', 'radiant_win', 'game_mode', 'lobby_type', 'patch', 'start_time', 'version', 'radiant_score', 'dire_score', 'tower_status_radiant', 'tower_status_dire', 'barracks_status_radiant', 'barracks_status_dire'];
const commonMetrics = ['kills', 'deaths', 'assists', 'gold_per_min', 'xp_per_min', 'net_worth', 'hero_damage', 'tower_damage', 'stuns', 'life_state_dead'];
const allyMetrics = [...commonMetrics, 'last_hits', 'hero_healing', 'obs_placed', 'sen_placed', 'observer_kills', 'sentry_kills', 'camps_stacked', 'buyback_count', 'participation', 'deadShare'];
const series = ['gold_t', 'networth_t', 'xp_t', 'lh_t'];
const itemFields = ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5', 'backpack_0', 'backpack_1', 'backpack_2', 'item_neutral'];
const representation = { enum: ['direct', 'aggregate', 'local-only'] };
const coverage = obj({ sourceState: { enum: states }, representation, sourceCount: count, reportedCount: count, excluded: count }, ['sourceState', 'representation']);
const name = { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^<>\\r\\n]+$' }] };
const player = (ally: boolean): Raw => obj({
  playerSlot: slot, heroId: { ...count, minimum: 1 }, heroName: name, hero: fact({ ...count, minimum: 1 }),
  role: obj({ position: observation({ type: 'integer', minimum: 1, maximum: 5 }), source: { enum: ['opendota-estimate', 'manual', 'unknown'] } }),
  metrics: group(ally ? allyMetrics : commonMetrics), economy: fields(['10', '20', '30'], group(series)),
  coverage: obj({ states: record(list({ enum: coverageFields }), states), sourceCounts: record(count, coverageFields), reportedCounts: record(count, coverageFields), defaultReportedCount: { const: 0 }, excluded: record(count, coverageFields) }),
  ...(ally ? {
    comparisons: obj({ opponentSlot: nullableSlot, reason: { const: 'incomplete-or-ambiguous-roles' }, values: fields(['10', '20', '30'], group(series.slice(0, 3))) }, ['opponentSlot', 'values']),
    items: fields(itemFields), itemTypes: list(obj({ itemId: { ...count, minimum: 1 }, name, firstPurchase: observation(), uses: observation() })),
    abilities: obj({ state: { enum: states }, entries: record(observation()), excluded: count }),
    phases: { ...list(obj({ from: scalar, to: scalar, reached: boolean, counts: group(phases), killers: record(fact(count)), unknownKillers: count })), minItems: 4, maxItems: 4 },
    connection: fields(['disconnects', 'reconnects', 'lastDisconnect', 'lastReconnect']),
  } : {}),
});
const metadataKeys = [...new Set([...matchFields, ...allyMetrics, ...series, 'buybacks', 'damage', 'healing', 'gold_delta', 'hero_id', 'position', 'time', 'time_dead', 'start', 'end', 'last_death', 'deadOverlap'])];
const briefSchema = obj({
  version: { const: 1 }, format: { const: 'match-brief-v1' }, matchId: { ...count, minimum: 1 }, side: { enum: ['radiant', 'dire'] },
  match: { ...fields(matchFields), properties: { ...(fields(matchFields).properties as Raw), radiant_win: fact(boolean), duration: fact({ type: 'number', exclusiveMinimum: 0 }) } },
  catalog: record(obj({ unit: { type: 'string', pattern: '^[a-zA-Z0-9_./%-]+$' }, meaning: token }), metadataKeys), limitations: list({ type: 'string', minLength: 1 }),
  quality: obj({ parseState: { enum: ['basic', 'parsed'] }, missingOpponentSlots: list(slot), issues: list(obj({ code: token, scope: token, count, slots: list(slot), indices: list(count) })) }),
  allies: { ...list(player(true)), minItems: 5, maxItems: 5 }, opponents: { ...list(player(false)), maxItems: 5 },
  fights: list(obj({ index: count, header: fields(['start', 'end', 'last_death', 'deaths']), participantDeaths: observation(), quality: list(token),
    metrics: fields(['deaths', 'buybacks', 'damage', 'healing', 'gold_delta'], group(slot.enum.map(String), false)),
    deadOverlap: record(obj({ seconds: observation(), lowerBound: boolean }), slot.enum.map(String)),
  })),
  objectives: list(obj({ index: count, fields: { ...fields(['time', 'type', 'key'], observation({ anyOf: [scalar, token] })), required: ['time'] }, actor: observation() })),
  buybacks: list(obj({ playerSlot: slot, time: observation() })), coverage: obj({ teamfights: coverage, objectives: coverage }),
  representations: obj(Object.fromEntries(['allies', 'opponents'].map(side => [side, fields(['direct', 'aggregate', 'local-only'], list({ enum: coverageFields }))]))),
});
const validate = new Ajv().compile(briefSchema);

export function briefReferences(context: Brief): Map<string, unknown> {
  const references = new Map<string, unknown>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (object(value)) {
      if (typeof value.id === 'string' && Object.hasOwn(value, 'value')) {
        ensure(!references.has(value.id) || canonical(references.get(value.id)) === canonical(value.value), 'integrity-error');
        references.set(value.id, value.value);
      } else Object.values(value).forEach(visit);
    }
  };
  visit(context);
  return references;
}

export function validateBrief(input: unknown): Brief {
  try {
    canonical(input);
    ensure(validate(input));
    const context = input as Brief;
    const expected = slot.enum.filter(value => (value < 128) === (context.side === 'radiant'));
    const all = [...context.allies, ...context.opponents];
    ensure(new Set(all.map(player => player.playerSlot)).size === all.length);
    ensure(context.allies.every(player => expected.includes(player.playerSlot)) && context.opponents.every(player => !expected.includes(player.playerSlot)));
    ensure(all.every(player => player.hero.value === player.heroId && ('id' in player.role.position ? player.role.source !== 'unknown' : player.role.source === 'unknown')));
    checkBriefSize(context);
    briefReferences(context);
    return context;
  } catch (error) {
    if (object(error) && error.code === 'context-too-large') throw new AnalysisError('context-too-large', error.details as Record<string, number>);
    throw new AnalysisError('invalid-input');
  }
}

export function validateAnalysisBundle(input: unknown): FactsBundle {
  try {
    ensure(object(input) && Object.keys(input).length === 4 && ['facts', 'context', 'evidence', 'manifest'].every(key => Object.hasOwn(input, key)));
    canonical(input);
    const bundle = input as unknown as FactsBundle;
    validateBrief(bundle.context);
    const { manifest, facts } = bundle;
    const manifestKeys = ['version', 'factsFormat', 'briefFormat', 'factsProfile', 'briefProfile', 'factsTransform', 'briefTransform', 'matchId', 'side', 'dataDigest', 'dictionaryRevision', 'dictionaryDigest', 'overridesDigest', 'factsDigest', 'contextDigest', 'evidenceDigest', 'bundleId'];
    ensure(object(manifest) && Object.keys(manifest).length === manifestKeys.length && manifestKeys.every(key => Object.hasOwn(manifest, key)));
    ensure(manifest.version === 1 && manifest.factsFormat === 'facts-v1' && manifest.briefFormat === 'match-brief-v1' && facts.version === 1 && facts.format === 'facts-v1');
    ensure(manifest.factsProfile === 'facts-profile-1' && manifest.briefProfile === 'brief-profile-1' && manifest.factsTransform === 'normalize-1' && manifest.briefTransform === 'summarize-1');
    ensure(['dataDigest', 'dictionaryDigest', 'overridesDigest', 'factsDigest', 'contextDigest', 'evidenceDigest', 'bundleId'].every(key => /^[a-f0-9]{64}$/.test(String((manifest as unknown as Raw)[key]))) && /^[a-f0-9]{40}$/.test(manifest.dictionaryRevision));
    ensure(manifest.matchId === bundle.context.matchId && facts.matchId === manifest.matchId && facts.side === manifest.side && bundle.context.side === manifest.side);
    const { bundleId, ...identity } = manifest;
    ensure(sha(identity) === bundleId && sha(bundle.context) === manifest.contextDigest && sha(facts) === manifest.factsDigest && sha(bundle.evidence) === manifest.evidenceDigest, 'integrity-error');
    ensure(Array.isArray(bundle.evidence));
    const seen = new Set<string>();
    for (const entry of bundle.evidence) {
      ensure(object(entry) && /^e[1-9][0-9]*$/.test(entry.id) && !seen.has(entry.id) && Array.isArray(entry.inputs) && entry.inputs.every(id => seen.has(id)), 'integrity-error');
      seen.add(entry.id);
    }
    validateFactReferences([...briefReferences(bundle.context).keys()], bundle);
    return bundle;
  } catch (error) {
    if (error instanceof AnalysisError) throw error;
    throw new AnalysisError('integrity-error');
  }
}
