import { PipelineError, type PipelineConfig, type PipelineDependencies, type PipelineOptions } from './types.js';

export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
export const snowflake = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
export const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
export function ensure(ok: unknown, code: 'invalid-input' | 'invalid-config' = 'invalid-input'): asserts ok { if (!ok) throw new PipelineError(code); }
export function fields(value: unknown, required: string[], optional: string[] = [], code: 'invalid-input' | 'invalid-config' = 'invalid-input'): asserts value is Record<string, unknown> {
  ensure(object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)), code);
}
export function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) { seen.add(value); Object.values(value).forEach(child => freeze(child, seen)); Object.freeze(value); } return value;
}
export function configure(options: PipelineOptions, deps: PipelineDependencies): { config: PipelineConfig; dependencies: PipelineDependencies } {
  const defaults = { mode: 'prepare-only' as const, pollIntervalMs: 900000, pageSize: 20, maxPagesPerAccount: 1, maxCandidatesPerScan: 100,
    workerIdleMs: 1000, pauseMs: 300000, parseTimeoutMs: 900000, parsePollMs: 15000, analysisTimeoutMs: 180000,
    publicationTimeoutMs: 30000, allowExperimental: false };
  fields(options, [], [...Object.keys(defaults), 'automaticSince', 'maxTotalCostUsd', 'maxEstimatedCostPerAttemptUsd'], 'invalid-config');
  ensure(object(deps), 'invalid-config');
  const config = { ...defaults, ...options } as PipelineConfig;
  if (deps.clock !== undefined) ensure(deps.clock && ['now', 'setTimeout', 'clearTimeout'].every(key => typeof (deps.clock as unknown as Record<string, unknown>)[key] === 'function'), 'invalid-config');
  const now = deps.clock?.now() ?? Date.now();
  ensure(integer(now) && ['prepare-only', 'live'].includes(config.mode) && typeof config.allowExperimental === 'boolean', 'invalid-config');
  for (const [key, min, max] of [
    ['pollIntervalMs', 60000, Number.MAX_SAFE_INTEGER], ['pageSize', 1, 100], ['maxPagesPerAccount', 1, 10], ['maxCandidatesPerScan', 1, 1000],
    ['workerIdleMs', 1000, Number.MAX_SAFE_INTEGER], ['pauseMs', 60000, Number.MAX_SAFE_INTEGER], ['parseTimeoutMs', 1, Number.MAX_SAFE_INTEGER],
    ['parsePollMs', 15000, config.parseTimeoutMs], ['analysisTimeoutMs', 1, 2147483647], ['publicationTimeoutMs', 1, 2147483647],
  ] as const) ensure(integer(config[key], min, max), 'invalid-config');
  if (Object.hasOwn(options, 'automaticSince')) ensure(integer(config.automaticSince, 0, now), 'invalid-config');
  for (const key of ['maxTotalCostUsd', 'maxEstimatedCostPerAttemptUsd'] as const) {
    if (config.mode === 'live' || Object.hasOwn(options, key)) ensure(typeof config[key] === 'number' && Number.isFinite(config[key]) && config[key]! > 0, 'invalid-config');
  }
  fields(deps.settings, ['steamAccountIds', 'guildId', 'channelId'], [], 'invalid-config');
  const settings = deps.settings;
  ensure(Array.isArray(settings.steamAccountIds) && settings.steamAccountIds.length > 0
    && settings.steamAccountIds.every(value => integer(value, 1, 4294967294)) && new Set(settings.steamAccountIds).size === settings.steamAccountIds.length
    && snowflake(settings.guildId) && snowflake(settings.channelId), 'invalid-config');
  fields(deps.facts, ['dictionary'], [], 'invalid-config');
  ensure(object(deps.facts.dictionary) && object(deps.prompt), 'invalid-config');
  for (const [port, methods] of [[deps.opendota, ['getPlayerMatches', 'getMatch', 'requestParse', 'getParseJob']],
    [deps.storage, ['recordMatch', 'enqueueInitial', 'createRevision', 'getJob', 'getLatestJob', 'claimNext', 'renewClaim', 'checkpoint', 'defer', 'finish', 'saveInputs', 'getJobArtifacts',
      'reserveAnalysis', 'startAnalysis', 'saveAnalysisOutcome', 'beginParse', 'saveParseOutcome', 'beginPublication', 'savePublicationOutcome', 'recoverInterrupted', 'listAttempts', 'getBillingSummary', 'getLatestResult']]] as const) {
    ensure(port && methods.every(method => typeof (port as unknown as Record<string, unknown>)[method] === 'function'), 'invalid-config');
  }
  if (deps.publisher !== undefined) ensure(deps.publisher && typeof deps.publisher.prepare === 'function' && typeof deps.publisher.send === 'function', 'invalid-config');
  if (deps.clock !== undefined) ensure(['now', 'setTimeout', 'clearTimeout'].every(key => typeof (deps.clock as unknown as Record<string, unknown>)[key] === 'function'), 'invalid-config');
  if (deps.onEvent !== undefined) ensure(typeof deps.onEvent === 'function', 'invalid-config');
  if (deps.fetcher !== undefined) ensure(typeof deps.fetcher === 'function', 'invalid-config');
  if (config.mode === 'live') ensure(typeof deps.apiKey === 'string' && deps.apiKey.trim().length > 0, 'invalid-config');
  try { return { config: Object.freeze(config), dependencies: { ...deps, settings: freeze(structuredClone(settings)), facts: freeze(structuredClone(deps.facts)), prompt: freeze(structuredClone(deps.prompt)) } }; }
  catch { throw new PipelineError('invalid-config'); }
}
