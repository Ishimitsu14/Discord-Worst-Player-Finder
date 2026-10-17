import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { analyzeGeminiMatch, prepareGeminiAnalysis, type GeminiAttempt, type GeminiRecovery } from '../src/match-analysis/index.js';
import { prepareCompactMatchFacts } from '../src/match-facts/index.js';
import { createDiscordPublisher } from '../src/discord-interface/index.js';
import type { Claim, Side, Storage } from '../src/storage/index.js';
import type { PipelineDependencies, PipelineOptions } from '../src/match-pipeline/index.js';
import { fixture, data, live, settings } from './match-pipeline-helpers.js';
import { compactData, compactOptions, geminiPrompt, geminiPromptV2, geminiAnswer, geminiAnswerV2, geminiEvents, geminiMetadata, geminiStreamResponse } from './gemini-helpers.js';

export { live, settings, geminiPrompt, geminiPromptV2, geminiAnswer, geminiAnswerV2, geminiEvents, geminiMetadata, geminiStreamResponse, compactOptions };
export function runtimeData() {
  const result = data(), extra = compactData();
  result.players = result.players.map((player, index) => ({ ...(extra.players as Record<string, unknown>[])[index], ...player, personaname: `Игрок ${index}` }));
  result.players[7].hero_id = 104; result.chat = extra.chat; return result;
}
export const emptyAnalytics = () => Response.json({ data: { data: [], metadata: { truncated: false, row_count: 0 } } });
export async function geminiFixture(t: TestContext) {
  const fx = await fixture(t); fx.matches.set(101, runtimeData()); let sends = 0;
  const publisher = createDiscordPublisher({ botToken: 'synthetic-discord-key' });
  const management: { time: number; body: Record<string, unknown>; key: string | null }[] = [];
  const controls: { inference?: (init: RequestInit) => Response | Promise<Response> | undefined;
    analytics?: (init: RequestInit) => Response | Promise<Response> | undefined; metadata?: () => Response } = {};
  fx.hooks.analysis = (url, init) => {
    if (url.endsWith('/analytics/query')) { management.push({ time: fx.clock.now(), body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('Authorization') }); return controls.analytics?.(init) ?? emptyAnalytics(); }
    if (url.includes('/generation?')) return Response.json({ data: { id: new URL(url).searchParams.get('id'), total_cost: 0.002 } });
    if (url.includes('/google/gemini-3.8-flash/endpoints')) return controls.metadata?.() ?? Response.json(geminiMetadata());
    if (!String(init.body).includes('google/gemini-3.8-flash')) return undefined;
    const attemptId = new Headers(init.headers).get('x-session-id'); assert.ok(attemptId);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer sk-synthetic-pipeline-secret');
    const body = JSON.parse(String(init.body)), context = JSON.parse(body.messages[1].content);
    const job = fx.storage.getLatestJob(context.match_info.value.match_id, context.match_info.value.side)!;
    assert.ok(fx.storage.listAttempts(job.id).find(item => item.id === attemptId)?.started, 'started must commit before inference');
    const { bundle, prepared } = fx.storage.getJobArtifacts(job.id, 'gemini'); assert.equal(init.body, prepared!.body);
    const custom = controls.inference?.(init); if (custom !== undefined) return custom;
    return geminiStreamResponse(geminiEvents(bundle!, { answer: prepared!.responseFormat === 'gemini-match-analysis-v2' ? geminiAnswerV2(bundle!) : geminiAnswer(bundle!) }));
  };
  return Object.assign(fx, { controls, management, sends: () => sends,
    geminiPipe(options: PipelineOptions = live, overrides: Partial<PipelineDependencies> = {}) {
      return fx.pipe({ ...options, analysisProfile: 'gemini' }, { geminiPrompt: geminiPromptV2, heroMetricsDictionary: compactOptions.heroMetricsDictionary,
        managementKey: 'synthetic-management-key', publisher: { prepare: input => publisher.prepare(input), send: async () => { sends++; return { messageId: '18446744073709551613' }; } }, ...overrides });
    } });
}
export function storeGemini(store: Storage, side: Side = 'dire', prompt = geminiPromptV2) {
  const snapshot = { data: runtimeData(), parseState: 'parsed' as const, retrievedAt: 1000 };
  const job = store.enqueueInitial({ matchId: 101, side, origin: 'manual', settings, analysisProfile: 'gemini' }), claim = store.claimNext()!.claim;
  const bundle = prepareCompactMatchFacts({ matchId: 101, side, data: snapshot.data }, compactOptions), prepared = prepareGeminiAnalysis(bundle, prompt);
  const saved = store.saveInputs(claim, { snapshot, bundle, prepared }); return { job, claim: saved.claim, bundle, prepared, snapshot };
}
export async function storedGeminiAttempt(store: Storage, claim: Claim, response?: () => Response | Promise<Response>, reservedId?: string): Promise<GeminiAttempt> {
  const { bundle, prepared } = store.getJobArtifacts(claim.jobId, 'gemini'), attemptId = reservedId ?? randomUUID();
  if (!reservedId) store.reserveAnalysis(claim, { attemptId, preparedRef: store.getJob(claim.jobId).refs.prepared! });
  return analyzeGeminiMatch(prepared!, bundle!, { attemptId, maxEstimatedCostUsd: 1 }, {
    apiKey: 'synthetic-inference-key', beforeSend: async start => { store.startAnalysis(claim, attemptId, start); },
    fetcher: async (_url, init) => init?.method !== 'POST' ? Response.json(geminiMetadata()) : response ? response()
      : geminiStreamResponse(geminiEvents(bundle!, { answer: prepared!.responseFormat === 'gemini-match-analysis-v2' ? geminiAnswerV2(bundle!) : geminiAnswer(bundle!) })),
  });
}
export function recovery(attempt: GeminiAttempt, status: 'retry-allowed' | 'recorded' = 'retry-allowed', costUsd: number | null = null): GeminiRecovery {
  return { version: 1, attemptId: attempt.attemptId, requestDigest: attempt.identity!.requestDigest, status, reason: null,
    checks: [10000, 30000, 60000].map((ms, index) => ({ checkedAt: new Date(Date.parse(attempt.endedAt) + ms).toISOString(),
      status: status === 'recorded' && index === 2 ? 'recorded' : 'absent', generationIds: status === 'recorded' && index === 2 ? ['gen-synthetic'] : [] })),
    costUsd, reserveUsd: costUsd === null ? attempt.estimatedCostUsd! : 0 };
}
export const brokenConnection = (): never => { throw Error('synthetic disconnected'); };
