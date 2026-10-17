import { createHash } from 'node:crypto';
import { countFields, signedFields, unit } from './profile.js';
import { FactsError, type ErrorCode, type Evidence, type Fact, type Fields, type Group, type Observation, type Raw, type State } from './types.js';

export function ensure(condition: unknown, code: ErrorCode = 'invalid-input', details?: Record<string, number>): asserts condition {
  if (!condition) throw new FactsError(code, details);
}
export const object = (value: unknown): value is Raw => value !== null && typeof value === 'object' && !Array.isArray(value);
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const positive = (value: unknown): value is number => integer(value) && value > 0;
export const state = (value: unknown): State => value === undefined ? 'missing' : value === null ? 'null' : 'invalid';
export const missing = <T = number>(value: unknown, reason?: string): Observation<T> => ({ unavailable: state(value) as Exclude<State, 'present'>, ...(reason ? { reason } : {}) });
export const known = <T>(value: Observation<T>): value is Fact<T> => 'id' in value;
export const number = (value: Observation<unknown> | undefined): number | undefined => value && known(value) && finite(value.value) ? value.value : undefined;
export const escapePointer = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');

export function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (finite(value)) return JSON.stringify(value);
  ensure(object(value) || Array.isArray(value));
  ensure(!ancestors.has(value) && (Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value))));
  ancestors.add(value);
  const result = Array.isArray(value) ? '[' + Array.from(value, item => canonical(item, ancestors)).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], ancestors)).join(',') + '}';
  ancestors.delete(value);
  return result;
}
export const sha = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

export class Registry {
  entries: Evidence[] = [];
  add<T>(value: T, metric: string, playerSlot: number | null, paths: string[], transform = 'identity-v1', inputs: string[] = [], source: Evidence['source'] = 'snapshot', parameters: Record<string, number> = {}): Fact<T> {
    const id = `e${this.entries.length + 1}`;
    this.entries.push({ id, value, playerSlot, metric, unit: transform === 'named-group-v1' && ['summary-group', 'economy-group', 'same-position-group'].includes(metric) ? 'catalog-per-member' : unit(metric), paths, inputs, transform, source, parameters });
    return { id, value };
  }
  derive(value: number, metric: string, slot: number | null, transform: string, observations: Observation<unknown>[], parameters: Record<string, number> = {}): Fact {
    ensure(Number.isFinite(value));
    return this.add(value, metric, slot, [], transform, observations.filter(known).map(value => value.id), 'derived', parameters);
  }
  group(values: Fields, metric: string, slot: number | null): Group {
    return this.add(Object.fromEntries(Object.entries(values).map(([field, observation]) => [field, known(observation) ? observation.value : observation])), metric, slot, [], 'named-group-v1', Object.values(values).filter(known).map(value => value.id), 'derived');
  }
  scalar(value: unknown, field: string, slot: number | null, path: string): Observation<number | boolean> {
    if (['radiant_win', 'is_roaming'].includes(field)) return typeof value === 'boolean' ? this.add(value, field, slot, [path]) : missing(value);
    const valid = finite(value) && (signedFields.has(field) || value >= 0) && (!countFields.has(field) || integer(value));
    return valid ? this.add(value, field, slot, [path]) : missing(value);
  }
}
