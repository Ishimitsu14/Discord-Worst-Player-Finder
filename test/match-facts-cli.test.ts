import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collect } from '../src/evaluation-lab/corpus.js';
import { atomicWrite, readJson } from '../src/evaluation-lab/files.js';
import { prepareFacts, writeFactsArtifacts } from '../src/evaluation-lab/facts.js';
import { prepareMatchFacts } from '../src/match-facts/index.js';
import { dictionary, match } from './helpers.js';

const cli = 'dist/src/evaluation-lab/cli.js';
const offline = 'data:text/javascript,globalThis.fetch=()=>{throw new Error("network forbidden")};';
const invoke = (args: string[]) => spawnSync(process.execPath, ['--import', offline, cli, ...args], { encoding: 'utf8', env: { ...process.env, OPENROUTER_API_KEY: '', OPENDOTA_API_KEY: '' } });
async function savedMatch() {
  const root = await mkdtemp(join(tmpdir(), 'match-facts-'));
  const file = join(root, 'input.json'); await writeFile(file, JSON.stringify(match()));
  const entry = await collect({ root, matchId: 101, side: 'dire', fromFile: file });
  return { root, entry };
}

test('CLI facts: без сети/ключей, шесть артефактов, идентичные повторы и сохранённые timings', async () => {
  const { root } = await savedMatch();
  const help = invoke(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /facts.*--roles/);
  const corpusBefore = await readFile(join(root, 'corpus.json'));
  for (let i = 0; i < 2; i++) { const result = invoke(['facts', '--root', root, '--match-id', '101', '--side', 'dire']); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Сеть и ИИ не использовались/); }
  assert.deepEqual(await readFile(join(root, 'corpus.json')), corpusBefore);
  const directories = await readdir(join(root, 'facts')); assert.equal(directories.length, 2);
  const [a, b] = directories.map(name => join(root, 'facts', name));
  assert.deepEqual((await readdir(a)).sort(), ['context.json', 'diagnostics.json', 'evidence.json', 'facts.json', 'manifest.json', 'summary.md']);
  for (const file of ['facts.json', 'context.json', 'evidence.json', 'manifest.json', 'summary.md']) assert.deepEqual(await readFile(join(a, file)), await readFile(join(b, file)));
  const diagnostics = await readJson(join(a, 'diagnostics.json')) as { timings: Record<string, number> };
  assert.ok(['readAndCheckMs', 'prepareMs', 'normalizeMs', 'buildBriefMs', 'verifyMs', 'serializeMs', 'writeMs'].every(field => Number.isFinite(diagnostics.timings[field])));
  const bytes = await readFile(join(a, 'context.json')); assert.equal(bytes.toString(), JSON.stringify(JSON.parse(bytes.toString())));
});

test('CLI facts: отсутствие/повреждение снимка и неверный match ID файла ролей', async () => {
  const { root, entry } = await savedMatch();
  const missing = invoke(['facts', '--root', root, '--match-id', '999', '--side', 'dire']);
  assert.equal(missing.status, 1); assert.match(missing.stderr, /snapshot-not-found/);
  const rolesFile = join(root, 'roles.json'); await writeFile(rolesFile, JSON.stringify({ version: 1, matchId: 102, entries: [] }));
  const wrong = invoke(['facts', '--root', root, '--match-id', '101', '--side', 'dire', '--roles', rolesFile]);
  assert.equal(wrong.status, 1); assert.match(wrong.stderr, /invalid-role-override/);
  await writeFile(rolesFile, JSON.stringify({ version: 1, matchId: 101, entries: [{ playerSlot: 128, position: 5 }] }));
  const valid = await prepareFacts({ root, matchId: 101, side: 'dire', rolesFile }); assert.equal(valid.bundle.context.allies[0].role.source, 'manual');
  await writeFile(join(root, entry.snapshot), '{}');
  const corrupt = invoke(['facts', '--root', root, '--match-id', '101', '--side', 'dire']);
  assert.equal(corrupt.status, 1); assert.match(corrupt.stderr, /digest-mismatch/);
});

test('запись: manifest последним, прерванный запуск не выглядит завершённым, нет перезаписи', async () => {
  const root = await mkdtemp(join(tmpdir(), 'match-facts-write-'));
  const bundle = prepareMatchFacts({ matchId: 101, side: 'radiant', data: match() }, { dictionary });
  const complete = join(root, 'complete'), partial = join(root, 'partial'); await mkdir(complete); await mkdir(partial);
  const order: string[] = [];
  await writeFactsArtifacts(complete, bundle, { timings: {} }, async (path, bytes) => { order.push(path); await atomicWrite(path, bytes); });
  assert.ok(order.at(-1)!.endsWith('manifest.json'));
  const before = await readFile(join(complete, 'manifest.json'));
  await assert.rejects(writeFactsArtifacts(complete, bundle, { timings: {} }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(join(complete, 'manifest.json')), before);
  let writes = 0;
  await assert.rejects(writeFactsArtifacts(partial, bundle, { timings: {} }, async (path, bytes) => { if (++writes === 3) throw new Error('interrupted'); await atomicWrite(path, bytes); }), /interrupted/);
  assert.ok(!(await readdir(partial)).includes('manifest.json'));
});
