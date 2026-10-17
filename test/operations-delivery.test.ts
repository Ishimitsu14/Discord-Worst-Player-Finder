import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access, mkdir, writeFile, chmod, symlink, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

test('release allowlist contains runtime/revision only and checksum matches exact archive bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'operations-release-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sha = 'a'.repeat(40), output = join(root, 'artifact');
  const packaged = spawnSync(process.execPath, ['deploy/package.mjs', sha, output], { encoding: 'utf8', windowsHide: true });
  assert.equal(packaged.status, 0, packaged.stderr);
  const archive = join(output, 'release.tar.gz'), result = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr);
  const files = result.stdout.trim().split(/\r?\n/).map(name => name.replace(/^\.\//, ''));
  for (const name of ['dist/src/operations/cli.js', 'analysis/prompts/v1/profile.json', 'evaluation/dictionaries/dotaconstants-v1.json', 'REVISION', 'package-lock.json', 'deploy/receive.sh']) assert.ok(files.includes(name), name);
  assert.ok(files.every(name => !/(^|\/)(?:\.local|\.env[^/]*|node_modules|test|\.ssh)(\/|$)/.test(name)));
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex'); assert.equal((await readFile(join(output, 'release.tar.gz.sha256'), 'utf8')).trim(), `${hash}  release.tar.gz`);
  assert.equal(spawnSync('tar', ['-xOf', archive, './REVISION'], { encoding: 'utf8', windowsHide: true }).stdout.trim(), sha);
  assert.equal(spawnSync(process.execPath, ['deploy/package.mjs', sha, output], { windowsHide: true }).status, 1);
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
