import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadGroupSettings } from '../group-settings/index.js';
import { loadPromptPackage, loadGeminiPromptPackage, createPromptPackage, createGeminiPromptPackage } from '../match-analysis/index.js';
import { validateCompactDictionaries } from '../match-facts/index.js';
import { isDeepStrictEqual } from 'node:util';
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
      parseTimeoutMs: [1], parsePollMs: [15000], analysisTimeoutMs: [1, 2147483647], publicationTimeoutMs: [1, 2147483647],
      discoveryRetryMs: [60000], discoveryTimeoutMs: [60000], maxDiscoveryChecksPerScan: [1, 1000] };
    keys(pipeline, [], [...Object.keys(ranges), 'mode', 'analysisProfile', 'historySource', 'publicationMode', 'allowExperimental', 'maxTotalCostUsd', 'maxEstimatedCostPerAttemptUsd']);
    ensure(pipeline.publicationMode === undefined || ['automatic', 'on-command'].includes(pipeline.publicationMode as string));
    ensure(pipeline.analysisProfile === undefined || ['legacy', 'gemini'].includes(pipeline.analysisProfile as string));
    for (const [key, [min, max]] of Object.entries(ranges)) if (Object.hasOwn(pipeline, key)) ensure(integer(pipeline[key], min, max));
    ensure((pipeline.parsePollMs ?? 15000) as number <= ((pipeline.parseTimeoutMs ?? 900000) as number));
    ensure((pipeline.discoveryRetryMs ?? 60000) as number <= ((pipeline.discoveryTimeoutMs ?? 1800000) as number));
    ensure(pipeline.historySource === undefined || ['opendota', 'steam'].includes(pipeline.historySource as string));
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
    keys(secrets, [], ['discordToken', 'openRouterKey', 'openRouterManagementKey', 'openDotaKey', 'steamKey']);
    for (const value of Object.values(secrets)) ensure(value === undefined || typeof value === 'string' && value.trim().length > 0, 'missing-secret');
    ensure(config.pipeline.mode !== 'live' || secrets.openRouterKey, 'missing-secret');
    ensure(!config.automatic || config.pipeline.historySource !== 'steam' || secrets.steamKey, 'missing-secret');
    const settings = await loadGroupSettings(config.groupSettingsPath), prompt = await loadPromptPackage(resolve(releaseRoot, 'analysis/prompts/v1')),
      geminiPrompt = await loadGeminiPromptPackage(resolve(releaseRoot, 'analysis/prompts/gemini-v2'));
    const dictionary = await json(resolve(releaseRoot, 'evaluation/dictionaries/dotaconstants-v1.json'), 4 * 1024 * 1024);
    const heroMetricsDictionary = await json(resolve(releaseRoot, 'evaluation/dictionaries/hero-metrics-v1.json'), 4 * 1024 * 1024);
    const input = { config, settings, prompt, geminiPrompt, dictionary, heroMetricsDictionary, releaseRoot: resolve(releaseRoot), secrets: { ...secrets } };
    validateMaterials(input); return input;
  } catch (error) { if (error instanceof OperationsError) throw error; throw new OperationsError('invalid-config'); }
}
export function validateMaterials(input: ServiceInput): void {
  try {
    validateCompactDictionaries({ dictionary: input.dictionary, heroMetricsDictionary: input.heroMetricsDictionary });
    ensure(isDeepStrictEqual(createPromptPackage(input.prompt.files), input.prompt));
    ensure(isDeepStrictEqual(createGeminiPromptPackage(input.geminiPrompt.files), input.geminiPrompt));
    ensure(input.secrets.openRouterManagementKey === undefined || typeof input.secrets.openRouterManagementKey === 'string' && input.secrets.openRouterManagementKey.trim().length > 0);
    ensure(!input.secrets.openRouterManagementKey || input.secrets.openRouterManagementKey !== input.secrets.openRouterKey);
    const active = input.config.pipeline.analysisProfile === 'gemini' ? input.geminiPrompt : input.prompt;
    ensure(input.config.pipeline.mode !== 'live' || active.profile.calibration !== 'experimental' || input.config.pipeline.allowExperimental);
  } catch { throw new OperationsError('invalid-config'); }
}
