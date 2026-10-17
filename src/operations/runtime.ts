import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { OpenDotaClient, type Clock } from '../opendota/index.js';
import { openStorage, type Storage } from '../storage/index.js';
import { createMatchPipeline, type MatchPipeline, type Publisher } from '../match-pipeline/index.js';
import { createDiscordInterface, createDiscordPublisher, type DiscordInterface } from '../discord-interface/index.js';
import { ensure, integer, json, keys } from './config.js';
import { activateService, atomicJson, dataPaths, readState } from './state.js';
import { OperationsError, type Service, type ServiceDependencies, type ServiceEvent, type ServiceInput, type ServiceStatus } from './types.js';

const nativeClock: Clock = { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };
async function bounded<T>(work: Promise<T>, clock: Clock, ms: number, code: 'startup-timeout' | 'shutdown-timeout', signal?: AbortSignal): Promise<T> {
  let timer: unknown, abort: (() => void) | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = clock.setTimeout(() => reject(new OperationsError(code)), ms);
    abort = () => reject(new OperationsError('startup-failed')); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  try { return await Promise.race([work, limit]); }
  finally { clock.clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}
export async function readRevision(root: string): Promise<string> {
  try { const revision = (await readFile(resolve(root, 'REVISION'), 'utf8')).trim(); ensure(/^[a-f0-9]{40}$/.test(revision)); return revision; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'development'; throw new OperationsError('invalid-config'); }
}
export async function readStatus(input: Pick<ServiceInput, 'config'>, now = Date.now()): Promise<ServiceStatus> {
  try {
    const value = await json(dataPaths(input.config).health, 16384) as ServiceStatus;
    keys(value, ['version', 'revision', 'timestamp', 'pid', 'phase', 'discordReady', 'mode', 'automatic', 'knownCostUsd', 'unknownCount']);
    ensure(value.version === 1 && value.phase === 'ready' && value.discordReady === true && Number.isSafeInteger(value.timestamp)
      && value.timestamp <= now && now - value.timestamp <= 45000 && /^(?:[a-f0-9]{40}|development)$/.test(value.revision)
      && integer(value.pid, 1) && ['prepare-only', 'live'].includes(value.mode) && typeof value.automatic === 'boolean'
      && Number.isFinite(value.knownCostUsd) && value.knownCostUsd >= 0 && integer(value.unknownCount), 'not-ready');
    process.kill(value.pid, 0);
    return value;
  } catch { throw new OperationsError('not-ready'); }
}
export async function startService(input: ServiceInput, deps: ServiceDependencies = {}): Promise<Service> {
  const { config, secrets } = input, clock = deps.clock ?? nativeClock;
  ensure(typeof secrets.discordToken === 'string' && secrets.discordToken.trim(), 'missing-secret');
  await readState(config, clock.now());
  const revision = await readRevision(input.releaseRoot), paths = dataPaths(config), pending = new Set<Promise<unknown>>();
  const client = deps.client ?? new Client({ intents: [GatewayIntentBits.Guilds] });
  let storage: Storage | undefined, pipeline: MatchPipeline | undefined, discord: DiscordInterface | undefined;
  let stopped = false, fatal = false, timer: unknown, healthWork: Promise<void> = Promise.resolve(), stopping: Promise<void> | undefined;
  let finish!: () => void, fail!: (error: OperationsError) => void;
  const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }); void done.catch(() => {});
  const event = (value: ServiceEvent) => { try { void Promise.resolve(deps.onEvent?.(Object.freeze(value))).catch(() => {}); } catch {} };
  const health = async (phase: ServiceStatus['phase']) => {
    const billing = storage?.getBillingSummary() ?? { knownCostUsd: 0, unknownCount: 0 };
    await atomicJson(paths.health, { version: 1, revision, timestamp: clock.now(), pid: process.pid, phase, discordReady: client.isReady(), mode: config.pipeline.mode ?? 'prepare-only',
      automatic: config.automatic, knownCostUsd: billing.knownCostUsd, unknownCount: billing.unknownCount } satisfies ServiceStatus);
  };
  const shutdown = (): Promise<void> => {
    if (stopping) return stopping;
    stopped = true; if (timer !== undefined) clock.clearTimeout(timer);
    const work = (async () => {
      await healthWork.catch(() => {}); await health('stopping').catch(() => {});
      const results = await Promise.allSettled([discord?.stop(), pipeline?.stop(), client.destroy()]);
      await Promise.allSettled([...pending]);
      // Конвейер сохраняет исход в следующей цепочке microtask после завершения send.
      await new Promise<void>(resolve => setImmediate(resolve));
      if (results.some(result => result.status === 'rejected')) fatal = true;
      await health(fatal ? 'failed' : 'stopped').catch(() => { fatal = true; }); storage?.close();
      client.off(Events.Error, onError); deps.signal?.removeEventListener('abort', onAbort);
      event({ component: 'operations', code: fatal ? 'failed' : 'stopped' });
    })();
    stopping = bounded(work, clock, config.shutdownTimeoutMs, 'shutdown-timeout').then(() => {
      if (fatal) { const error = new OperationsError('runtime-failed'); fail(error); throw error; } finish();
    }, () => { const error = new OperationsError('shutdown-timeout'); fail(error); throw error; });
    void stopping.catch(() => {}); return stopping;
  };
  const onError = () => { fatal = true; event({ component: 'operations', code: 'runtime-failed' }); void shutdown().catch(() => {}); };
  const onAbort = () => { void shutdown().catch(() => {}); };
  client.on(Events.Error, onError);
  try {
    storage = openStorage({ path: paths.db, clock: { now: () => clock.now() } }); await health('starting');
    await bounded(client.login(secrets.discordToken), clock, config.startupTimeoutMs, 'startup-timeout', deps.signal);
    ensure(client.isReady() && !stopped && !deps.signal?.aborted, 'startup-failed');
    const state = await activateService(config, clock.now());
    const adapter = deps.publisher ?? createDiscordPublisher({ botToken: secrets.discordToken }, { makeRequest: deps.makeRequest });
    const publisher: Publisher = { prepare: input => adapter.prepare(input), send: (input, options) => {
      const work = Promise.resolve().then(() => adapter.send(input, options)); pending.add(work);
      void work.finally(() => pending.delete(work)).catch(() => {}); return work;
    } };
    const opendota = new OpenDotaClient({ apiKey: secrets.openDotaKey }, { fetcher: deps.fetcher, clock });
    pipeline = createMatchPipeline({ ...config.pipeline, ...(state.automaticSince === null ? {} : { automaticSince: state.automaticSince }) }, {
      settings: input.settings, storage, opendota, facts: { dictionary: input.dictionary }, prompt: input.prompt, apiKey: secrets.openRouterKey,
      fetcher: deps.fetcher, publisher, clock, onEvent: value => { if (value.code === 'storage-failure') onError(); event({ component: 'pipeline', code: value.code ?? value.type, ...(value.jobId ? { jobId: value.jobId } : {}) }); },
    });
    discord = createDiscordInterface({ settings: input.settings }, { client, pipeline, storage, clock, onEvent: value => {
      if (value.code === 'storage-failure') onError(); event({ component: 'discord', code: value.code, ...(value.jobId ? { jobId: value.jobId } : {}), ...(value.interactionId ? { interactionId: value.interactionId } : {}) });
    } });
    discord.attach(); deps.signal?.addEventListener('abort', onAbort, { once: true });
    const running = pipeline.run({ automatic: config.automatic });
    void running.then(() => { if (!stopped) onError(); }, onError);
    await health('ready');
    const beat = () => {
      if (stopped) return;
      healthWork = health('ready').then(() => { if (!stopped) timer = clock.setTimeout(beat, 15000); }, onError);
    };
    timer = clock.setTimeout(beat, 15000); event({ component: 'operations', code: 'ready' });
    return { stop: shutdown, done };
  } catch (error) {
    fatal = true; await shutdown().catch(() => {});
    if (error instanceof OperationsError) throw error; throw new OperationsError('startup-failed');
  }
}
