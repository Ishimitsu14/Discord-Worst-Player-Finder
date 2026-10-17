import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadGroupSettings } from '../group-settings/index.js';
import { loadPromptPackage } from '../match-analysis/index.js';
import { OperationsError, type ServiceConfig, type ServiceInput, type ServiceSecrets } from './types.js';

export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function ensure(value: unknown, code: OperationsError['code'] = 'invalid-config'): asserts value { if (!value) throw new OperationsError(code); }
export const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
export const snowflake = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
export function keys(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  ensure(object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)));
}
export async function json(path: string, limit = 131072): Promise<unknown> {
  try { ensure((await stat(path)).size <= limit, 'read-error'); return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new OperationsError('read-error'); }
}
const pathValue = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f]/u.test(value) && !/^[a-z]+:\/\//i.test(value) && !value.startsWith('file:');
export function validateConfig(value: unknown, base: string): ServiceConfig {
  try {
    keys(value, ['version', 'applicationId', 'groupSettingsPath', 'dataDir'], ['automatic', 'pipeline', 'startupTimeoutMs', 'shutdownTimeoutMs']);
    ensure(value.version === 1 && snowflake(value.applicationId) && pathValue(value.groupSettingsPath) && pathValue(value.dataDir));
    const pipeline = value.pipeline === undefined ? {} : value.pipeline;
    const ranges = { pollIntervalMs: [60000], pageSize: [1, 100], maxPagesPerAccount: [1, 10], maxCandidatesPerScan: [1, 1000], workerIdleMs: [1000], pauseMs: [60000],
      parseTimeoutMs: [1], parsePollMs: [15000], analysisTimeoutMs: [1, 2147483647], publicationTimeoutMs: [1, 2147483647] };
    keys(pipeline, [], [...Object.keys(ranges), 'mode', 'allowExperimental', 'maxTotalCostUsd', 'maxEstimatedCostPerAttemptUsd']);
    for (const [key, [min, max]] of Object.entries(ranges)) if (Object.hasOwn(pipeline, key)) ensure(integer(pipeline[key], min, max));
    ensure((pipeline.parsePollMs ?? 15000) as number <= ((pipeline.parseTimeoutMs ?? 900000) as number));
    ensure(pipeline.mode === undefined || ['prepare-only', 'live'].includes(pipeline.mode as string));
    ensure(pipeline.allowExperimental === undefined || typeof pipeline.allowExperimental === 'boolean');
    for (const key of ['maxTotalCostUsd', 'maxEstimatedCostPerAttemptUsd']) {
      if (pipeline.mode === 'live' || Object.hasOwn(pipeline, key)) ensure(typeof pipeline[key] === 'number' && Number.isFinite(pipeline[key]) && (pipeline[key] as number) > 0);
    }
    ensure(value.automatic === undefined || typeof value.automatic === 'boolean');
    const startupTimeoutMs = value.startupTimeoutMs === undefined ? 30000 : value.startupTimeoutMs, shutdownTimeoutMs = value.shutdownTimeoutMs === undefined ? 60000 : value.shutdownTimeoutMs;
    ensure(integer(startupTimeoutMs, 1, 60000) && integer(shutdownTimeoutMs, 1, 60000));
    return Object.freeze({ version: 1, applicationId: value.applicationId, groupSettingsPath: resolve(base, value.groupSettingsPath), dataDir: resolve(base, value.dataDir),
      automatic: value.automatic ?? false, pipeline: Object.freeze({ mode: 'prepare-only', allowExperimental: false, ...pipeline }), startupTimeoutMs, shutdownTimeoutMs } as ServiceConfig);
  } catch { throw new OperationsError('invalid-config'); }
}
export async function loadService(path: string, secrets: ServiceSecrets = {}, releaseRoot = process.cwd()): Promise<ServiceInput> {
  try {
    const config = validateConfig(await json(path), dirname(resolve(path)));
    keys(secrets, [], ['discordToken', 'openRouterKey', 'openDotaKey']);
    for (const value of Object.values(secrets)) ensure(value === undefined || typeof value === 'string' && value.trim().length > 0, 'missing-secret');
    ensure(config.pipeline.mode !== 'live' || secrets.openRouterKey, 'missing-secret');
    const settings = await loadGroupSettings(config.groupSettingsPath), prompt = await loadPromptPackage(resolve(releaseRoot, 'analysis/prompts/v1'));
    ensure(config.pipeline.mode !== 'live' || prompt.profile.calibration !== 'experimental' || config.pipeline.allowExperimental);
    const dictionary = await json(resolve(releaseRoot, 'evaluation/dictionaries/dotaconstants-v1.json'), 4 * 1024 * 1024);
    ensure(object(dictionary));
    return { config, settings, prompt, dictionary, releaseRoot: resolve(releaseRoot), secrets: { ...secrets } };
  } catch (error) { if (error instanceof OperationsError) throw error; throw new OperationsError('invalid-config'); }
}
