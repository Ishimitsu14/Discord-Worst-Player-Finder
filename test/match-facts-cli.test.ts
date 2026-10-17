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
import type { FactsBundleV2 } from '../src/match-facts/index.js';
import { dictionary, match } from './helpers.js';

const cli = 'dist/src/evaluation-lab/cli.js';
const offline = 'data:text/javascript,globalThis.fetch=()=>{throw new Error("network forbidden")};';
const invoke = (args: string[]) => spawnSync(process.execPath, ['--import', offline, cli, ...args], { encoding: 'utf8', env: { ...process.env, OPENROUTER_API_KEY: '', OPENDOTA_API_KEY: '' } });
async function savedMatch(data = match()) {
  const root = await mkdtemp(join(tmpdir(), 'match-facts-'));
  const file = join(root, 'input.json'); await writeFile(file, JSON.stringify(data));
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

test('CLI V2: явный формат, реальные diagnostics и читаемые сводки, повтор без сети', async () => {
  const { root } = await savedMatch();
  for (let index = 0; index < 2; index++) {
    const result = invoke(['facts', '--root', root, '--match-id', '101', '--side', 'dire', '--brief-format', 'match-brief-v2']);
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Формат: match-brief-v2/);
  }
  const [a, b] = (await readdir(join(root, 'facts'))).map(name => join(root, 'facts', name));
  for (const file of ['facts.json', 'context.json', 'evidence.json', 'manifest.json', 'summary.md']) assert.deepEqual(await readFile(join(a, file)), await readFile(join(b, file)));
  assert.equal((await readdir(a)).length, 6);
  const context = await readJson(join(a, 'context.json')) as FactsBundleV2['context'];
  const summary = await readFile(join(a, 'summary.md'), 'utf8');
  assert.match(summary, /Смерти в предоставленных карточках/); assert.match(summary, /События уничтожения строений/); assert.match(summary, /не рейтинг качества/);
  assert.ok(summary.includes(context.summaries.allyMetricOrder.hero_damage.id));
  const diagnostics = await readJson(join(a, 'diagnostics.json')) as Record<string, unknown>;
  assert.equal(diagnostics.briefFormat, 'match-brief-v2'); assert.equal(diagnostics.briefProfile, 'brief-profile-2'); assert.equal(diagnostics.diagnosticBriefFormat, 'match-brief-v2');
  const manifest = await readJson(join(a, 'manifest.json')) as FactsBundleV2['manifest']; assert.equal(manifest.factsProfile, 'facts-profile-2');
  const legacy = await prepareFacts({ root, matchId: 101, side: 'dire', briefFormat: 'match-brief-v1' });
  assert.equal(legacy.bundle.context.format, 'match-brief-v1'); assert.notEqual(legacy.bundle.manifest.bundleId, manifest.bundleId);
});

test('CLI: неверный формат или операция отклоняются до чтения и сети', () => {
  const wrong = invoke(['facts', '--match-id', '101', '--side', 'dire', '--brief-format', 'other']);
  assert.equal(wrong.status, 1); assert.match(wrong.stderr, /invalid-input/);
  const operation = invoke(['collect', '--brief-format', 'match-brief-v2']);
  assert.equal(operation.status, 1); assert.match(operation.stderr, /доступен только для facts/);
});

test('CLI V2: переполнение не создаёт manifest и не возвращает V1', async () => {
  const data = match(); data.teamfights = Array.from({ length: 100 }, () => ({ start: 710, end: 740, deaths: 10,
    players: Array.from({ length: 10 }, () => ({ deaths: 1, damage: 0, healing: 0, buybacks: 0, gold_delta: 0 })) }));
  const { root } = await savedMatch(data);
  const overflow = invoke(['facts', '--root', root, '--match-id', '101', '--side', 'dire', '--brief-format', 'match-brief-v2']);
  assert.equal(overflow.status, 1); assert.match(overflow.stderr, /context-too-large.*bytes.*limit/);
  assert.deepEqual(await readdir(join(root, 'facts')).catch(() => []), []);
  const bundle = prepareMatchFacts({ matchId: 101, side: 'dire', data: match() }, { dictionary, briefFormat: 'match-brief-v2' });
  bundle.context.limitations.push('я'.repeat(65536));
  let writes = 0;
  await assert.rejects(writeFactsArtifacts(join(root, 'oversize'), bundle, {}, async () => { writes++; }), /context-too-large/);
  assert.equal(writes, 0);
});

test('запись V2: manifest последним, прерывание и повтор не перезаписывают пакет', async () => {
  const root = await mkdtemp(join(tmpdir(), 'match-facts-v2-write-'));
  const data = match(), bundle = prepareMatchFacts({ matchId: 101, side: 'dire', data }, { dictionary, briefFormat: 'match-brief-v2' });
  const complete = join(root, 'complete'), partial = join(root, 'partial'); await mkdir(complete); await mkdir(partial);
  const order: string[] = [];
  await writeFactsArtifacts(complete, bundle, { timings: {} }, async (path, bytes) => { order.push(path); await atomicWrite(path, bytes); });
  assert.ok(order.at(-1)!.endsWith('manifest.json'));
  const before = await readFile(join(complete, 'manifest.json'));
  await assert.rejects(writeFactsArtifacts(complete, bundle, {}), { code: 'EEXIST' }); assert.deepEqual(await readFile(join(complete, 'manifest.json')), before);
  let writes = 0;
  await assert.rejects(writeFactsArtifacts(partial, bundle, {}, async (path, bytes) => { if (++writes === 3) throw new Error('interrupted'); await atomicWrite(path, bytes); }), /interrupted/);
  assert.ok(!(await readdir(partial)).includes('manifest.json'));
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
