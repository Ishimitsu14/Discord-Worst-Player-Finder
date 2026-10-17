import { Ajv } from 'ajv';
import { checkCompactSize, compactReferences, heroMetricsDictionaryDigest, keyItems, validateCompactReferences } from './compact.js';
import { canonicalSlots, dictionaryDigest } from './profile.js';
import { FactsError, type Raw } from './types.js';
import type { CompactFactsBundle } from './compact-types.js';
import { canonical, ensure, object, sha } from './values.js';

const obj = (properties: Raw, required = Object.keys(properties)): Raw => ({ type: 'object', properties, required, additionalProperties: false });
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const scalar = { type: 'number', minimum: 0 };
const string = { type: 'string' };
const unavailable = obj({ unavailable: { enum: ['missing', 'null', 'invalid'] }, reason: { type: 'string', pattern: '^[a-z0-9-]+$' } }, ['unavailable']);
const maybe = (schema: Raw = scalar): Raw => ({ anyOf: [schema, unavailable] });
const fact = (value: Raw): Raw => obj({ id: { type: 'string', pattern: '^e[1-9][0-9]*$' }, value });
const slot = { enum: canonicalSlots };
const common = { player_slot: slot, hero_id: { ...count, minimum: 1 }, hero_name: { anyOf: [{ type: 'null' }, string] }, position: maybe({ type: 'integer', minimum: 1, maximum: 5 }), position_source: { enum: ['position_est', 'manual', 'unknown'] }, networth: maybe() };
const core = obj({ ...common, player_name: { ...string, minLength: 1, maxLength: 64 }, name_source: { enum: ['present', 'missing', 'null', 'invalid'] }, name_truncated: { type: 'boolean' },
  ...Object.fromEntries(['lane_role', 'kills', 'deaths', 'assists', 'last_hits', 'denies', 'obs_placed', 'sen_placed', 'observer_kills', 'sentry_kills', 'camps_stacked'].map(key => [key, maybe(count)])),
  ...Object.fromEntries(['gold_per_min', 'xp_per_min', 'hero_damage', 'tower_damage', 'hero_healing', 'stuns'].map(key => [key, maybe()])),
  kill_participation_pct: maybe({ ...count, maximum: 100 }),
});
const sourceState = { enum: ['present', 'missing', 'null', 'invalid'] };
const list = (items: Raw): Raw => ({ type: 'array', items });
const itemTimings = obj(Object.fromEntries(keyItems.map(key => [key, maybe(obj({ first_purchase_sec: scalar, rounded_min: count }))])));
const benchmarks = obj(Object.fromEntries(['gold_per_min', 'hero_damage_per_min'].map(key => [key, maybe(obj({ raw: maybe(), pct: maybe({ ...scalar, maximum: 1 }) }))])));
const validate = new Ajv().compile(obj({
  version: { const: 1 }, format: { const: 'gemini-compact-v1' },
  match_info: fact(obj({ match_id: { ...count, minimum: 1 }, duration_sec: { type: 'number', exclusiveMinimum: 0 }, duration_min: count, side: { enum: ['radiant', 'dire'] }, won: { type: 'boolean' }, total_team_kills: maybe(count) })),
  players: { ...list(obj({ core: fact(core), key_item_timings: fact(itemTimings),
    benchmarks: fact(benchmarks),
    special_metrics: fact(obj(Object.fromEntries(['duel_damage', 'finger_stacks', 'flesh_heap', 'hook_accuracy'].map(key => [key, maybe(count)])), [])),
  })), minItems: 5, maxItems: 5 },
  opponents: { ...list(fact(obj(common))), maxItems: 5 },
  chat: { ...list(fact(obj({ source_index: count, player_slot: slot, time_sec: scalar, rounded_min: count, text: { ...string, minLength: 1, maxLength: 240 }, truncated: { type: 'boolean' } }))), maxItems: 20 },
  coverage: obj({ parse_state: { enum: ['basic', 'parsed'] }, missing_opponent_slots: list(slot),
    groups: { type: 'object', additionalProperties: obj({ source_state: sourceState, unavailable_fields: list(string) }) },
    chat: obj({ source_state: sourceState, source_count: count, eligible_count: count, sent_count: count, truncated_count: count, excluded: { type: 'object', additionalProperties: count } }),
  }),
}));

