import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, unlink, mkdir, copyFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { loadService, validateConfig, initService, backupService, startService, readStatus, OperationsError, type ServiceInput } from '../src/operations/index.js';
import { activateService, dataPaths, readState } from '../src/operations/state.js';
import { openStorage } from '../src/storage/index.js';
import { accepted, settings, data, live } from './discord-interface-helpers.js';
import { deferred, flush, TestClock } from './opendota-helpers.js';

async function fixture(t: TestContext, changes: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'operations-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'service.json'), raw = { version: 1, applicationId: '123456789012345678', groupSettingsPath: 'group.json', dataDir: 'data', startupTimeoutMs: 1000, shutdownTimeoutMs: 1000, ...changes };
  await writeFile(join(root, 'group.json'), JSON.stringify(settings)); await writeFile(path, JSON.stringify(raw));
  const input = await loadService(path, { discordToken: 'synthetic-discord-secret', openRouterKey: 'synthetic-openrouter-secret' });
  return { root, path, raw, input };
}
function fakeClient() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { hashSweepInterval: 0, handlerSweepInterval: 0 } });
  let ready = false, destroyed = 0; const destroy = client.destroy.bind(client);
  const hooks: { login?: () => Promise<string> } = {};
  Object.defineProperties(client, {
    login: { value: async () => { const result = await (hooks.login?.() ?? Promise.resolve('synthetic')); ready = true; return result; } },
    isReady: { value: () => ready }, destroy: { value: async () => { ready = false; destroyed++; await destroy(); } },
  });
  return { client, hooks, destroyed: () => destroyed };
}
const errorIs = (code: string) => (error: unknown) => error instanceof OperationsError && error.code === code && !JSON.stringify(error).includes('synthetic');

test('operations strict config keeps manual/prepare defaults and rejects malformed or secret fields', () => {
  const raw = { version: 1, applicationId: '18446744073709551615', groupSettingsPath: 'group.json', dataDir: 'data' };
  const config = validateConfig(raw, process.cwd()); assert.equal(config.automatic, false); assert.equal(config.pipeline.mode, 'prepare-only'); assert.ok(Object.isFrozen(config.pipeline));
  for (const changes of [{ applicationId: 123 }, { applicationId: '18446744073709551616' }, { token: 'synthetic-secret' }, { dataDir: 'https://example.invalid' },
    { automatic: 'true' }, { startupTimeoutMs: null }, { pipeline: null }, { pipeline: { automaticSince: 0 } }, { pipeline: { mode: 'live' } },
    { pipeline: { maxTotalCostUsd: 0 } }, { pipeline: { parsePollMs: 15000, parseTimeoutMs: 100 } }]) {
    assert.throws(() => validateConfig({ ...raw, ...changes }, process.cwd()), errorIs('invalid-config'));
  }
  assert.throws(() => validateConfig({ ...raw, get dataDir(): string { throw new Error('synthetic-secret'); } }, process.cwd()), errorIs('invalid-config'));
});

test('check/load reads public packages without DB/network; live requires explicit secret and experimental opt-in', async t => {
  const fx = await fixture(t); await assert.rejects(access(fx.input.config.dataDir));
  assert.equal(fx.input.settings.guildId, settings.guildId); assert.equal(fx.input.prompt.profile.calibration, 'experimental');
  await writeFile(fx.path, JSON.stringify({ ...fx.raw, pipeline: { ...live } }));
  await assert.rejects(loadService(fx.path), errorIs('missing-secret'));
  await writeFile(fx.path, JSON.stringify({ ...fx.raw, pipeline: { mode: 'live', maxTotalCostUsd: 1, maxEstimatedCostPerAttemptUsd: 0.1 } }));
  await assert.rejects(loadService(fx.path, { openRouterKey: 'synthetic' }), errorIs('invalid-config'));
  await assert.rejects(access(fx.input.config.dataDir));
});

test('explicit init never overwrites existing DB/state and ordinary start never creates missing/empty data', async t => {
  const fx = await fixture(t); await assert.rejects(startService(fx.input), errorIs('data-required'));
  const state = await initService(fx.input.config), paths = dataPaths(fx.input.config), before = await readFile(paths.db);
  await assert.rejects(initService(fx.input.config), errorIs('data-exists')); assert.deepEqual(await readFile(paths.db), before);
  assert.equal((await readState(fx.input.config)).installationId, state.installationId);
  await unlink(paths.db); await assert.rejects(startService(fx.input), errorIs('data-required')); await assert.rejects(access(paths.db));
  await writeFile(paths.db, ''); await assert.rejects(startService(fx.input), errorIs('data-required')); assert.equal((await readFile(paths.db)).length, 0);
});

