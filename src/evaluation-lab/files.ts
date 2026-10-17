import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, link } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import type { Raw } from './types.js';

export class LabError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function check(condition: unknown, message: string, code = 'invalid-input'): asserts condition {
  if (!condition) throw new LabError(code, message);
}

export function object(value: unknown): Raw {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'Ожидался JSON объект.');
  return value as Raw;
}

export function parse(bytes: Uint8Array | string): unknown {
  try { return JSON.parse(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8')); } catch { throw new LabError('invalid-json', 'Некорректный JSON.'); }
}

export const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
export const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const now = (): string => new Date().toISOString();
export const id = (): string => randomUUID();
export const readJson = async (path: string): Promise<unknown> => parse(await readFile(path));
export const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const positiveInt = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
export const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function version(value: unknown): Raw {
  const data = object(value);
  check(data.version === 1, 'Неизвестная версия формата.');
  return data;
}

export function within(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  check(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel), 'Путь выходит за каталог артефактов.');
  return target;
}

export function pointer(data: unknown, path: string): unknown {
  check(path === '' || path.startsWith('/'), 'Некорректный JSON pointer.');
  return path === '' ? data : path.slice(1).split('/').reduce<unknown>((value, key) => {
    check(value !== null && typeof value === 'object', 'Путь основания отсутствует в снимке.');
    const decoded = key.replace(/~1/g, '/').replace(/~0/g, '~');
    check(Object.hasOwn(value, decoded), 'Путь основания отсутствует в снимке.');
    return (value as Raw)[decoded];
  }, data);
}

export async function atomicWrite(path: string, bytes: string | Uint8Array, replace = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.' + id() + '.tmp';
  await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
  try {
    if (replace) await rename(temp, path);
    else { await link(temp, path); await unlink(temp); }
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export async function immutable(path: string, bytes: string | Uint8Array): Promise<void> {
  try { await atomicWrite(path, bytes); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    check(digest(await readFile(path)) === digest(bytes), 'Ревизия уже существует с другим содержимым.');
  }
}

export async function revision(root: string, kind: string, value: { revision: string }, bytes = json(value)): Promise<void> {
  check(/^[a-zA-Z0-9_-]{1,100}$/.test(value.revision), 'Некорректный идентификатор ревизии.');
  await immutable(within(root, `${kind}/${value.revision}.json`), bytes);
}

export async function newDirectory(root: string, kind: string): Promise<{ path: string; name: string }> {
  const name = id();
  const path = within(root, `${kind}/${name}`);
  await mkdir(dirname(path), { recursive: true });
  await mkdir(path);
  return { path, name };
}