export function validateCompactBundle(input: unknown): CompactFactsBundle {
  try {
    canonical(input);
    ensure(object(input) && Object.keys(input).length === 4 && ['facts', 'context', 'evidence', 'manifest'].every(key => Object.hasOwn(input, key)), 'integrity-error');
    const bundle = input as unknown as CompactFactsBundle, { context, manifest, facts } = bundle;
    ensure(validate(context), 'integrity-error');
    const manifestKeys = ['version', 'format', 'profile', 'transform', 'matchId', 'side', 'sourceDataDigest', 'optionsDigest', 'dictionaryDigest', 'heroMetricsDictionaryDigest', 'factsDigest', 'contextDigest', 'evidenceDigest', 'bundleId'];
    ensure(object(manifest) && Object.keys(manifest).length === manifestKeys.length && manifestKeys.every(key => Object.hasOwn(manifest, key)), 'integrity-error');
    ensure(manifest.version === 1 && manifest.format === 'gemini-compact-manifest-v1' && manifest.profile === 'gemini-compact-v1' && manifest.transform === 'compact-1', 'integrity-error');
    ensure(manifest.dictionaryDigest === dictionaryDigest && manifest.heroMetricsDictionaryDigest === heroMetricsDictionaryDigest, 'integrity-error');
    ensure(manifestKeys.filter(key => key.endsWith('Digest') || key === 'bundleId').every(key => /^[a-f0-9]{64}$/.test(String((manifest as unknown as Raw)[key]))), 'integrity-error');
    const info = context.match_info.value, slots = context.players.map(player => player.core.value.player_slot), opponentSlots = context.opponents.map(player => player.value.player_slot);
    const expected = canonicalSlots.filter(slot => (slot < 128) === (info.side === 'radiant'));
    ensure(slots.length === new Set(slots).size && expected.every(slot => slots.includes(slot)) && opponentSlots.every(slot => !expected.includes(slot)) && new Set(opponentSlots).size === opponentSlots.length, 'integrity-error');
    ensure(facts.version === 1 && facts.format === 'gemini-facts-v1' && facts.matchId === info.match_id && manifest.matchId === info.match_id && facts.side === info.side && manifest.side === info.side, 'integrity-error');
    ensure(context.players.every(player => (typeof player.core.value.position === 'number') === (player.core.value.position_source !== 'unknown')), 'integrity-error');
    ensure(object(facts.extras) && Array.isArray(facts.extras.players) && Array.isArray(facts.extras.chat) && Array.isArray(facts.players), 'integrity-error');
    for (const row of context.chat) {
      const full = facts.extras.chat.find(entry => entry.source_index === row.value.source_index);
      ensure(full && full.player_slot === row.value.player_slot && full.time_sec === row.value.time_sec && Array.from(full.text).slice(0, 240).join('') === row.value.text && row.value.truncated === (full.text !== row.value.text), 'integrity-error');
    }
    ensure(context.chat.every(row => slots.includes(row.value.player_slot) && row.value.time_sec <= info.duration_sec && row.value.rounded_min === Math.round(row.value.time_sec / 60)), 'integrity-error');
    ensure(context.coverage.chat.sent_count === context.chat.length && info.duration_min === Math.round(info.duration_sec / 60), 'integrity-error');
    const { bundleId, ...identity } = manifest;
    ensure(sha(identity) === bundleId && sha(facts) === manifest.factsDigest && sha(context) === manifest.contextDigest && sha(bundle.evidence) === manifest.evidenceDigest, 'integrity-error');
    ensure(Array.isArray(bundle.evidence), 'integrity-error');
    const seen = new Set<string>();
    for (const entry of bundle.evidence) {
      ensure(object(entry) && /^e[1-9][0-9]*$/.test(entry.id) && !seen.has(entry.id) && Array.isArray(entry.inputs) && entry.inputs.every(id => seen.has(id)) && Array.isArray(entry.paths) && ['snapshot', 'override', 'derived'].includes(entry.source), 'integrity-error');
      seen.add(entry.id);
    }
    validateCompactReferences([...compactReferences(context).keys()], bundle);
    checkCompactSize(context);
    return bundle;
  } catch (error) {
    if (error instanceof FactsError && error.code === 'context-too-large') throw error;
    throw new FactsError('integrity-error');
  }
}
