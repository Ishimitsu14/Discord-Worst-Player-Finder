import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { analyzeGeminiMatch, checkGeminiRecovery, loadGeminiPromptPackage, prepareGeminiAnalysis, presentGeminiAnalysis, renderGeminiAnalysis } from '../match-analysis/index.js';
import type { GeminiAttempt, GeminiDependencies, GeminiIdentity, GeminiRecovery, GeminiRecoveryDependencies } from '../match-analysis/index.js';
import { geminiIdentity } from '../match-analysis/gemini-prepare.js';
import { validateCompactBundle } from '../match-facts/index.js';
import { prepareFacts } from './facts.js';
import { atomicWrite, check, digest, json, LabError, newDirectory, nonnegative, now, object, readJson, within } from './files.js';
import type { Side } from './types.js';

interface GeminiPlan { version: 1; format: 'gemini-experiment-v1'; id: string; createdAt: string; factsPath: string; identity: GeminiIdentity }
export async function prepareGeminiExperiment(options: { root: string; matchId: number; side: Side; rolesFile?: string }): Promise<{ path: string; plan: GeminiPlan; requestBytes: number }> {
  const preparedFacts = await prepareFacts({ ...options, briefFormat: 'gemini-compact-v1' });
  const prompt = await loadGeminiPromptPackage(resolve('analysis/prompts/gemini-v2'));
  const prepared = prepareGeminiAnalysis(preparedFacts.bundle, prompt), directory = await newDirectory(options.root, 'gemini-plans');
  for (const [name, bytes] of Object.entries(prompt.files)) await atomicWrite(join(directory.path, 'package', name), bytes);
  await atomicWrite(join(directory.path, 'request.json'), prepared.body);
  const plan: GeminiPlan = { version: 1, format: 'gemini-experiment-v1', id: directory.name, createdAt: now(), factsPath: relative(resolve(options.root), preparedFacts.path), identity: geminiIdentity(prepared) };
  await atomicWrite(join(directory.path, 'plan.json'), json(plan));
  return { path: directory.path, plan, requestBytes: prepared.requestBytes };
}

async function loadGeminiExperiment(root: string, path: string) {
  const planPath = within(root, relative(resolve(root), resolve(path))), raw = object(await readJson(join(planPath, 'plan.json')));
  check(raw.version === 1 && raw.format === 'gemini-experiment-v1' && typeof raw.id === 'string' && typeof raw.factsPath === 'string', 'Некорректный план Gemini.');
  const plan = raw as unknown as GeminiPlan, factsPath = within(root, plan.factsPath);
  const bundle = validateCompactBundle(Object.fromEntries(await Promise.all(['facts', 'context', 'evidence', 'manifest'].map(async name => [name, await readJson(join(factsPath, `${name}.json`))]))));
  const prompt = await loadGeminiPromptPackage(join(planPath, 'package')), prepared = prepareGeminiAnalysis(bundle, prompt);
  check(json(geminiIdentity(prepared)) === json(plan.identity), 'Идентичность плана Gemini нарушена.', 'digest-mismatch');
  check(digest(await readFile(join(planPath, 'request.json'))) === prepared.requestDigest, 'Тело запроса Gemini изменено.', 'digest-mismatch');
  return { plan, bundle, prepared };
}

