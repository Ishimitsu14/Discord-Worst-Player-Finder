import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisError, analyzeGeminiMatch, createGeminiPromptPackage, prepareGeminiAnalysis, presentGeminiAnalysis, renderGeminiAnalysis, validateGeminiAnalysis } from '../src/match-analysis/index.js';
import { compactBundle, compactData, geminiAnswer, geminiAnswerV2, geminiEvents, geminiMetadata, geminiPrompt, geminiPromptV2, geminiStreamResponse } from './gemini-helpers.js';
import type { Raw } from '../src/match-analysis/types.js';

const error = (code: string) => (error: unknown) => error instanceof AnalysisError && error.code === code;

test('Gemini v2: отдельный пакет, прежнее тело v1 сохранено, прежние игровые правила на месте', () => {
  const b = compactBundle(), old = prepareGeminiAnalysis(b, geminiPrompt), current = prepareGeminiAnalysis(b, geminiPromptV2), body = JSON.parse(current.body);
  assert.equal(old.requestDigest, '16dcc2db73dbe05acd50d9bc36227d3a783f29eadf900ad725354b3966c44af8');
  assert.equal(current.packageId, 'gemini-match-v2'); assert.equal(current.responseFormat, 'gemini-match-analysis-v2');
  assert.equal(body.response_format.json_schema.name, 'gemini_match_analysis_v2'); assert.notEqual(current.requestDigest, old.requestDigest);
  assert.equal(body.max_tokens, 2048); assert.equal(body.temperature, 0.65); assert.deepEqual(body.reasoning, { effort: 'low', exclude: true });
  for (const rule of [/Steam32/, /KP<25%/, /Duel Damage<150/, /AFK-лес/, /2–3 связанных предложения/, /ровно три teamFacts/]) assert.match(geminiPromptV2.files['instruction.md'], rule);
  assert.throws(() => createGeminiPromptPackage({ ...geminiPromptV2.files, 'response.schema.json': geminiPrompt.files['response.schema.json'] }), error('invalid-package'));
});

test('Gemini v2: teamFacts обязательны, ровно три, без повторов/лишних полей; roast до 700 code points', () => {
  const b = compactBundle(), ok = geminiAnswerV2(b); ok.verdict = '😀'.repeat(700); assert.deepEqual(validateGeminiAnalysis(ok, b), ok);
  for (const mutate of [(a: Raw) => { delete a.teamFacts; }, (a: Raw) => { a.teamFacts = []; },
    (a: Raw) => { a.teamFacts = (a.teamFacts as unknown[]).slice(0, 2); }, (a: Raw) => { (a.teamFacts as unknown[]).push(ok.teamFacts[0]); },
    (a: Raw) => { a.teamFacts = Array(3).fill(ok.teamFacts[0]); }, (a: Raw) => { a.verdict = '😀'.repeat(701); },
    (a: Raw) => { a.version = 1; }, (a: Raw) => { a.roast = 'лишнее'; }]) {
    const a = structuredClone(geminiAnswerV2(b)) as unknown as Raw; mutate(a); assert.throws(() => validateGeminiAnalysis(a, b), error('invalid-output'));
  }
  const old = { ...geminiAnswer(b), teamFacts: ok.teamFacts }; assert.throws(() => validateGeminiAnalysis(old, b), error('invalid-output'));
});

test('Gemini v2: шуточные интерпретации без оговорок допустимы, входная метка ответа запрещена', () => {
  const b = compactBundle(), answer = geminiAnswerV2(b), instruction = geminiPromptV2.files['instruction.md'];
  answer.verdict = 'Вражескую недвижимость охранял лучше собственной базы.'; answer.limitations = [];
  assert.deepEqual(validateGeminiAnalysis(answer, b), answer);
  assert.match(instruction, /"version": 2, "format": "gemini-match-analysis-v2"/);
  assert.match(instruction, /не копируй его в поле format ответа/);
  assert.match(instruction, /Гиперболы и вольные игровые выводы допустимы/);
  assert.match(instruction, /Limitations может быть пустым/);
  assert.throws(() => validateGeminiAnalysis({ ...answer, format: 'gemini-compact-v1' }, b), error('invalid-output'));
});