test('activation persists across reopen/disable/enable; corrupt state or failed atomic write never resets cutoff', async t => {
  const fx = await fixture(t, { automatic: true }); await initService(fx.input.config);
  const first = await activateService(fx.input.config, 1000); assert.equal(first.automaticSince, 1000);
  assert.equal((await activateService({ ...fx.input.config, automatic: false }, 2000)).automaticSince, 1000);
  assert.equal((await activateService(fx.input.config, 3000)).automaticSince, 1000);
  const paths = dataPaths(fx.input.config), state = JSON.parse(await readFile(paths.state, 'utf8')); state.automaticSince = null;
  await writeFile(paths.state, JSON.stringify(state));
  await assert.rejects(activateService(fx.input.config, 4000, async () => { throw new OperationsError('write-error'); }), errorIs('write-error'));
  assert.equal((await readState(fx.input.config)).automaticSince, null);
  await unlink(paths.state); await mkdir(paths.state); await assert.rejects(activateService(fx.input.config), errorIs('data-required'));
  await rm(paths.state, { recursive: true }); await writeFile(paths.state, JSON.stringify({ ...state, version: 2 }));
  await assert.rejects(activateService(fx.input.config), errorIs('invalid-state')); assert.equal(JSON.parse(await readFile(paths.state, 'utf8')).version, 2);
});

test('cold backup reopens with identical activation and manifest; existing or failed output never becomes valid backup', async t => {
  const fx = await fixture(t); await initService(fx.input.config); const output = join(fx.root, 'backup');
  await backupService(fx.input.config, output); const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.installationId, (await readState(fx.input.config)).installationId); assert.match(manifest.files['app.sqlite'], /^[a-f0-9]{64}$/);
  const copy = openStorage({ path: join(output, 'app.sqlite') }); assert.equal(copy.getBillingSummary().knownCostUsd, 0); copy.close();
  await assert.rejects(backupService(fx.input.config, output), errorIs('write-error'));
  await writeFile(dataPaths(fx.input.config).db, 'invalid database'); const failed = join(fx.root, 'failed-backup');
  await assert.rejects(backupService(fx.input.config, failed), errorIs('write-error')); await assert.rejects(access(join(failed, 'manifest.json')));
});

test('interrupted backup leaves source and earlier backup intact and never writes a complete manifest', async t => {
  const fx = await fixture(t); await initService(fx.input.config);
  const previous = join(fx.root, 'previous'), output = join(fx.root, 'interrupted'); await backupService(fx.input.config, previous);
  const db = await readFile(dataPaths(fx.input.config).db), state = await readFile(dataPaths(fx.input.config).state), manifest = await readFile(join(previous, 'manifest.json'));
  const copy = filesystem.copyFile; let copies = 0;
  filesystem.copyFile = async (...args) => { if (++copies === 2) throw new Error('synthetic-copy-failure'); await copy(...args); };
  syncBuiltinESMExports();
  try { await assert.rejects(backupService(fx.input.config, output), errorIs('write-error')); }
  finally { filesystem.copyFile = copy; syncBuiltinESMExports(); }
  assert.equal(copies, 2); await assert.rejects(access(join(output, 'manifest.json')));
  assert.deepEqual(await readFile(dataPaths(fx.input.config).db), db); assert.deepEqual(await readFile(dataPaths(fx.input.config).state), state);
  assert.deepEqual(await readFile(join(previous, 'manifest.json')), manifest);
});

test('foreground service starts one listener after ready, exposes safe status and stops resources once', async t => {
  const fx = await fixture(t); await initService(fx.input.config); const fake = fakeClient(), events: unknown[] = [];
  const service = await startService(fx.input, { client: fake.client, fetcher: async () => { throw new Error('network forbidden'); }, onEvent: value => { events.push(value); throw new Error('synthetic observer'); } });
  assert.equal(fake.client.listenerCount(Events.InteractionCreate), 1); const status = await readStatus(fx.input);
  assert.equal(status.mode, 'prepare-only'); assert.equal(status.automatic, false); assert.equal(status.revision, 'development');
  assert.doesNotMatch(JSON.stringify(events), /synthetic|secret|personaname/);
  await Promise.all([service.stop(), service.stop()]); await service.done; assert.equal(fake.destroyed(), 1); assert.equal(fake.client.listenerCount(Events.InteractionCreate), 0);
  await assert.rejects(readStatus(fx.input), errorIs('not-ready'));
});

