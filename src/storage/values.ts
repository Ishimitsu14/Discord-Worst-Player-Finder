import { createHash } from 'node:crypto';
import type { GroupSettings, Side } from './types.js';
import { StorageError } from './types.js';

export const limitBytes = 32 * 1024 * 1024;
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const money = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
export const snowflake = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
export const shortText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 1000;
export const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
export const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
export function ensure(value: unknown, code: StorageError['code'] = 'invalid-input'): asserts value { if (!value) throw new StorageError(code, 'validate'); }
export function keys(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  ensure(object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}
export function canonical(value: unknown, parents = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  ensure(Array.isArray(value) || object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  ensure(!parents.has(value)); parents.add(value);
  const result = Array.isArray(value) ? '[' + Array.from(value, child => canonical(child, parents)).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key], parents)).join(',') + '}';
  parents.delete(value); return result;
}
export const digest = (value: unknown): string => hash(canonical(value));
export function encode(value: unknown): string { canonical(value); const body = JSON.stringify(value); ensure(Buffer.byteLength(body, 'utf8') <= limitBytes, 'too-large'); return body; }
export function pair(matchId: unknown, side: unknown): asserts side is Side { ensure(integer(matchId) && matchId > 0 && (side === 'radiant' || side === 'dire')); }
export function settings(value: GroupSettings): void {
  keys(value, ['steamAccountIds', 'guildId', 'channelId']);
  ensure(Array.isArray(value.steamAccountIds) && value.steamAccountIds.length > 0 && new Set(value.steamAccountIds).size === value.steamAccountIds.length);
  ensure(value.steamAccountIds.every(item => integer(item) && item > 0 && item <= 4294967294) && snowflake(value.guildId) && snowflake(value.channelId));
}
export function translated(error: unknown, operation: string): StorageError {
  if (error instanceof StorageError) return new StorageError(error.code, operation);
  const code = object(error) && typeof error.errcode === 'number' ? error.errcode & 255 : 0;
  return new StorageError(code === 5 || code === 6 ? 'busy' : code === 19 ? 'conflict' : code === 11 || code === 26 ? 'integrity-error' : 'io-error', operation);
}
