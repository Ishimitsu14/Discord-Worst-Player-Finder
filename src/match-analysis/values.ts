import { createHash } from 'node:crypto';
import { AnalysisError, type ErrorCode, type Raw } from './types.js';

export function ensure(condition: unknown, code: ErrorCode = 'invalid-input', details?: Record<string, number>): asserts condition {
  if (!condition) throw new AnalysisError(code, details);
}
export const object = (value: unknown): value is Raw => value !== null && typeof value === 'object' && !Array.isArray(value);
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const positive = (value: unknown): value is number => integer(value) && value > 0;
export const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || finite(value)) return JSON.stringify(value);
  ensure(object(value) || Array.isArray(value));
  ensure(!ancestors.has(value) && (Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value))));
  ancestors.add(value);
  const result = Array.isArray(value) ? '[' + Array.from(value, child => canonical(child, ancestors)).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], ancestors)).join(',') + '}';
  ancestors.delete(value);
  return result;
}
export const sha = (value: unknown): string => digest(canonical(value));
export function parse(value: string, code: ErrorCode): unknown {
  try { return JSON.parse(value); } catch { throw new AnalysisError(code); }
}
