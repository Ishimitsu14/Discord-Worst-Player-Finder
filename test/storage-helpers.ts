import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareMatchFacts } from '../src/match-facts/index.js';
import { analyzeMatch, prepareAnalysis, type StartedAttempt, type AnalysisAttempt } from '../src/match-analysis/index.js';
import { openStorage, StorageError, type Storage, type Claim, type MatchSnapshot, type Side } from '../src/storage/index.js';
import { match, dictionary } from './helpers.js';
import { prompt, metadata, payload } from './match-analysis-helpers.js';

export const settings = { steamAccountIds: [123, 456], guildId: '18446744073709551615', channelId: '9007199254740993' };
export const jobInput = (matchId = 101, side: Side = 'radiant') => ({ matchId, side, origin: 'manual' as const, settings: structuredClone(settings) });
export function errorIs(code: StorageError['code']) { return (error: unknown) => { assert.ok(error instanceof StorageError); assert.equal(error.code, code); assert.equal(error.cause, undefined); return true; }; }
export async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'storage-')), path = join(root, 'app.sqlite'); let now = 1000;
  const stores: Storage[] = [];
  t.after(async () => { stores.forEach(store => store.close()); for (const name of await readdir(root)) await unlink(join(root, name)); await rmdir(root); });
  return { root, path, advance: (ms = 60001) => { now += ms; }, open: () => { const store = openStorage({ path, clock: { now: () => now } }); stores.push(store); return store; } };
}
export function inputs(matchId = 101, side: Side = 'radiant') {
  const data = { ...match(matchId), start_time: 0 } as unknown as MatchSnapshot['data'];
  const snapshot: MatchSnapshot = { data, parseState: 'parsed', retrievedAt: 1000 };
  const bundle = prepareMatchFacts({ matchId, side, data }, { dictionary }), prepared = prepareAnalysis(bundle, prompt);
  return { snapshot, bundle, prepared };
}
export function setup(store: Storage, matchId = 101, side: Side = 'radiant') {
  const job = store.enqueueInitial(jobInput(matchId, side)), claim = store.claimNext()!.claim;
  const saved = store.saveInputs(claim, inputs(matchId, side)); return { job, ...saved };
}
export function started(store: Storage, claim: Claim, attemptId = randomUUID()) {
  const job = store.getJob(claim.jobId), prepared = store.getJobArtifacts(job.id).prepared!;
  store.reserveAnalysis(claim, { attemptId, preparedRef: job.refs.prepared! });
  const { matchId, side, bundleId, contextDigest, packageId, packageDigest, calibration, responseFormat, requestDigest } = prepared;
  const rates = { input: 0.000001, output: 0.000002, request: 0, endpointNames: ['synthetic'] };
  const value: StartedAttempt = { matchId, side, bundleId, contextDigest, packageId, packageDigest, calibration, responseFormat, requestDigest,
    version: 1, attemptId, status: 'started', startedAt: '2026-10-17T00:00:00.000Z', rates,
    estimatedCostUsd: prepared.estimatedInputTokens * rates.input + prepared.prompt.profile.maxTokens * rates.output };
  store.startAnalysis(claim, attemptId, value); return value;
}
export function invalidAttempt(start: StartedAttempt, costUsd: number | null = 0.01): AnalysisAttempt {
  const { version, attemptId, status, startedAt, estimatedCostUsd, rates, ...identity } = start;
  return { version, attemptId, identity, status: 'invalid-output', startedAt, endedAt: '2026-10-17T00:00:01.000Z', elapsedMs: 1000,
    requestSent: true, generationId: 'gen-synthetic', model: 'xiaomi/mimo-v2.6-pro', provider: 'synthetic', finishReason: 'length', rates,
    estimatedCostUsd, usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200, reasoningTokens: 100, cachedTokens: 0, costUsd },
    billingState: costUsd === null ? 'unknown' : 'known', retryAt: null, error: { code: 'unfinished-or-filtered' }, analysis: null, content: null, responseDigest: null };
}
export async function analyze(store: Storage, claim: Claim, options: { beforeSend?: (value: StartedAttempt) => Promise<void>; onPost?: (body: string) => void; response?: unknown; attemptId?: string } = {}) {
  const { prepared, bundle } = store.getJobArtifacts(claim.jobId); const attemptId = options.attemptId ?? randomUUID();
  store.reserveAnalysis(claim, { attemptId, preparedRef: store.getJob(claim.jobId).refs.prepared! });
  const attempt = await analyzeMatch(prepared!, bundle!, { attemptId, maxEstimatedCostUsd: 1 }, {
    apiKey: 'synthetic-storage-key', beforeSend: options.beforeSend ?? (async value => store.startAnalysis(claim, attemptId, value)),
    fetcher: async (_url, init) => {
      if (init?.method !== 'POST') return Response.json(metadata());
      options.onPost?.(String(init.body)); return Response.json(options.response ?? payload(bundle!));
    },
  });
  return { attemptId, attempt };
}
