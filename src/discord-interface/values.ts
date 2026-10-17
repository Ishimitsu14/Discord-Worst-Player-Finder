import type { GroupSettings } from '../group-settings/index.js';
import { DiscordInterfaceError, type ErrorCode } from './types.js';

export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
export const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
export const snowflake = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
export function ensure(value: unknown, code: ErrorCode = 'invalid-config', operation: DiscordInterfaceError['operation'] = 'configure'): asserts value { if (!value) throw new DiscordInterfaceError(code, operation); }
export function keys(value: unknown, required: string[], optional: string[] = [], code: ErrorCode = 'invalid-config', operation: DiscordInterfaceError['operation'] = 'configure'): asserts value is Record<string, unknown> {
  ensure(object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), code, operation);
}
export function copySettings(value: GroupSettings): GroupSettings {
  keys(value, ['steamAccountIds', 'guildId', 'channelId']);
  ensure(Array.isArray(value.steamAccountIds) && value.steamAccountIds.length > 0 && value.steamAccountIds.every(account => integer(account, 1, 4294967294))
    && new Set(value.steamAccountIds).size === value.steamAccountIds.length && snowflake(value.guildId) && snowflake(value.channelId));
  return Object.freeze({ steamAccountIds: Object.freeze([...value.steamAccountIds]), guildId: value.guildId, channelId: value.channelId });
}
export function matchId(value: unknown): number {
  ensure(typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) && integer(Number(value), 1), 'invalid-input', 'command'); return Number(value);
}
export const allowedMentions = Object.freeze({ parse: Object.freeze([]), users: Object.freeze([]), roles: Object.freeze([]), replied_user: false });
export const privateMentions = { parse: [] as never[], users: [] as string[], roles: [] as string[], repliedUser: false };
