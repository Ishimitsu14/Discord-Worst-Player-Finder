import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareMatchFacts } from '../src/match-facts/index.js';
import { dictionary, match } from './helpers.js';
import { AnalysisError, analysisClaims, createPromptPackage, loadPromptPackage, prepareAnalysis, validateAnalysisBundle, validateMatchAnalysis, type FactsBundle, type MatchAnalysis, type PackageFiles, type PromptPackage } from '../src/match-analysis/index.js';
import { canonical, digest, sha } from '../src/match-analysis/values.js';
import { analysis, bundle, prompt } from './match-analysis-helpers.js';

const error = (code: string) => (value: unknown): boolean => value instanceof AnalysisError && value.code === code;
const files = (): PackageFiles => ({ ...prompt.files });
const changedProfile = (changes: object): PromptPackage => createPromptPackage({ ...files(), 'profile.json': JSON.stringify({ ...prompt.profile, ...changes }) });
function rehash(value: FactsBundle): FactsBundle {
  value.manifest.contextDigest = sha(value.context);
  const { bundleId, ...identity } = value.manifest;
  value.manifest.bundleId = sha(identity);
  return value;
}

test('пакет читается из точных bytes, экспериментальный и без реальных примеров', async () => {
  assert.equal(prompt.profile.calibration, 'experimental');
  assert.equal(prompt.profile.calibrationReport, null);
  assert.deepEqual(prompt.examples, []);
  assert.equal(prompt.files['instruction.md'], await readFile('analysis/prompts/v1/instruction.md', 'utf8'));
  assert.deepEqual(createPromptPackage(files()), prompt);
  for (const name of Object.keys(files()) as (keyof PackageFiles)[]) {
    const modified = files(); modified[name] += '\n';
    assert.notEqual(createPromptPackage(modified).digest, prompt.digest);
    assert.notEqual(prepareAnalysis(bundle(), createPromptPackage(modified)).requestDigest, prepareAnalysis(bundle(), prompt).requestDigest);
  }
  await assert.rejects(loadPromptPackage('nonexistent-match-analysis-package'), error('invalid-package'));
});

test('неизвестные модель/форматы/параметры, ослабленная схема и мнимая калибровка отвергаются', () => {
  for (const changes of [
    { version: 2 }, { model: 'other' }, { contextFormat: 'compact-v2' }, { responseFormat: 'analysis-v2' },
    { temperature: NaN }, { maxTokens: -1 }, { reasoning: 'enabled' }, { maxRequestBytes: 262145 },
    { provider: { ...prompt.profile.provider, require_parameters: false } }, { extra: true }, { calibration: 'candidate' },
    { calibration: 'experimental', calibrationReport: { path: 'missing.json', digest: 'a'.repeat(64) } },
  ]) assert.throws(() => changedProfile(changes), error('invalid-package'));
  assert.throws(() => createPromptPackage({ ...files(), 'response.schema.json': '{}' }), error('invalid-package'));
  assert.throws(() => createPromptPackage({ ...files(), 'instruction.md': ' ' }), error('invalid-package'));
  const report = JSON.stringify({ version: 1, stage: 'candidate', reviewsRevision: 'synthetic', recommendation: { conclusion: 'candidate' } });
  const candidate = { ...files(), 'profile.json': JSON.stringify({ ...prompt.profile, calibration: 'candidate', calibrationReport: { path: '.local/synthetic-report.json', digest: digest(report) } }) };
  assert.throws(() => createPromptPackage(candidate), error('invalid-package'));
  assert.throws(() => createPromptPackage(candidate, '{}'), error('invalid-package'));
  assert.equal(createPromptPackage(candidate, report).profile.calibration, 'candidate');
});

test('примеры требуют development, проверяемую форму и происхождение; цель и другая сторона запрещены', () => {
  const source = bundle('dire', false, 102);
  const example = { context: source.context, analysis: analysis(source), provenance: {
    matchId: 102, side: 'dire', snapshotDigest: source.manifest.dataDigest, contextDigest: source.manifest.contextDigest,
    split: 'development', labelRevision: 'synthetic-labels', reviewRevision: 'synthetic-review',
  } };
  const withExample = (value: unknown) => createPromptPackage({ ...files(), 'examples.json': JSON.stringify({ version: 1, entries: [value] }) });
  const approved = withExample(example);
  const prepared = prepareAnalysis(bundle(), approved);
  const constrained = createPromptPackage({ ...approved.files, 'profile.json': JSON.stringify({ ...approved.profile, maxRequestBytes: prepareAnalysis(bundle(), prompt).requestBytes }) });
  assert.throws(() => prepareAnalysis(bundle(), constrained), error('request-too-large'));
  const messages = JSON.parse(prepared.body).messages;
  assert.equal(messages.length, 4);
  assert.equal(messages[1].role, 'user'); assert.equal(messages[2].role, 'assistant');
  assert.ok(!prepared.body.includes('synthetic-labels'));
  assert.throws(() => prepareAnalysis(bundle('radiant', true, 102), approved), error('invalid-example'));
  assert.throws(() => prepareAnalysis(source, approved), error('invalid-example'));
  for (const sourceChange of [{ split: 'holdout' }, { contextDigest: '0'.repeat(64) }, { matchId: 103 }, { reviewRevision: '' }, { side: 'radiant' }, { snapshotDigest: 'broken' }, { other: true }]) {
    assert.throws(() => withExample({ ...example, provenance: { ...example.provenance, ...sourceChange } }), AnalysisError);
  }
  assert.throws(() => withExample({ ...example, context: { ...source.context, account_id: 1 } }), AnalysisError);
  assert.throws(() => withExample({ ...example, analysis: { ...example.analysis, version: 2 } }), AnalysisError);
});

