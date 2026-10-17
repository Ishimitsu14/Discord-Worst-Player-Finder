import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access, mkdir, writeFile, chmod, symlink, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

test('workflow: branch preparation builds a release while deployment requires trusted main and explicit enablement', async () => {
  const workflow = await readFile('.github/workflows/service.yml', 'utf8');
  const condition = (job: string): string => {
    const section = workflow.split(new RegExp(`^  ${job}:`, 'm'))[1]?.split(/^  [a-z]+:/m)[0];
    const expression = section?.match(/^    if: (.+)$/m)?.[1]; assert.ok(expression, job); return expression;
  };
  for (const [ref, event, enabled, release, deploy] of [
    ['refs/heads/feat/release', 'workflow_dispatch', 'true', true, false],
    ['refs/pull/1/merge', 'pull_request', 'true', false, false],
    ['refs/heads/main', 'pull_request', 'true', false, false],
    ['refs/heads/main', 'push', 'false', true, false],
    ['refs/heads/main', 'push', 'true', true, true],
    ['refs/heads/main', 'workflow_dispatch', 'true', true, true],
  ] as const) {
    const context = { github: { ref, event_name: event }, vars: { DEPLOY_ENABLED: enabled } };
    assert.equal(runInNewContext(condition('release'), context), release, `${ref}/${event}: release`);
    assert.equal(runInNewContext(condition('deploy'), context), deploy, `${ref}/${event}: deploy`);
  }
});

test('release allowlist contains runtime/revision only and checksum matches exact archive bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'operations-release-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sha = 'a'.repeat(40), output = join(root, 'artifact');
  const packaged = spawnSync(process.execPath, ['deploy/package.mjs', sha, output], { encoding: 'utf8', windowsHide: true });
  assert.equal(packaged.status, 0, packaged.stderr);
  const archive = join(output, 'release.tar.gz'), result = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr);
  const files = result.stdout.trim().split(/\r?\n/).map(name => name.replace(/^\.\//, ''));
  for (const name of ['dist/src/operations/cli.js', 'analysis/prompts/v1/profile.json', 'analysis/prompts/gemini-v2/profile.json', 'evaluation/dictionaries/dotaconstants-v1.json', 'evaluation/dictionaries/hero-metrics-v1.json', 'REVISION', 'package-lock.json', 'deploy/receive.sh']) assert.ok(files.includes(name), name);
  assert.ok(files.every(name => !/(^|\/)(?:\.local|\.env[^/]*|node_modules|test|\.ssh)(\/|$)/.test(name)));
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex'); assert.equal((await readFile(join(output, 'release.tar.gz.sha256'), 'utf8')).trim(), `${hash}  release.tar.gz`);
  assert.equal(spawnSync('tar', ['-xOf', archive, './REVISION'], { encoding: 'utf8', windowsHide: true }).stdout.trim(), sha);
  assert.equal(spawnSync(process.execPath, ['deploy/package.mjs', sha, output], { windowsHide: true }).status, 1);
});

test('Gemini production artifact: offline production install/check and missing/corrupt dictionary fail before DB or network', { timeout: 180000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'operations-offline-')); t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'artifact'), release = join(root, 'release'); await mkdir(release);
  assert.equal(spawnSync(process.execPath, ['deploy/package.mjs', 'a'.repeat(40), output], { encoding: 'utf8', windowsHide: true }).status, 0);
  const unpack = spawnSync('tar', ['-xzf', join(output, 'release.tar.gz'), '-C', release], { encoding: 'utf8', windowsHide: true }); assert.equal(unpack.status, 0, unpack.stderr);
  const install = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci --omit=dev --offline --ignore-scripts --no-audit --no-fund'], { cwd: release, encoding: 'utf8', windowsHide: true, timeout: 60000 })
    : spawnSync('npm', ['ci', '--omit=dev', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: release, encoding: 'utf8', timeout: 60000 });
  assert.equal(install.status, 0, install.stderr); await assert.rejects(access(join(release, 'node_modules/typescript')));
  await writeFile(join(release, 'guard.mjs'), 'globalThis.fetch=()=>{throw Error("unexpected network")};');
  await writeFile(join(release, 'group.json'), JSON.stringify({ steamAccountIds: [123], guildId: '123', channelId: '456' }));
  await writeFile(join(release, 'service.json'), JSON.stringify({ version: 1, applicationId: '123', groupSettingsPath: 'group.json', dataDir: 'data', pipeline: { analysisProfile: 'gemini' } }));
  const env = { ...process.env }; for (const key of ['DISCORD_BOT_TOKEN', 'OPENROUTER_API_KEY', 'OPENROUTER_MANAGEMENT_KEY', 'STEAM_API_KEY', 'OPENDOTA_API_KEY']) delete env[key];
  const check = () => spawnSync(process.execPath, ['--import', './guard.mjs', 'dist/src/operations/cli.js', 'check', '--config', 'service.json'], { cwd: release, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const valid = check(); assert.equal(valid.status, 0, `${valid.error?.message ?? ''} ${valid.signal ?? ''} ${valid.stderr}`); assert.match(valid.stdout, /configuration-valid/); await assert.rejects(access(join(release, 'data')));
  const dictionary = join(release, 'evaluation/dictionaries/hero-metrics-v1.json'), original = await readFile(dictionary);
  await writeFile(dictionary, '{}'); assert.equal(check().status, 78); await rm(dictionary); assert.equal(check().status, 78);
  await assert.rejects(access(join(release, 'data'))); await writeFile(dictionary, original); assert.equal(check().status, 0);
});

