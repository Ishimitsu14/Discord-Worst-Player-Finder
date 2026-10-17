import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { copyFile } from 'node:fs/promises';
import { fixture } from './helpers.js';

test('документированные CLI help, prepare и report работают в Node без сети/ключа', async () => {
  const f = await fixture();
  const cli = 'dist/src/evaluation-lab/cli.js';
  const env = { ...process.env, OPENROUTER_API_KEY: '' };
  for (const args of [['--help'], ['prepare', '--root', f.root, '--experiment', f.experimentFile], ['report', '--root', f.root, '--plan', f.path]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
  }
  const noKey = spawnSync(process.execPath, [cli, 'run', '--root', f.root, '--plan', f.path, '--budget-usd', '1'], { encoding: 'utf8', env });
  assert.equal(noKey.status, 1); assert.match(noKey.stderr, /missing-key/);
});

test('Git исключает локальные снимки, ключи, настройки Codex и сборку, оставляет пустой env example', async () => {
  const f = await fixture();
  assert.equal(spawnSync('git', ['init', '-q', f.root]).status, 0);
  await copyFile('.gitignore', join(f.root, '.gitignore'));
  const result = spawnSync('git', ['check-ignore', '--no-index', '.local/evaluation/corpus.json', '.env', '.env.local', '.agents/local.json', '.codex/state.json', 'dist/app.js', 'node_modules/pkg/index.js', '.env.example'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 7);
  assert.ok(!result.stdout.includes('.env.example'));
});