async function previousGeminiCosts(root: string, reserveUnknownUsd: number | undefined): Promise<{ knownUsd: number; reservedUsd: number; unknown: number; retryAt: string | null }> {
  const directory = within(root, 'gemini-runs'), entries = await readdir(directory, { withFileTypes: true });
  let knownUsd = 0, reservedUsd = 0, unknown = 0, retryAt: string | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = within(directory, entry.name);
    let attempt: Record<string, unknown>;
    try { attempt = object(await readJson(join(path, 'attempt.json'))); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { const started = object(await readJson(join(path, 'started.json'))); check(started.status === 'started', 'Повреждён журнал started.'); unknown++; check(reserveUnknownUsd !== undefined && reserveUnknownUsd > 0, 'Есть незавершённый started Gemini: нужен явный резерв.', 'unknown-cost'); reservedUsd += reserveUnknownUsd; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      continue;
    }
    check(attempt.version === 1 && typeof attempt.requestSent === 'boolean' && typeof attempt.status === 'string', 'Повреждён журнал попыток Gemini.');
    if (typeof attempt.retryAt === 'string') {
      check(Number.isFinite(Date.parse(attempt.retryAt)), 'Повреждён Retry-After Gemini.');
      if (retryAt === null || Date.parse(attempt.retryAt) > Date.parse(retryAt)) retryAt = attempt.retryAt;
    }
    if (!attempt.requestSent) continue;
    const usage = object(attempt.usage);
    check(usage.costUsd === null || nonnegative(usage.costUsd), 'Повреждён расход Gemini.');
    let costUsd = usage.costUsd as number | null, automaticReserve = 0;
    if (costUsd === null) {
      let recovery: Record<string, unknown> | undefined;
      try { recovery = object(await readJson(join(path, 'recovery.json'))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (recovery) {
        check(recovery.version === 1 && recovery.attemptId === attempt.attemptId && recovery.requestDigest === object(attempt.identity).requestDigest
          && nonnegative(recovery.reserveUsd) && (recovery.costUsd === null || nonnegative(recovery.costUsd)), 'Повреждена сверка Gemini.', 'digest-mismatch');
        if (recovery.status === 'recorded') costUsd = recovery.costUsd as number | null;
        if (recovery.status === 'retry-allowed' || recovery.status === 'recorded' && costUsd === null) {
          check(nonnegative(attempt.estimatedCostUsd) && (recovery.reserveUsd as number) >= attempt.estimatedCostUsd && (recovery.reserveUsd as number) > 0, 'Повреждён автоматический резерв Gemini.');
          automaticReserve = recovery.reserveUsd as number;
        }
      }
    }
    if (costUsd === null) {
      unknown++; const reserve = Math.max(automaticReserve, reserveUnknownUsd ?? 0);
      check(reserve > 0, 'Есть неизвестный расход Gemini: нужен явный резерв на каждую попытку.', 'unknown-cost'); reservedUsd += reserve;
    } else knownUsd += costUsd;
  }
  check(Number.isFinite(knownUsd + reservedUsd), 'Некорректный общий расход Gemini.');
  return { knownUsd, reservedUsd, unknown, retryAt };
}

export async function runGeminiExperiment(options: { root: string; planPath: string; budgetUsd: number; timeoutMs?: number; reserveUnknownUsd?: number; signal?: AbortSignal }, dependencies: Pick<GeminiDependencies, 'apiKey' | 'fetcher'> & { managementKey?: string; recoveryWait?: GeminiRecoveryDependencies['wait'] }): Promise<{ path: string; attempt: GeminiAttempt; attempts: { path: string; attempt: GeminiAttempt }[]; recovery?: GeminiRecovery }> {
  check(nonnegative(options.budgetUsd) && options.budgetUsd > 0, 'Нужен положительный общий бюджет Gemini.');
  check(options.reserveUnknownUsd === undefined || nonnegative(options.reserveUnknownUsd), 'Некорректный резерв Gemini.');
  check(dependencies.managementKey === undefined || dependencies.managementKey !== dependencies.apiKey, 'Management key должен быть отдельным от inference key.');
  const { plan, bundle, prepared } = await loadGeminiExperiment(options.root, options.planPath);
  const lockPath = within(options.root, 'gemini-runs/active.lock'); await mkdir(join(resolve(options.root), 'gemini-runs'), { recursive: true });
  const lock = await open(lockPath, 'wx', 0o600).catch(error => { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LabError('busy', 'Другой запуск Gemini держит active.lock.'); throw error; });
  try {
    const previous = await previousGeminiCosts(options.root, options.reserveUnknownUsd);
    check(!previous.retryAt || Date.parse(previous.retryAt) <= Date.now(), 'Сохранённый Retry-After Gemini ещё действует.', 'cooldown');
    const remaining = options.budgetUsd - previous.knownUsd - previous.reservedUsd;
    check(remaining > 0, 'Общий бюджет Gemini исчерпан известным расходом и резервом.', 'budget-exceeded');
    const execute = async (available: number, retry?: { attemptId: string; reserveUsd: number }) => {
      const run = await newDirectory(options.root, 'gemini-runs');
      await atomicWrite(join(run.path, 'run.json'), json({ version: 1, runId: run.name, planId: plan.id, createdAt: now(), budgetUsd: options.budgetUsd, ...previous,
        reservedUsd: previous.reservedUsd + (retry?.reserveUsd ?? 0), unknown: previous.unknown + (retry ? 1 : 0), maxEstimatedCostUsd: available, maxRequests: 1, ...(retry ? { retryOf: retry.attemptId } : {}) }));
      const attempt = await analyzeGeminiMatch(prepared, bundle, { attemptId: run.name, maxEstimatedCostUsd: available, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }, {
        apiKey: dependencies.apiKey, fetcher: dependencies.fetcher, signal: options.signal, beforeSend: started => atomicWrite(join(run.path, 'started.json'), json(started)),
      });
      await atomicWrite(join(run.path, 'attempt.json'), json(attempt));
      if (attempt.status === 'valid') {
        await atomicWrite(join(run.path, 'presentation.json'), json(presentGeminiAnalysis(attempt.analysis, bundle)));
        if (attempt.analysis?.version === 2) await atomicWrite(join(run.path, 'presentation.md'), renderGeminiAnalysis(attempt.analysis, bundle));
      }
      return { path: run.path, attempt };
    };
    const first = await execute(remaining), attempts = [first];
    if (!dependencies.managementKey || first.attempt.status === 'valid') return { ...first, attempts };
    const recovery = await checkGeminiRecovery(prepared, first.attempt, { managementKey: dependencies.managementKey, fetcher: dependencies.fetcher, signal: options.signal, wait: dependencies.recoveryWait });
    await atomicWrite(join(first.path, 'recovery.json'), json(recovery));
    const available = remaining - recovery.reserveUsd;
    if (recovery.status !== 'retry-allowed' || available <= 0 || options.signal?.aborted) return { ...first, attempts, recovery };
    await atomicWrite(join(first.path, 'retry-intent.json'), json({ version: 1, retryOf: first.attempt.attemptId, requestDigest: prepared.requestDigest, availableUsd: available, reserveUsd: recovery.reserveUsd }));
    const second = await execute(available, { attemptId: first.attempt.attemptId!, reserveUsd: recovery.reserveUsd }); attempts.push(second);
    return { ...second, attempts, recovery };
  } finally { await lock.close(); await unlink(lockPath); }
}