test('login failure/timeout release resources without starting worker or exposing SDK error', async t => {
  for (const timeout of [false, true]) {
    const fx = await fixture(t, { startupTimeoutMs: 20 }); await initService(fx.input.config); const fake = fakeClient();
    fake.hooks.login = timeout ? () => new Promise(() => {}) : async () => { throw new Error('synthetic-discord-secret'); };
    await assert.rejects(startService(fx.input, { client: fake.client, fetcher: async () => { throw new Error('worker started'); } }), errorIs(timeout ? 'startup-timeout' : 'startup-failed'));
    assert.equal(fake.destroyed(), 1); assert.equal(fake.client.listenerCount(Events.InteractionCreate), 0);
  }
});

test('status refuses stale, forged extra fields and dead process without network', async t => {
  const fx = await fixture(t); await initService(fx.input.config); const fake = fakeClient(), service = await startService(fx.input, { client: fake.client });
  const path = dataPaths(fx.input.config).health, valid = JSON.parse(await readFile(path, 'utf8'));
  await assert.rejects(readStatus(fx.input, valid.timestamp + 45001), errorIs('not-ready'));
  await writeFile(path, JSON.stringify({ ...valid, raw: 'synthetic-secret' })); await assert.rejects(readStatus(fx.input), errorIs('not-ready'));
  await writeFile(path, JSON.stringify({ ...valid, pid: 2147483647 })); await assert.rejects(readStatus(fx.input), errorIs('not-ready')); await service.stop();
});

test('fatal client error stops listener/worker with safe diagnostics and retains data', async t => {
  const fx = await fixture(t); await initService(fx.input.config); const fake = fakeClient(), events: unknown[] = [];
  const service = await startService(fx.input, { client: fake.client, onEvent: value => { events.push(value); } });
  fake.client.emit(Events.Error, new Error('synthetic-discord-secret'));
  await assert.rejects(service.done, errorIs('runtime-failed')); assert.equal(fake.destroyed(), 1); assert.equal(fake.client.listenerCount(Events.InteractionCreate), 0);
  assert.doesNotMatch(JSON.stringify(events), /synthetic|secret/); await readState(fx.input.config);
});

test('real SQLite contention is a fatal Storage error and stops the runtime without any network action', { timeout: 15000 }, async t => {
  const fx = await fixture(t, { pipeline: { workerIdleMs: 1000 } }); await initService(fx.input.config);
  const fake = fakeClient(), clock = new TestClock(), events: unknown[] = []; let calls = 0;
  const service = await startService(fx.input, { client: fake.client, clock, onEvent: event => { events.push(event); }, fetcher: async () => { calls++; throw new Error('network forbidden'); } });
  const blocker = new DatabaseSync(dataPaths(fx.input.config).db);
  try { blocker.exec('BEGIN EXCLUSIVE'); await clock.tick(1000); }
  finally { blocker.exec('ROLLBACK'); blocker.close(); }
  await assert.rejects(service.done, errorIs('runtime-failed'));
  assert.equal(calls, 0); assert.equal(fake.destroyed(), 1); assert.equal(fake.client.listenerCount(Events.InteractionCreate), 0);
  assert.match(JSON.stringify(events), /storage-failure/); await readState(fx.input.config);
});

for (const timedOut of [false, true]) test(`shutdown ${timedOut ? 'deadline' : 'grace'} keeps DB open for late publication ID without another POST`, { timeout: 15000 }, async t => {
  const fx = await fixture(t, { pipeline: { ...live } }); await initService(fx.input.config);
  const old = await accepted(t); await old.pipeline.stop(); old.storage.close(); await copyFile(old.path, dataPaths(fx.input.config).db);
  old.clock.time = old.job.nextRunAt + 600000;
  const gate = deferred<{ messageId: string }>(), closed = deferred<void>(), fake = fakeClient(); let posts = 0, modelPosts = 0;
  const service = await startService(fx.input, { client: fake.client, clock: old.clock,
    onEvent: value => { if (value.component === 'operations' && value.code === 'stopped') closed.resolve(); },
    fetcher: async (url, init) => { if (String(url).includes('/chat/completions') && init?.method === 'POST') modelPosts++; return Response.json(data()); }, publisher: { prepare: () => '{"synthetic":true}', send: () => { posts++; return gate.promise; } } });
  t.after(async () => { gate.resolve({ messageId: '123456789012345678' }); await service.stop().catch(() => {}); });
  await flush(); const inspect = openStorage({ path: dataPaths(fx.input.config).db }), current = inspect.getJob(old.job.id); inspect.close();
  assert.equal(posts, 1, JSON.stringify({ state: current.state, step: current.step, reason: current.reason, nextRunAt: current.nextRunAt, now: old.clock.now() })); const stopping = service.stop(); await flush();
  if (timedOut) { await old.clock.tick(fx.input.config.shutdownTimeoutMs + 1); await assert.rejects(stopping, errorIs('shutdown-timeout')); await assert.rejects(service.done, errorIs('shutdown-timeout')); }
  gate.resolve({ messageId: '123456789012345678' });
  if (!timedOut) { await stopping; await service.done; }
  await closed.promise;
  const storage = openStorage({ path: dataPaths(fx.input.config).db });
  const receipt = storage.listAttempts(old.job.id).find(row => row.kind === 'publication')!; storage.close();
  assert.deepEqual(receipt.outcome, { messageId: '123456789012345678' }); assert.equal(posts, 1); assert.equal(modelPosts, 0); assert.equal(old.posts('analysis').length, 1);
});

