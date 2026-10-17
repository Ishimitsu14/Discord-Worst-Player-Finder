import { open, rename, unlink, mkdir, access, copyFile, readFile, stat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { openStorage } from '../storage/index.js';
import { OperationsError, type ServiceConfig, type ServiceState } from './types.js';
import { ensure, integer, json, keys } from './config.js';

export const dataPaths = (config: ServiceConfig) => ({ db: join(config.dataDir, 'app.sqlite'), state: join(config.dataDir, 'operations-state.json'), health: join(config.dataDir, 'status.json') });
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value) + '\n', 'utf8'); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    if (process.platform !== 'win32') { const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  } catch { throw new OperationsError('write-error'); }
  finally { await unlink(temp).catch(() => {}); }
}
export async function readState(config: ServiceConfig, now = Date.now()): Promise<ServiceState> {
  try {
    const paths = dataPaths(config); ensure((await stat(paths.db)).size >= 100, 'data-required'); const value = await json(paths.state, 4096);
    keys(value, ['version', 'installationId', 'automaticSince']);
    ensure(value.version === 1 && typeof value.installationId === 'string' && /^[a-f0-9-]{36}$/.test(value.installationId)
      && (value.automaticSince === null || integer(value.automaticSince, 0, now)), 'invalid-state');
    return value as unknown as ServiceState;
  } catch (error) { if (error instanceof OperationsError && error.code === 'invalid-state') throw error; throw new OperationsError('data-required'); }
}
export async function initService(config: ServiceConfig): Promise<ServiceState> {
  const paths = dataPaths(config);
  try {
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    for (const path of [paths.db, paths.state]) {
      try { await access(path); throw new OperationsError('data-exists'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const reservation = await open(paths.db, 'wx', 0o600); await reservation.close();
    const storage = openStorage({ path: paths.db }); storage.close();
    const state: ServiceState = { version: 1, installationId: randomUUID(), automaticSince: null }; await atomicJson(paths.state, state); return state;
  } catch (error) { if (error instanceof OperationsError) throw error; throw new OperationsError('write-error'); }
}
export async function activateService(config: ServiceConfig, now = Date.now(), write = atomicJson): Promise<ServiceState> {
  const state = await readState(config, now);
  if (config.automatic && state.automaticSince === null) { ensure(integer(now), 'invalid-state'); state.automaticSince = now; await write(dataPaths(config).state, state); }
  return state;
}
export async function backupService(config: ServiceConfig, output: string): Promise<void> {
  try {
    const paths = dataPaths(config), state = await readState(config);
    const source = openStorage({ path: paths.db }); source.close();
    await mkdir(output, { mode: 0o700 });
    const db = join(output, 'app.sqlite'), metadata = join(output, 'operations-state.json');
    await copyFile(paths.db, db); await copyFile(paths.state, metadata);
    const copy = openStorage({ path: db }); copy.close();
    const files: Record<string, string> = {};
    for (const path of [db, metadata]) { const file = await open(path, 'r+'); try { await file.sync(); } finally { await file.close(); } files[path === db ? 'app.sqlite' : 'operations-state.json'] = createHash('sha256').update(await readFile(path)).digest('hex'); }
    await atomicJson(join(output, 'manifest.json'), { version: 1, createdAt: Date.now(), installationId: state.installationId, files });
  } catch { throw new OperationsError('write-error'); }
}