test('Gemini v2: командные факторы не принимают чат, неизвестный ID или unavailable', () => {
  const b = compactBundle();
  for (const id of [b.context.chat[0].id, 'e9999999', b.context.players[0].special_metrics.id, b.facts.players[0].hero.id]) {
    const a = geminiAnswerV2(b); a.teamFacts[0].evidenceIds = [id]; assert.throws(() => validateGeminiAnalysis(a, b), error('unknown-fact-reference'));
  }
  const a = geminiAnswerV2(b); a.teamFacts[0].evidenceIds = [b.context.opponents[0].id];
  const display = presentGeminiAnalysis(a, b); assert.deepEqual(display.teamFacts, a.teamFacts);
  display.teamFacts![0].claim = 'изменено'; assert.notEqual(a.teamFacts[0].claim, display.teamFacts![0].claim);
});

test('Gemini v2: preview заканчивается тремя пунктами, исход/сторона и собственная цитата точны', () => {
  for (const side of ['radiant', 'dire'] as const) for (const win of [true, false]) {
    const data = compactData(); data.radiant_win = win;
    const b = compactBundle(data, side), a = geminiAnswerV2(b), won = side === 'radiant' ? win : !win, output = renderGeminiAnalysis(a, b);
    assert.ok(output.indexOf(a.verdict) < output.indexOf(a.teamFacts[0].claim));
    const heading = won ? '**Где накосячили, несмотря на победу**' : '**Почему проебали**';
    const final = output.slice(output.indexOf(heading)); assert.equal(final.split('\n').filter(line => /^\d\. /.test(line)).length, 3);
    assert.ok(output.endsWith(`3. ${a.teamFacts[2].claim}\n`)); assert.ok(output.includes(`${won ? 'Победа' : 'Поражение'} ${side === 'radiant' ? 'Radiant' : 'Dire'}`));
    if (a.quoteId !== null) {
      assert.ok(output.includes(`> ${b.context.chat.find(row => row.id === a.quoteId)!.value.text}`));
      assert.ok(output.includes(side === 'dire' ? 'Игрок 7, 20:00' : 'Игрок 0, 21:40'));
    }
    else assert.doesNotMatch(output, /^> /m);
    a.quoteId = null; assert.doesNotMatch(renderGeminiAnalysis(a, b), /^> /m);
  }
  assert.doesNotMatch(renderGeminiAnalysis(geminiAnswer(compactBundle()), compactBundle()), /Почему проебали|Где накосячили/);
});

test('Gemini v2: Markdown-превью экранирует недоверенный текст и помечает обрезку цитаты', () => {
  const data = compactData(); (data.chat as Raw[])[0].key = '@everyone\n**фальшивый финал** ' + 'я'.repeat(250);
  const b = compactBundle(data), a = geminiAnswerV2(b); a.nomination = '[ссылка](https://example.test)';
  const output = renderGeminiAnalysis(a, b);
  assert.ok(output.includes('\\[ссылка\\]\\(https://example.test\\)')); assert.doesNotMatch(output, /@everyone/);
  assert.match(output, /\[сокращено\]/); assert.doesNotMatch(output, /^\*\*фальшивый финал\*\*/m);
});

test('Gemini v2: один POST с тремя факторами; ответ другой версии отклоняется с сохранением расхода', async () => {
  const b = compactBundle();
  for (const [prompt, answer, valid] of [[geminiPromptV2, geminiAnswerV2(b), true], [geminiPromptV2, geminiAnswer(b), false], [geminiPrompt, geminiAnswerV2(b), false]] as const) {
    let posts = 0, starts = 0;
    const result = await analyzeGeminiMatch(prepareGeminiAnalysis(b, prompt), b, { attemptId: 'synthetic-version', maxEstimatedCostUsd: 1 }, {
      apiKey: 'synthetic-key', beforeSend: async () => { starts++; }, fetcher: async (url, init) => {
        if (String(url).endsWith('/endpoints')) return Response.json(geminiMetadata());
        assert.equal(starts, 1); assert.equal(init?.method, 'POST'); posts++; return geminiStreamResponse(geminiEvents(b, { answer }), 3);
      },
    });
    assert.equal(result.status, valid ? 'valid' : 'invalid-output', JSON.stringify(result.error)); assert.equal(posts, 1);
    assert.equal(result.usage.costUsd, 0.001); assert.equal(result.billingState, 'known');
    if (valid) assert.deepEqual(result.analysis, answer); else assert.equal(result.analysis, null);
  }
});