test('CLI documents help/check/init and safe exit codes without loading env implicitly', async t => {
  const fx = await fixture(t), cli = 'dist/src/operations/cli.js';
  const env = { ...process.env, DISCORD_BOT_TOKEN: '', OPENROUTER_API_KEY: '', OPENDOTA_API_KEY: '' };
  for (const args of [['--help'], ['check', '--config', fx.path], ['init', '--config', fx.path]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env }); assert.equal(result.status, 0, result.stderr);
  }
  for (const args of [['bad'], ['check', '--config', fx.path, '--unknown', 'secret'], ['start', '--config', fx.path]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env }); assert.equal(result.status, 78); assert.doesNotMatch(result.stderr, /synthetic|Error:|at main/);
  }
});

test('CLI registers only explicit guild commands through fake REST and reports partial failure safely', async t => {
  const fx = await fixture(t), trace = join(fx.root, 'rest.jsonl');
  const args = ['--import', './dist/test/operations-cli-fixture.js', 'dist/src/operations/cli.js', 'register-commands', '--config', fx.path];
  const env = { ...process.env, DISCORD_BOT_TOKEN: 'synthetic-discord-secret', WPF_TEST_TRACE: trace };
  const complete = spawnSync(process.execPath, args, { encoding: 'utf8', env }); assert.equal(complete.status, 0, complete.stderr);
  assert.equal(JSON.parse(complete.stdout).registered.length, 3);
  const requests = (await readFile(trace, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  assert.deepEqual(requests.map(row => row.name), ['worst', 'worst-status', 'worst-reanalyze']);
  assert.ok(requests.every(row => row.route === `/applications/${fx.input.config.applicationId}/guilds/${settings.guildId}/commands`));
  const partial = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...env, WPF_TEST_REST_FAIL: '2' } });
  assert.equal(partial.status, 1); assert.equal(JSON.parse(partial.stdout).registered.length, 1); assert.equal(JSON.parse(partial.stdout).status, 'partial');
  assert.doesNotMatch(partial.stdout + partial.stderr, /synthetic|secret/); await assert.rejects(access(fx.input.config.dataDir));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) test(`Linux CLI ${signal} twice stops cleanly without registering commands`, { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const fx = await fixture(t), trace = join(fx.root, 'unexpected-rest.jsonl'); await initService(fx.input.config);
  const child = spawn(process.execPath, ['--import', './dist/test/operations-cli-fixture.js', 'dist/src/operations/cli.js', 'start', '--config', fx.path], {
    env: { ...process.env, DISCORD_BOT_TOKEN: 'synthetic-discord-secret', WPF_TEST_TRACE: trace },
  });
  t.after(() => { child.kill('SIGKILL'); });
  let output = '', errors = ''; const ready = deferred<void>(), exited = once(child, 'exit');
  child.stdout.on('data', chunk => { output += chunk; if (output.includes('"code":"ready"')) ready.resolve(); }); child.stderr.on('data', chunk => { errors += chunk; });
  await Promise.race([ready.promise, exited.then(() => { throw new Error('CLI exited before ready'); })]);
  child.kill(signal); child.kill(signal); const [code, reason] = await exited;
  assert.equal(code, 0, errors); assert.equal(reason, null); assert.doesNotMatch(output + errors, /synthetic|secret/);
  assert.equal(JSON.parse(await readFile(dataPaths(fx.input.config).health, 'utf8')).phase, 'stopped');
  await assert.rejects(access(trace)); const storage = openStorage({ path: dataPaths(fx.input.config).db }); storage.close();
});