test('офлайн-запрос воспроизводим, содержит только Brief и сохраняет копию пакета', () => {
  const input = bundle(), copy = canonical(input), source = createPromptPackage(files());
  const prepared = prepareAnalysis(input, source);
  assert.deepEqual(prepareAnalysis(input, source), prepared);
  assert.equal(canonical(input), copy);
  const body = JSON.parse(prepared.body);
  assert.deepEqual(JSON.parse(body.messages.at(-1).content), input.context);
  assert.deepEqual(body.messages.map((message: { role: string }) => message.role), ['system', 'user']);
  assert.equal(body.model, prompt.profile.model); assert.equal(body.stream, false);
  assert.equal(body.response_format.json_schema.strict, true);
  assert.ok(!prepared.body.includes('private nickname'));
  for (const key of ['Authorization', 'account_id', 'dataDigest', 'evidenceDigest', 'reasoning', 'tools', 'models']) assert.ok(!Object.hasOwn(body, key));
  assert.equal(digest(prepared.body), prepared.requestDigest);
  assert.equal(prepared.requestBytes, Buffer.byteLength(prepared.body, 'utf8'));
  assert.equal(prepared.estimatedInputTokens, Math.ceil(prepared.requestBytes / 2));
  source.files['instruction.md'] += 'changed'; source.profile.temperature = 0.5;
  assert.equal(prepared.prompt.profile.temperature, 0.2);
  assert.ok(!prepared.prompt.files['instruction.md'].includes('changed'));
  assert.notEqual(prepareAnalysis(input, changedProfile({ temperature: 0.3 })).requestDigest, prepared.requestDigest);
  assert.notEqual(prepareAnalysis(bundle('dire'), prompt).requestDigest, prepared.requestDigest);
});

test('границы UTF-8 отчёта и запроса точны, переполнение не сокращает данные', () => {
  const input = bundle();
  input.context.limitations.push('');
  const emptyBytes = Buffer.byteLength(JSON.stringify(input.context));
  input.context.limitations[input.context.limitations.length - 1] = 'x'.repeat(65536 - emptyBytes);
  rehash(input);
  assert.equal(prepareAnalysis(input, prompt).contextBytes, 65536);
  input.context.limitations[input.context.limitations.length - 1] += 'я'; rehash(input);
  assert.throws(() => prepareAnalysis(input, prompt), error('context-too-large'));
  const regular = bundle(), prepared = prepareAnalysis(regular, prompt);
  assert.equal(prepareAnalysis(regular, changedProfile({ maxRequestBytes: prepared.requestBytes })).requestBytes, prepared.requestBytes);
  assert.throws(() => prepareAnalysis(regular, changedProfile({ maxRequestBytes: prepared.requestBytes - 1 })), error('request-too-large'));
  const huge = createPromptPackage({ ...files(), 'instruction.md': 'я'.repeat(140000) });
  assert.throws(() => prepareAnalysis(regular, huge), error('request-too-large'));
});

test('схема принимает одного, пару, неизвестные роли и обоснованный отказ на обеих сторонах', () => {
  for (const side of ['radiant', 'dire'] as const) for (const win of [true, false]) {
    const input = bundle(side, win);
    assert.equal(validateAnalysisBundle(input), input);
    for (const slots of [[input.context.allies[0].playerSlot], input.context.allies.slice(0, 2).map(player => player.playerSlot)]) {
      const answer = analysis(input, slots); assert.equal(validateMatchAnalysis(answer, input), answer);
      assert.equal(analysisClaims(answer).length, slots.length === 1 ? 24 : 25);
    }
    const refusal = analysis(input);
    refusal.status = 'insufficient-evidence'; refusal.selectedPlayers = []; refusal.comparison = null; refusal.closestAlternative = null;
    assert.equal(validateMatchAnalysis(refusal, input), refusal);
    assert.equal(analysisClaims(refusal).length, 20);
  }
  const data = match();
  const unknown = prepareMatchFacts({ matchId: 101, side: 'radiant', data }, { dictionary });
  assert.equal(validateMatchAnalysis(analysis(unknown), unknown).playerAssessments[0].position, null);
  const manual = prepareMatchFacts({ matchId: 101, side: 'radiant', data }, { dictionary, roleOverrides: [{ playerSlot: 0, position: 5 }] });
  assert.equal(validateMatchAnalysis(analysis(manual), manual).playerAssessments[0].positionSource, 'manual');
});

