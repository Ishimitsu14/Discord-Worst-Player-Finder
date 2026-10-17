import fs from 'node:fs/promises';

export interface GroupSettings {
  readonly steamAccountIds: readonly number[];
  readonly guildId: string;
  readonly channelId: string;
}
type ErrorCode = 'read-error' | 'invalid-json' | 'invalid-settings';
interface Issue { readonly path: string; readonly message: string }
const messages: Record<ErrorCode, string> = {
  'read-error': 'Не удалось прочитать файл настроек компании.',
  'invalid-json': 'Файл настроек компании должен содержать корректный JSON.',
  'invalid-settings': 'Некорректные настройки компании.',
};
export class GroupSettingsError extends Error {
  readonly issues: readonly Issue[];
  constructor(public readonly code: ErrorCode, issues: readonly Issue[] = []) {
    super([messages[code], ...issues.map(issue => `${issue.path}: ${issue.message}`)].join(' '));
    this.name = 'GroupSettingsError';
    this.issues = Object.freeze(issues.map(issue => Object.freeze({ ...issue })));
  }
  toJSON(): { code: ErrorCode; message: string; issues: readonly Issue[] } {
    return { code: this.code, message: this.message, issues: this.issues };
  }
}
function invalid(path: string, message: string): never {
  throw new GroupSettingsError('invalid-settings', [{ path, message }]);
}
function validate(input: unknown): GroupSettings {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid('$', 'Ожидается объект настроек.');
  const data = input as Record<string, unknown>;
  const fields = ['steamAccountIds', 'guildId', 'channelId'];
  if (Object.keys(data).some(key => !fields.includes(key))) invalid('$', 'Неизвестные поля запрещены.');
  for (const field of fields) if (!Object.hasOwn(data, field)) invalid(field, 'Обязательное поле отсутствует.');
  if (!Array.isArray(data.steamAccountIds) || data.steamAccountIds.length === 0) invalid('steamAccountIds', 'Ожидается непустой массив Steam32 ID.');
  const ids: number[] = [], seen = new Set<number>();
  for (const [index, value] of data.steamAccountIds.entries()) {
    const path = `steamAccountIds[${index}]`;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 4294967294) invalid(path, 'Ожидается целое число от 1 до 4294967294.');
    if (seen.has(value)) invalid(path, 'Повторяющийся Steam32 ID.');
    seen.add(value); ids.push(value);
  }
  for (const field of ['guildId', 'channelId']) {
    const value = data[field];
    if (typeof value !== 'string' || value.trim() !== value || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n) {
      invalid(field, 'Ожидается десятичная строка от 1 до 18446744073709551615 без пробелов и ведущих нулей.');
    }
  }
  return Object.freeze({ steamAccountIds: Object.freeze(ids), guildId: data.guildId as string, channelId: data.channelId as string });
}
export async function loadGroupSettings(path: string): Promise<GroupSettings> {
  if (typeof path !== 'string' || path.trim().length === 0) invalid('$path', 'Ожидается непустой путь к файлу настроек.');
  let source: string;
  try { source = await fs.readFile(path, 'utf8'); }
  catch { throw new GroupSettingsError('read-error'); }
  let input: unknown;
  try { input = JSON.parse(source.startsWith('\uFEFF') ? source.slice(1) : source); }
  catch { throw new GroupSettingsError('invalid-json'); }
  return validate(input);
}
