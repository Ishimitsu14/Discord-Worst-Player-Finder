import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collect } from '../src/evaluation-lab/corpus.js';
import { prepareGeminiExperiment, runGeminiExperiment } from '../src/evaluation-lab/gemini.js';
import { compactData, geminiAnswer, geminiAnswerV2, geminiMetadata, geminiPrompt, geminiStreamResponse } from './gemini-helpers.js';
import { prepareGeminiAnalysis } from '../src/match-analysis/index.js';
import { geminiIdentity } from '../src/match-analysis/gemini-prepare.js';
import { LabError } from '../src/evaluation-lab/files.js';
import type { CompactFactsBundle } from '../src/match-facts/index.js';

const key = 'synthetic-lab-gemini-key';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gemini-lab-')), input = join(root, 'source.json');
  await writeFile(input, JSON.stringify(compactData())); await collect({ root, matchId: 101, side: 'dire', fromFile: input });
  const prepared = await prepareGeminiExperiment({ root, matchId: 101, side: 'dire' });
  return { root, prepared, options: { root, planPath: prepared.path, budgetUsd: 1 } };
}
function fake(root: string, unknown = false) {
  let posts = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/endpoints')) return Response.json(geminiMetadata());
    const runs = await readdir(join(root, 'gemini-runs'));
    const starts = await Promise.all(runs.filter(name => name !== 'active.lock').map(name => readFile(join(root, 'gemini-runs', name, 'started.json')).catch(() => null)));
    assert.ok(starts.some(Boolean), 'started must exist before wire POST'); posts++;
    const request = JSON.parse(String(init?.body)), context = JSON.parse(request.messages[1].content) as CompactFactsBundle['context'];
    const answer = request.response_format.json_schema.name === 'gemini_match_analysis_v2' ? geminiAnswerV2({ context } as CompactFactsBundle) : geminiAnswer({ context } as CompactFactsBundle);
    return geminiStreamResponse('data: ' + JSON.stringify({ id: 'gen-lab', model: 'google/gemini-3.8-flash', choices: [{ delta: { content: JSON.stringify(answer) }, finish_reason: 'stop' }], usage: unknown ? {} : { cost: 0.001 } }) + '\n\ndata: [DONE]\n\n');
  };
  return { fetcher, get posts() { return posts; } };
}

test('Gemini lab: постоянные prepared/started/attempt и точная презентация, legacy-каталоги не меняются', async () => {
  const f = await fixture(), upstream = fake(f.root), result = await runGeminiExperiment(f.options, { apiKey: key, fetcher: upstream.fetcher });
  assert.equal(result.attempt.status, 'valid', JSON.stringify(result.attempt.error)); assert.equal(upstream.posts, 1);
  const files = await readdir(result.path); assert.deepEqual(files.sort(), ['attempt.json', 'presentation.json', 'presentation.md', 'run.json', 'started.json']);
  const presentation = JSON.parse(await readFile(join(result.path, 'presentation.json'), 'utf8')); assert.equal(presentation.playerSlot, 130); assert.equal(presentation.quote.text, 'Сейчас покажу как надо');
  assert.ok(!(await readdir(f.root)).includes('runs')); assert.ok(!(await readdir(join(f.root, 'gemini-runs'))).includes('active.lock'));
  assert.ok(!(await readFile(join(result.path, 'attempt.json'), 'utf8')).includes(key));
  assert.equal(result.attempt.identity!.responseFormat, 'gemini-match-analysis-v2'); assert.equal(presentation.teamFacts.length, 3);
  assert.match(await readFile(join(result.path, 'presentation.md'), 'utf8'), /Где накосячили, несмотря на победу/);
});

test('Gemini lab: сохранённый v1-план исполняет свой пакет после смены подготовки на v2', async () => {
  const f = await fixture(), plan = f.prepared.plan, path = join(f.root, plan.factsPath);
  const b = Object.fromEntries(await Promise.all(['facts', 'context', 'evidence', 'manifest'].map(async name => [name, JSON.parse(await readFile(join(path, `${name}.json`), 'utf8'))]))) as unknown as CompactFactsBundle;
  const prepared = prepareGeminiAnalysis(b, geminiPrompt);
  for (const [name, bytes] of Object.entries(geminiPrompt.files)) await writeFile(join(f.prepared.path, 'package', name), bytes);
  await writeFile(join(f.prepared.path, 'request.json'), prepared.body);
  await writeFile(join(f.prepared.path, 'plan.json'), JSON.stringify({ ...plan, identity: geminiIdentity(prepared) }));
  const upstream = fake(f.root), result = await runGeminiExperiment(f.options, { apiKey: key, fetcher: upstream.fetcher });
  assert.equal(result.attempt.status, 'valid', JSON.stringify(result.attempt.error)); assert.equal(upstream.posts, 1);
  assert.deepEqual(result.attempt.identity, geminiIdentity(prepared)); assert.equal(result.attempt.analysis!.version, 1);
  assert.deepEqual((await readdir(result.path)).sort(), ['attempt.json', 'presentation.json', 'run.json', 'started.json']);
  assert.equal(await readFile(join(f.prepared.path, 'request.json'), 'utf8'), prepared.body);
});

