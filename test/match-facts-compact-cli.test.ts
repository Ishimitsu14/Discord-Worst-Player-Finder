import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collect } from '../src/evaluation-lab/corpus.js';
import { prepareFacts, writeFactsArtifacts } from '../src/evaluation-lab/facts.js';
import { compactBundle, compactData } from './gemini-helpers.js';

test('compact CLI: явный профиль без сети, шесть артефактов, повтор и прежний default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compact-cli-')), source = join(root, 'input.json');
  await writeFile(source, JSON.stringify(compactData())); await collect({ root, matchId: 101, side: 'dire', fromFile: source });
  const corpus = await readFile(join(root, 'corpus.json'));
  const args = ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw new Error("network forbidden")}', 'dist/src/evaluation-lab/cli.js', 'facts', '--root', root, '--match-id', '101', '--side', 'dire', '--brief-format', 'gemini-compact-v1'];
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, OPENROUTER_API_KEY: '' } });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /gemini-compact-v1/); assert.match(result.stdout, /предел 16384/);
  }
  const paths = (await readdir(join(root, 'facts'))).map(name => join(root, 'facts', name));
  assert.equal((await readdir(paths[0])).length, 6);
  for (const file of ['facts.json', 'context.json', 'evidence.json', 'manifest.json', 'summary.md']) assert.deepEqual(await readFile(join(paths[0], file)), await readFile(join(paths[1], file)));
  assert.deepEqual(await readFile(join(root, 'corpus.json')), corpus);
  const legacy = await prepareFacts({ root, matchId: 101, side: 'dire' }); assert.equal(legacy.bundle.context.format, 'match-brief-v1');
});

test('compact writer: переполнение до записи, manifest последним и отсутствие перезаписи', async () => {
  const b = compactBundle(), root = await mkdtemp(join(tmpdir(), 'compact-write-')), order: string[] = [];
  await writeFactsArtifacts(root, b, { timings: {} }, async path => { order.push(path); }); assert.ok(order.at(-1)!.endsWith('manifest.json'));
  await writeFactsArtifacts(root, b, { timings: {} }); await assert.rejects(writeFactsArtifacts(root, b, { timings: {} }), { code: 'EEXIST' });
  b.context.chat[0].value.text = 'я'.repeat(16384); let writes = 0;
  await assert.rejects(writeFactsArtifacts(root, b, {}, async () => { writes++; }), /context-too-large/); assert.equal(writes, 0);
});
