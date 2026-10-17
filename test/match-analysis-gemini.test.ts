import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisError, createGeminiPromptPackage, prepareGeminiAnalysis, presentGeminiAnalysis, validateGeminiAnalysis } from '../src/match-analysis/index.js';
import { validateAnalysisBundle } from '../src/match-analysis/input.js';
import { compactBundle, compactData, geminiAnswer, geminiPrompt } from './gemini-helpers.js';
import { bundle as legacyBundle, prompt as legacyPrompt } from './match-analysis-helpers.js';
import { prepareAnalysis } from '../src/match-analysis/index.js';
import { sha } from '../src/match-analysis/values.js';
import type { Raw } from '../src/match-analysis/types.js';

const error = (code: string) => (error: unknown) => error instanceof AnalysisError && error.code === code;

test('Gemini: отдельные публичный контракт/пакет/запрос, прежний v1 digest неизменен', () => {
  const b = compactBundle(), prepared = prepareGeminiAnalysis(b, geminiPrompt), body = JSON.parse(prepared.body);
  assert.equal(prepared.responseFormat, 'gemini-match-analysis-v1'); assert.equal(prepared.packageId, 'gemini-match-v1');
  assert.equal(body.model, 'google/gemini-3.8-flash'); assert.equal(body.stream, true); assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(body.reasoning, { effort: 'low', exclude: true }); assert.equal(body.max_tokens, 2048); assert.equal(body.temperature, 0.65);
  assert.deepEqual(body.provider, { only: ['google-ai-studio'], require_parameters: true, allow_fallbacks: false });
  assert.deepEqual(JSON.parse(body.messages[1].content), b.context); assert.equal(body.messages.length, 2);
  assert.equal(prepareAnalysis(legacyBundle(), legacyPrompt).requestDigest, 'e817312415485f6ab3527cd5dff1c1667b6131e0c3c77e3388c96592dbe5d5d2');
  assert.throws(() => validateAnalysisBundle(b), error('invalid-input'));
  assert.deepEqual(prepareGeminiAnalysis(b, geminiPrompt), prepared);
});

test('Gemini: пакет experimental, закреплённые профиль/схема, нет неподтверждённых примеров', () => {
  assert.match(geminiPrompt.files['instruction.md'], /Steam32/); assert.match(geminiPrompt.files['instruction.md'], /KP<25%/);
  assert.match(geminiPrompt.files['instruction.md'], /Duel Damage<150/);
  for (const file of ['profile.json', 'response.schema.json', 'examples.json'] as const) {
    assert.throws(() => createGeminiPromptPackage({ ...geminiPrompt.files, [file]: '{}' }), error(file === 'examples.json' ? 'invalid-example' : 'invalid-package'));
  }
  const changed = createGeminiPromptPackage({ ...geminiPrompt.files, 'instruction.md': geminiPrompt.files['instruction.md'] + '\nУточнение.' });
  assert.notEqual(changed.digest, geminiPrompt.digest); assert.notEqual(prepareGeminiAnalysis(compactBundle(), changed).requestDigest, prepareGeminiAnalysis(compactBundle(), geminiPrompt).requestDigest);
});

test('Gemini: сторона передана, победа не заменяет кандидатов проигравшими; 3 и 4 основания допустимы', () => {
  for (const side of ['radiant', 'dire'] as const) for (const win of [true, false]) for (const count of [3, 4]) {
    const data = compactData(); data.radiant_win = win; const b = compactBundle(data, side), a = geminiAnswer(b, count);
    assert.deepEqual(validateGeminiAnalysis(a, b), a); const display = presentGeminiAnalysis(a, b);
    assert.equal(display.side, side); assert.equal(display.won, side === 'radiant' ? win : !win); assert.equal(display.facts.length, count);
  }
});

test('Gemini: строгий JSON, число оснований, Unicode и лишние/пустые поля', () => {
  const b = compactBundle();
  for (const mutate of [(a: Raw) => { a.facts = []; }, (a: Raw) => { a.facts = geminiAnswer(b, 5).facts; },
    (a: Raw) => { a.selectedPlayerSlot = 0; }, (a: Raw) => { a.nomination = ' '; }, (a: Raw) => { a.nomination = '😀'.repeat(101); },
    (a: Raw) => { a.verdict = 'a'.repeat(401); }, (a: Raw) => { a.limitations = ['', '']; }, (a: Raw) => { a.playerAssessments = []; }]) {
    const a = structuredClone(geminiAnswer(b)) as unknown as Raw; mutate(a); assert.throws(() => validateGeminiAnalysis(a, b), error('invalid-output'));
  }
  const ok = geminiAnswer(b); ok.nomination = '😀'.repeat(100); assert.deepEqual(validateGeminiAnalysis(ok, b), ok);
});

test('Gemini: игровые причины не принимают chat ID, выдумку, локальную ссылку и unavailable', () => {
  const b = compactBundle();
  for (const id of [b.context.chat[0].id, 'e9999999', b.facts.players[0].hero.id, b.context.players[0].special_metrics.id]) {
    const a = geminiAnswer(b); a.facts[0].evidenceIds = [id]; assert.throws(() => validateGeminiAnalysis(a, b), error('unknown-fact-reference'));
  }
  const duplicate = geminiAnswer(b); duplicate.facts[0].evidenceIds.push(duplicate.facts[0].evidenceIds[0]); assert.throws(() => validateGeminiAnalysis(duplicate, b), error('invalid-output'));
});

test('Gemini: цитата точно из переданного текста выбранного автора, null без собственного чата', () => {
  const data = compactData(); (data.chat as Raw[]).push({ type: 'chat', slot: 7, time: 1500, key: 'я'.repeat(241) });
  const b = compactBundle(data), a = geminiAnswer(b); a.quoteId = b.context.chat.at(-1)!.id;
  const display = presentGeminiAnalysis(a, b); assert.equal(display.quote!.text, 'я'.repeat(240)); assert.equal(display.quote!.truncated, true); assert.equal(display.quote!.time_sec, 1500);
  a.selectedPlayerSlot = 128; assert.throws(() => validateGeminiAnalysis(a, b), error('unknown-fact-reference'));
  a.quoteId = b.context.players[0].core.id; assert.throws(() => validateGeminiAnalysis(a, b), error('unknown-fact-reference'));
  a.quoteId = null; assert.equal(presentGeminiAnalysis(a, b).quote, null);
});

test('Gemini: непригодные/подменённые входы и чрезмерный запрос отклоняются до транспорта', () => {
  const b = compactBundle();
  for (const mutate of [(x: typeof b) => { x.context.players.pop(); }, (x: typeof b) => { x.manifest.side = 'radiant'; }, (x: typeof b) => { x.context.chat[0].value.text = 'другой текст'; }]) {
    const changed = structuredClone(b); mutate(changed); assert.throws(() => prepareGeminiAnalysis(changed, geminiPrompt), error('integrity-error'));
  }
  const huge = createGeminiPromptPackage({ ...geminiPrompt.files, 'instruction.md': 'a'.repeat(32768) });
  assert.throws(() => prepareGeminiAnalysis(b, huge), error('request-too-large'));
  const forged = structuredClone(geminiPrompt); forged.digest = sha('fake'); assert.throws(() => prepareGeminiAnalysis(b, forged), error('invalid-package'));
});