test('Gemini lab: накопленный бюджет и неизвестная стоимость требуют явного резерва', async () => {
  const f = await fixture(), upstream = fake(f.root, true); await runGeminiExperiment(f.options, { apiKey: key, fetcher: upstream.fetcher });
  await assert.rejects(runGeminiExperiment(f.options, { apiKey: key, fetcher: upstream.fetcher }), (e: unknown) => e instanceof LabError && e.code === 'unknown-cost'); assert.equal(upstream.posts, 1);
  await assert.rejects(runGeminiExperiment({ ...f.options, reserveUnknownUsd: 1 }, { apiKey: key, fetcher: upstream.fetcher }), (e: unknown) => e instanceof LabError && e.code === 'budget-exceeded');
  const result = await runGeminiExperiment({ ...f.options, reserveUnknownUsd: 0.01 }, { apiKey: key, fetcher: upstream.fetcher }); assert.equal(result.attempt.status, 'valid'); assert.equal(upstream.posts, 2);
});

test('Gemini lab: известный расход вычитается, незавершённый started резервируется', async () => {
  const f = await fixture(), upstream = fake(f.root); await runGeminiExperiment(f.options, { apiKey: key, fetcher: upstream.fetcher });
  await assert.rejects(runGeminiExperiment({ ...f.options, budgetUsd: 0.0005 }, { apiKey: key, fetcher: upstream.fetcher }), (e: unknown) => e instanceof LabError && e.code === 'budget-exceeded'); assert.equal(upstream.posts, 1);
  const orphan = join(f.root, 'gemini-runs', 'orphan'); await mkdir(orphan); await writeFile(join(orphan, 'started.json'), '{"status":"started"}');
  await assert.rejects(runGeminiExperiment(f.options, { apiKey: key, fetcher: upstream.fetcher }), (e: unknown) => e instanceof LabError && e.code === 'unknown-cost'); assert.equal(upstream.posts, 1);
});

test('Gemini lab: правка тела/пакета и конкурирующий запуск отклоняются до POST', async () => {
  const f = await fixture(), upstream = fake(f.root); await writeFile(join(f.prepared.path, 'request.json'), '{}');
  await assert.rejects(runGeminiExperiment(f.options, { apiKey: key, fetcher: upstream.fetcher }), (e: unknown) => e instanceof LabError && e.code === 'digest-mismatch'); assert.equal(upstream.posts, 0);
  const fresh = await fixture(); await mkdir(join(fresh.root, 'gemini-runs')); await writeFile(join(fresh.root, 'gemini-runs', 'active.lock'), '');
  await assert.rejects(runGeminiExperiment(fresh.options, { apiKey: key, fetcher: upstream.fetcher }), (e: unknown) => e instanceof LabError && e.code === 'busy');
});

test('Gemini CLI: prepare без ключа/сети, отсутствующий ключ у run не вызывает API', async () => {
  const f = await fixture(), invoke = (args: string[]) => spawnSync(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw new Error("network forbidden")}', 'dist/src/evaluation-lab/cli.js', ...args], { encoding: 'utf8', env: { ...process.env, OPENROUTER_API_KEY: '' } });
  const prepared = invoke(['gemini-prepare', '--root', f.root, '--match-id', '101', '--side', 'dire']); assert.equal(prepared.status, 0, prepared.stderr); assert.match(prepared.stdout, /Сеть и ИИ не использовались/);
  const run = invoke(['gemini-run', '--root', f.root, '--plan', f.prepared.path, '--budget-usd', '1']); assert.equal(run.status, 1); assert.match(run.stderr, /missing-key/);
});