test('release refuses malformed revision before producing any artifact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'operations-release-invalid-')); t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'artifact');
  const result = spawnSync(process.execPath, ['deploy/package.mjs', 'main; injected-command', output], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1); assert.equal(result.stderr.trim(), 'release-package-failed'); await assert.rejects(access(output));
});

test('Linux flock prevents a second writer and releases the same lock after process exit', { skip: process.platform !== 'linux', timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'operations-lock-')); t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, 'service.lock'), marker = join(root, 'second-writer');
  const holder = spawn('flock', ['-n', '-E', '75', '-F', lock, process.execPath, '-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000);']);
  t.after(() => { holder.kill('SIGKILL'); });
  await once(holder.stdout, 'data');
  const args = ['-n', '-E', '75', '-F', lock, process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1],"started")', marker];
  assert.equal(spawnSync('flock', args).status, 75); await assert.rejects(access(marker));
  const stopped = once(holder, 'exit'); holder.kill('SIGTERM'); await stopped;
  assert.equal(spawnSync('flock', args).status, 0); assert.equal(await readFile(marker, 'utf8'), 'started');
});

for (const scenario of ['ready', 'failed-health', 'invalid-archive'] as const) test(`Linux receive ${scenario}: real tar, locked staging and code rollback preserve data`, { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'operations-deploy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'base'), bin = join(root, 'bin'), source = join(root, 'source'), previous = 'c'.repeat(40), revision = 'a'.repeat(40);
  for (const path of [bin, source, join(base, 'incoming'), join(base, 'releases', previous), join(base, 'runtime', 'bin'), join(base, 'runtime/lib/node_modules/npm/bin')]) await mkdir(path, { recursive: true });
  await symlink(process.execPath, join(base, 'runtime/bin/node')); await writeFile(join(base, 'runtime/lib/node_modules/npm/bin/npm-cli.js'), 'process.exit(0);');
  await symlink(`releases/${previous}`, join(base, 'current')); await writeFile(join(root, 'working-db'), 'persistent-data');
  const trace = join(root, 'control.log'), control = join(bin, 'control');
  await writeFile(control, '#!/bin/bash\nset -eu\nprintf "%s %s\\n" "$1" "$(readlink "$BASE/current")" >> "$TRACE"\nif [[ "$1" == activate ]]; then ln -s "releases/$2" "$BASE/.test-current"; mv -Tf "$BASE/.test-current" "$BASE/current"; fi\nif [[ "$1" == status && "$SCENARIO" != ready ]]; then exit 1; fi\n'); await chmod(control, 0o755);
  for (const [name, script] of [['sudo', '#!/bin/bash\n[[ "$1" == -n ]] && shift\nexec "$@"\n'], ['sleep', '#!/bin/bash\nexit 0\n'], ['seq', '#!/bin/bash\nprintf "1\\n2\\n"\n']]) {
    await writeFile(join(bin, name), script); await chmod(join(bin, name), 0o755);
  }
  await writeFile(join(source, 'REVISION'), revision + '\n');
  if (scenario === 'invalid-archive') { await mkdir(join(source, '.local')); await writeFile(join(source, '.local', 'secret'), 'synthetic'); }
  const archive = join(root, 'release.tar.gz'); assert.equal(spawnSync('tar', ['-czf', archive, '-C', source, '.']).status, 0);
  const bytes = await readFile(archive), digest = createHash('sha256').update(bytes).digest('hex');
  const receiver = join(root, 'receive.sh');
  await writeFile(receiver, (await readFile('deploy/receive.sh', 'utf8')).replace('base=/opt/discord-worst-player-finder', `base=${base}`).replaceAll('/usr/local/libexec/wpf-control', control));
  const result = spawnSync('bash', [receiver], { input: bytes, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BASE: base, TRACE: trace, SCENARIO: scenario, SSH_ORIGINAL_COMMAND: `deploy ${revision} ${digest}` } });
  assert.equal(result.status, scenario === 'ready' ? 0 : 1, result.stderr + result.stdout);
  assert.equal(await readlink(join(base, 'current')), `releases/${scenario === 'ready' ? revision : previous}`);
  assert.equal(await readFile(join(root, 'working-db'), 'utf8'), 'persistent-data');
  if (scenario === 'invalid-archive') { await assert.rejects(access(trace)); await assert.rejects(access(join(base, 'releases', revision))); }
  else {
    const calls = await readFile(trace, 'utf8'); assert.match(calls, new RegExp(`backup releases/${previous}`));
    assert.match(calls, new RegExp(`start releases/${revision}`));
    if (scenario === 'failed-health') assert.match(calls, new RegExp(`start releases/${previous}`));
  }
});