test('ошибки состава, позиций, статуса, пустых разделов и строковых пределов отклоняются', () => {
  const input = bundle();
  for (const change of [
    (a: MatchAnalysis) => { a.playerAssessments.pop(); },
    (a: MatchAnalysis) => { a.playerAssessments[1].playerSlot = 0; },
    (a: MatchAnalysis) => { a.playerAssessments[0].position = 5; },
    (a: MatchAnalysis) => { a.playerAssessments[0].positionSource = 'manual'; },
    (a: MatchAnalysis) => { a.playerAssessments[0].resources = null; },
    (a: MatchAnalysis) => { a.playerAssessments[0].concerns = []; },
    (a: MatchAnalysis) => { a.selectedPlayers[0].playerSlot = 128; },
    (a: MatchAnalysis) => { a.selectedPlayers.push(a.selectedPlayers[0]); },
    (a: MatchAnalysis) => { a.selectedPlayers = analysis(input, [0, 1, 2]).selectedPlayers; a.closestAlternative = null; },
    (a: MatchAnalysis) => { a.selectedPlayers[0].roast = ' '; },
    (a: MatchAnalysis) => { a.selectedPlayers[0].roast = 'я'.repeat(601); },
    (a: MatchAnalysis) => { a.selectedPlayers[0].reasons.pop(); },
    (a: MatchAnalysis) => { a.closestAlternative = null; },
    (a: MatchAnalysis) => { a.closestAlternative!.playerSlot = 0; },
    (a: MatchAnalysis) => { a.comparison = null; },
    (a: MatchAnalysis) => { a.status = 'insufficient-evidence'; },
    (a: MatchAnalysis) => { Object.assign(a, { explanation: 'extra' }); },
  ]) { const answer = structuredClone(analysis(input)); change(answer); assert.throws(() => validateMatchAnalysis(answer, input), error('invalid-output')); }
  const allowed = structuredClone(analysis(input)); allowed.playerAssessments[0].concerns = []; allowed.playerAssessments[0].limitations = ['Нет наблюдений.'];
  assert.equal(validateMatchAnalysis(allowed, input), allowed);
  const unicode = structuredClone(analysis(input)); unicode.selectedPlayers[0].roast = '😀'.repeat(600);
  assert.equal(validateMatchAnalysis(unicode, input), unicode);
});

test('ссылки всех разделов проверяются, локальные дочерние ID не принимаются', () => {
  const input = bundle(), answer = analysis(input);
  const claims = analysisClaims(answer);
  assert.equal(claims.length, 24);
  assert.equal(new Set(claims.map(({ address }) => JSON.stringify(address))).size, claims.length);
  const group = input.evidence.find(entry => entry.id === input.context.allies[0].metrics.id)!;
  const localId = group.inputs.find(id => !JSON.stringify(input.context).includes(`"id":"${id}"`))!;
  assert.ok(localId);
  for (const badId of [localId, 'e9999999']) {
    for (const index of claims.keys()) {
      const changed = structuredClone(answer); analysisClaims(changed)[index].fact.evidenceIds = [badId];
      assert.throws(() => validateMatchAnalysis(changed, input), error('unknown-fact-reference'));
    }
  }
  const duplicate = structuredClone(answer); duplicate.comparison!.evidenceIds.push(duplicate.comparison!.evidenceIds[0]);
  assert.throws(() => validateMatchAnalysis(duplicate, input), error('invalid-output'));
  const falseClaim = structuredClone(answer); falseClaim.comparison!.claim = 'Заведомо неверная интерпретация для проверки предела валидатора.';
  assert.equal(validateMatchAnalysis(falseClaim, input), falseClaim);
});

test('документированный офлайн-пример выполняется без ключа', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'match-analysis-example-'));
  const input = bundle();
  await Promise.all(Object.entries(input).map(([name, value]) => writeFile(join(directory, `${name}.json`), JSON.stringify(value))));
  const child = spawnSync(process.execPath, ['analysis/examples/prepare.mjs', directory], { encoding: 'utf8', env: { ...process.env, OPENROUTER_API_KEY: '' } });
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.equal(output.matchId, 101); assert.equal(output.requestDigest, prepareAnalysis(input, prompt).requestDigest);
  assert.equal(output.calibration, 'experimental');
});