const managementKey = 'synthetic-management-lab-key';
function recoveryFake(root: string, mode: 'absent' | 'recorded' | 'denied' | 'second-fails' | 'http-headers' = 'absent') {
  let posts = 0, queries = 0, firstTag = ''; const bodies: string[] = [], tags: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const address = String(url), authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (address.endsWith('/endpoints')) return Response.json(geminiMetadata());
    if (address.includes('/analytics/query')) {
      assert.equal(authorization, `Bearer ${managementKey}`); await readFile(join(root, 'gemini-runs', 'active.lock'));
      const query = JSON.parse(String(init?.body)); assert.equal(query.filters[0].value, firstTag); queries++;
      if (mode === 'denied') return new Response('', { status: 403 });
      const rows = mode === 'recorded' && queries === 2 ? [{ generation_id: 'gen-lab-recorded', session_id: firstTag, request_count: '1', total_usage: 0.003 }] : [];
      return Response.json({ data: { data: rows, metadata: { row_count: rows.length, truncated: false } } });
    }
    if (address.includes('/generation?id=')) {
      assert.equal(authorization, `Bearer ${managementKey}`); return Response.json({ data: { id: 'gen-lab-recorded', total_cost: 0.00300025 } });
    }
    assert.equal(address, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(authorization, `Bearer ${key}`);
    const tag = (init?.headers as Record<string, string>)['x-session-id']; tags.push(tag); bodies.push(String(init?.body)); posts++;
    const started = JSON.parse(await readFile(join(root, 'gemini-runs', tag, 'started.json'), 'utf8')); assert.equal(started.attemptId, tag);
    if (posts === 1) firstTag = tag;
    else {
      const decision = JSON.parse(await readFile(join(root, 'gemini-runs', firstTag, 'recovery.json'), 'utf8'));
      const intent = JSON.parse(await readFile(join(root, 'gemini-runs', firstTag, 'retry-intent.json'), 'utf8'));
      assert.equal(decision.status, 'retry-allowed'); assert.equal(intent.retryOf, firstTag); assert.notEqual(tag, firstTag); assert.ok(intent.reserveUsd > 0);
    }
    if (mode === 'http-headers') return new Response('{}', { status: 502, headers: { 'content-type': 'application/json' } });
    if (posts === 1 || mode === 'second-fails') throw new Error('synthetic connection lost');
    const context = JSON.parse(JSON.parse(String(init?.body)).messages[1].content) as CompactFactsBundle['context'];
    const answer = geminiAnswerV2({ context } as CompactFactsBundle);
    return geminiStreamResponse('data: ' + JSON.stringify({ id: 'gen-lab-retry', model: 'google/gemini-3.8-flash', choices: [{ delta: { content: JSON.stringify(answer) }, finish_reason: 'stop' }], usage: { cost: 0.001 } }) + '\n\ndata: [DONE]\n\n');
  };
  return { fetcher, bodies, tags, get posts() { return posts; }, get queries() { return queries; } };
}

test('Gemini lab recovery: два POST с разными метками, постоянное решение/резерв до повтора и учёт будущего бюджета', async () => {
  const f = await fixture(), upstream = recoveryFake(f.root), waits: number[] = [];
  const deps = { apiKey: key, managementKey, fetcher: upstream.fetcher, recoveryWait: async (ms: number) => { waits.push(ms); } };
  const result = await runGeminiExperiment(f.options, deps);
  assert.equal(result.attempt.status, 'valid'); assert.equal(upstream.posts, 2); assert.equal(upstream.queries, 3); assert.equal(result.attempts.length, 2);
  assert.deepEqual(waits, [10000, 20000, 30000]); assert.equal(upstream.bodies[0], upstream.bodies[1]); assert.notEqual(upstream.tags[0], upstream.tags[1]);
  const first = JSON.parse(await readFile(join(result.attempts[0].path, 'attempt.json'), 'utf8'));
  assert.equal(first.status, 'transport-error'); assert.equal(first.usage.costUsd, null); assert.equal(first.analysis, null);
  const secondRun = JSON.parse(await readFile(join(result.path, 'run.json'), 'utf8'));
  assert.equal(secondRun.retryOf, first.attemptId); assert.equal(secondRun.reservedUsd, result.recovery!.reserveUsd); assert.equal(secondRun.unknown, 1);
  assert.ok(!(await readFile(join(result.attempts[0].path, 'recovery.json'), 'utf8')).includes(managementKey));
  await assert.rejects(runGeminiExperiment({ ...f.options, budgetUsd: result.recovery!.reserveUsd + 0.0005 }, deps), (e: unknown) => e instanceof LabError && e.code === 'budget-exceeded');
  assert.equal(upstream.posts, 2);
  const corrupt = { ...result.recovery, attemptId: 'someone-else' }; await writeFile(join(result.attempts[0].path, 'recovery.json'), JSON.stringify(corrupt));
  await assert.rejects(runGeminiExperiment(f.options, deps), (e: unknown) => e instanceof LabError && e.code === 'digest-mismatch'); assert.equal(upstream.posts, 2);
});

