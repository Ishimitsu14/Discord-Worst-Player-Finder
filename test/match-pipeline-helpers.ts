import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createMatchPipeline, PipelineError, type PipelineDependencies, type PipelineOptions, type MatchPipeline, type MatchRequestResult, type Job, type Publisher } from '../src/match-pipeline/index.js';
import { prepareMatchFacts } from '../src/match-facts/index.js';
import type { Brief, FactsBundle } from '../src/match-analysis/index.js';
import { OpenDotaClient, type MatchData } from '../src/opendota/index.js';
import { openStorage, type Storage } from '../src/storage/index.js';
import { dictionary, match } from './helpers.js';
import { analysis, metadata, prompt } from './match-analysis-helpers.js';
import { TestClock, flush } from './opendota-helpers.js';

export { TestClock, flush, prompt, dictionary };
export const settings = { steamAccountIds: [100000, 100002], guildId: '18446744073709551615', channelId: '18446744073709551614' };
export const live = { mode: 'live', allowExperimental: true, maxTotalCostUsd: 10, maxEstimatedCostPerAttemptUsd: 1 } as const;
export function data(matchId = 101, parsed = true): MatchData { return { ...match(matchId), start_time: 1799998000, version: parsed ? 22 : null } as MatchData; }
export function response(body: RequestInit['body'], cost: number | null = 0.001, insufficient = false): Response {
  const context = JSON.parse(JSON.parse(String(body)).messages.at(-1).content) as Brief;
  const result = analysis({ context } as FactsBundle);
  if (insufficient) { result.status = 'insufficient-evidence'; result.selectedPlayers = []; result.closestAlternative = null; result.comparison = null; }
  return Response.json({ id: 'gen-synthetic', model: prompt.profile.model, provider: 'deepinfra',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, ...(cost === null ? {} : { cost }) } });
}
export async function drive<T>(promise: Promise<T>, clock: TestClock): Promise<T> {
  let done = false; void promise.finally(() => { done = true; }).catch(() => {});
  for (let index = 0; index < 1000 && !done; index++) { await flush(); if (!done) await clock.tick(1000); }
  assert.ok(done, 'operation did not settle with controlled clocks'); return promise;
}
export function queued(result: MatchRequestResult): Job { assert.ok(result.status === 'queued' || result.status === 'existing'); return result.job; }
export const pipelineError = (code: string) => (error: unknown) => { assert.ok(error instanceof PipelineError); assert.equal(error.code, code); return true; };
export function intercepted(storage: Storage, methods: Partial<Record<keyof Storage, (...args: never[]) => unknown>>): Storage {
  return new Proxy(storage, { get(target, key) { const value = methods[key as keyof Storage] ?? Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
}
export async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'match-pipeline-')), path = join(root, 'store.sqlite'), clock = new TestClock();
  let storage = openStorage({ path, clock: { now: clock.now } });
  const matches = new Map<number, MatchData>([[101, data()]]), calls: { url: string; method: string; body?: RequestInit['body'] }[] = [];
  const history = new Map<number, MatchData[]>(settings.steamAccountIds.map(account => [account, [data()]]));
  const pipelines: MatchPipeline[] = [];
  const hooks: {
    opendota?: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;
    analysis?: (url: string, init: RequestInit) => Response | Promise<Response> | undefined;
  } = {};
  const opendota = new OpenDotaClient({}, { clock, random: () => 0, fetcher: async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url: url.pathname + url.search, method: init.method ?? 'GET', body: init.body });
    const custom = hooks.opendota?.(url, init); if (custom !== undefined) return custom;
    if (url.pathname.includes('/players/')) {
      const account = Number(url.pathname.split('/')[3]), offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
      return Response.json((history.get(account) ?? []).slice(offset, offset + limit).map(row => ({ ...row, player_slot: 0, hero_id: 1 })));
    }
    if (url.pathname.includes('/matches/')) { const found = matches.get(Number(url.pathname.split('/').at(-1))); return Response.json(found ?? {}, { status: found ? 200 : 404 }); }
    if (url.pathname.includes('/request/')) return Response.json(init.method === 'POST' ? { job: { jobId: 12345 } } : null);
    throw new Error('unexpected fake route');
  } });
  const fetcher: typeof fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
    const custom = hooks.analysis?.(String(url), init); if (custom !== undefined) return custom;
    return String(url).endsWith('/endpoints') ? Response.json(metadata()) : response(init.body);
  };
  const publisher: Publisher = { prepare: input => JSON.stringify({ result: input.analysisProfile === 'gemini' ? input.analysis.analysis!.format : input.analysis.analysis!.status }), send: async () => ({ messageId: '18446744073709551613' }) };
  const fx = { root, path, clock, get storage() { return storage; }, matches, history, calls, hooks, opendota, fetcher, publisher,
    pipe(options: PipelineOptions = {}, overrides: Partial<PipelineDependencies> = {}) {
      const pipeline = createMatchPipeline(options, { settings, storage, opendota, facts: { dictionary }, prompt, apiKey: 'sk-synthetic-pipeline-secret', fetcher, clock, ...overrides });
      pipelines.push(pipeline); return pipeline;
    },
    reopen() { storage.close(); storage = openStorage({ path, clock: { now: clock.now } }); },
    async request(pipeline: MatchPipeline, matchId = 101, side: 'radiant' | 'dire' = 'radiant') { return queued(await drive(pipeline.requestMatch({ matchId, side }), clock)); },
    async process(pipeline: MatchPipeline) { const result = await drive(pipeline.processNext(), clock); assert.equal(result.status, 'processed'); return result.status === 'processed' ? result.job : assert.fail(); },
    readyBundle(matchId = 101) { return prepareMatchFacts({ matchId, side: 'radiant', data: matches.get(matchId)! }, { dictionary }); },
    posts(kind: 'parse' | 'analysis') { return calls.filter(call => call.method === 'POST' && (kind === 'parse' ? call.url.startsWith('/api/request/') : call.url.includes('/chat/completions'))); },
  };
  t.after(async () => { await Promise.all(pipelines.map(pipeline => pipeline.stop())); storage.close(); await rm(root, { recursive: true, force: true }); });
  return fx;
}