test('Gemini lab recovery: поздняя запись запрещает повтор, management-стоимость учитывается без перезаписи attempt', async () => {
  const f = await fixture(), upstream = recoveryFake(f.root, 'recorded'), deps = { apiKey: key, managementKey, fetcher: upstream.fetcher, recoveryWait: async () => {} };
  const result = await runGeminiExperiment(f.options, deps);
  assert.equal(upstream.posts, 1); assert.equal(upstream.queries, 2); assert.equal(result.recovery!.status, 'recorded'); assert.equal(result.recovery!.costUsd, 0.00300025);
  assert.equal(result.attempt.status, 'transport-error'); assert.equal(result.attempt.usage.costUsd, null);
  await assert.rejects(runGeminiExperiment({ ...f.options, budgetUsd: 0.002 }, deps), (e: unknown) => e instanceof LabError && e.code === 'budget-exceeded'); assert.equal(upstream.posts, 1);
});

test('Gemini lab recovery: без ключа, при HTTP-ответе и 403 не бывает повтора', async () => {
  for (const mode of ['no-key', 'http-headers', 'denied'] as const) {
    const f = await fixture(), upstream = recoveryFake(f.root, mode === 'no-key' ? 'absent' : mode);
    const result = await runGeminiExperiment(f.options, { apiKey: key, ...(mode === 'no-key' ? {} : { managementKey }), fetcher: upstream.fetcher, recoveryWait: async () => {} });
    assert.equal(upstream.posts, 1); assert.equal(upstream.queries, mode === 'denied' ? 1 : 0);
    assert.equal(result.recovery?.status, mode === 'no-key' ? undefined : mode === 'denied' ? 'unavailable' : 'not-eligible');
  }
});

test('Gemini lab recovery: не хватает бюджета на две возможные оплаты — повторный POST запрещён', async () => {
  const f = await fixture(), upstream = recoveryFake(f.root);
  const estimate = Math.ceil(f.prepared.requestBytes / 2) * 0.000001 + 2048 * 0.000002;
  const result = await runGeminiExperiment({ ...f.options, budgetUsd: estimate * 1.5 }, { apiKey: key, managementKey, fetcher: upstream.fetcher, recoveryWait: async () => {} });
  assert.equal(result.recovery!.status, 'retry-allowed'); assert.equal(result.attempts.length, 2); assert.equal(upstream.posts, 1);
  assert.equal(result.attempt.requestSent, false); assert.equal(result.attempt.error!.code, 'estimated-cost-exceeded');
});

test('Gemini lab recovery: сбой второй попытки не запускает третью или новую сверку', async () => {
  const f = await fixture(), upstream = recoveryFake(f.root, 'second-fails');
  const result = await runGeminiExperiment(f.options, { apiKey: key, managementKey, fetcher: upstream.fetcher, recoveryWait: async () => {} });
  assert.equal(result.attempt.status, 'transport-error'); assert.equal(upstream.posts, 2); assert.equal(upstream.queries, 3); assert.equal(result.attempts.length, 2);
});

test('Gemini lab recovery: отмена и параллельный запуск во время сверки не создают новый POST', async () => {
  const f = await fixture(), upstream = recoveryFake(f.root), controller = new AbortController();
  const result = await runGeminiExperiment({ ...f.options, signal: controller.signal }, { apiKey: key, managementKey, fetcher: upstream.fetcher, recoveryWait: async () => {
    await assert.rejects(runGeminiExperiment(f.options, { apiKey: key, fetcher: upstream.fetcher }), (e: unknown) => e instanceof LabError && e.code === 'busy');
    controller.abort();
  } });
  assert.equal(result.recovery!.status, 'aborted'); assert.equal(upstream.posts, 1); assert.equal(upstream.queries, 0);
  assert.ok(!(await readdir(join(f.root, 'gemini-runs'))).includes('active.lock'));
});
