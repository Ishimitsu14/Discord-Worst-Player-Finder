import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisError, analysisClaims, analyzeMatch, createPromptPackage, loadPromptPackage, prepareAnalysis, validateMatchAnalysis } from '../src/match-analysis/index.js';
import { metadataUrl } from '../src/match-analysis/openrouter.js';
import { analysis, bundle, metadata, payload, prompt } from './match-analysis-helpers.js';

const portable = await loadPromptPackage('analysis/prompts/v2');
const invalid = (error: unknown) => error instanceof AnalysisError && error.code === 'invalid-output';

test('v2 меняет схему и reasoning явно, точное тело прежнего v1 сохранено', () => {
  const input = bundle(), legacy = prepareAnalysis(input, prompt), prepared = prepareAnalysis(input, portable);
  assert.equal(legacy.requestDigest, 'e817312415485f6ab3527cd5dff1c1667b6131e0c3c77e3388c96592dbe5d5d2');
  assert.equal(legacy.packageDigest, '998028d8b497f8676365f635cff68e73a3ae9220ecb9e6f8c2c683b8e39ba8b9');
  assert.deepEqual(prepareAnalysis(input, portable), prepared);
  assert.notEqual(prepared.requestDigest, legacy.requestDigest);
  assert.equal(portable.files['instruction.md'], prompt.files['instruction.md']);
  assert.equal(Object.hasOwn(JSON.parse(legacy.body), 'reasoning'), false);
  const body = JSON.parse(prepared.body), schema = body.response_format.json_schema.schema;
  assert.deepEqual(body.reasoning, { enabled: false });
  for (const field of [schema.$defs.claim.properties.claim, schema.properties.selectedPlayers.items.properties.roast,
    schema.properties.playerAssessments.items.properties.limitations.items, schema.properties.limitations.items]) {
    assert.equal(Object.hasOwn(field, 'pattern'), false);
    assert.equal(field.minLength, 1);
  }
  assert.equal(schema.$defs.claim.properties.evidenceIds.items.pattern, '^e[1-9][0-9]*$');
  schema.$defs.claim.properties.claim.maxLength = 601;
  assert.throws(() => createPromptPackage({ ...portable.files, 'response.schema.json': JSON.stringify(schema) }), AnalysisError);
});

test('однобуквенные Claim во всех разделах, roast и ограничения отклоняются по Unicode code points', () => {
  const input = bundle(), baseline = analysis(input);
  assert.deepEqual(validateMatchAnalysis(baseline, input), baseline);
  for (let index = 0; index < analysisClaims(baseline).length; index++) {
    const answer = structuredClone(baseline);
    analysisClaims(answer)[index].fact.claim = 'Д';
    assert.throws(() => validateMatchAnalysis(answer, input), invalid);
  }
  for (const text of ['Р', '  Р\n', '💥', '   ']) {
    for (const kind of ['roast', 'player-limit', 'global-limit']) {
      const answer = structuredClone(baseline);
      if (kind === 'roast') answer.selectedPlayers[0].roast = text;
      else if (kind === 'player-limit') answer.playerAssessments[0].limitations = [text];
      else answer.limitations = [text];
      assert.throws(() => validateMatchAnalysis(answer, input), invalid);
    }
  }
  const short = structuredClone(baseline);
  short.limitations = ['Да'];
  assert.doesNotThrow(() => validateMatchAnalysis(short, input));
});

test('disabled требует reasoning у каждого разрешённого endpoint до started и POST', async () => {
  const input = bundle(), prepared = prepareAnalysis(input, portable);
  for (const mixed of [false, true]) {
    const current = metadata(portable);
    current.data.endpoints[0].max_completion_tokens = 40000;
    if (mixed) {
      current.data.endpoints[0].supported_parameters.push('reasoning');
      const unsupported = structuredClone(current.data.endpoints[0]);
      unsupported.supported_parameters = unsupported.supported_parameters.filter(value => value !== 'reasoning');
      current.data.endpoints.push(unsupported);
    }
    let posts = 0, starts = 0;
    const result = await analyzeMatch(prepared, input, { attemptId: 'missing-reasoning', maxEstimatedCostUsd: 1 }, {
      apiKey: 'synthetic-key', beforeSend: async () => { starts++; },
      fetcher: async url => { if (String(url) !== metadataUrl) posts++; return Response.json(current); },
    });
    assert.equal(result.error?.code, 'unsupported-endpoint');
    assert.equal(result.requestSent, false); assert.equal(posts, 0); assert.equal(starts, 0);
  }
});

test('v2 отправляет точный запрос один раз, вырожденный ответ сохраняет стоимость и не повторяется', async () => {
  const input = bundle(), prepared = prepareAnalysis(input, portable);
  for (const degenerate of [false, true]) {
    const current = metadata(portable);
    current.data.endpoints[0].max_completion_tokens = 40000;
    current.data.endpoints[0].supported_parameters.push('reasoning');
    const response = payload(input);
    if (degenerate) {
      const answer = analysis(input);
      for (const { fact } of analysisClaims(answer)) fact.claim = 'Д';
      answer.selectedPlayers[0].roast = 'Р'; answer.limitations = ['П'];
      response.choices[0].message.content = JSON.stringify(answer);
    }
    let posts = 0;
    const events: string[] = [];
    const result = await analyzeMatch(prepared, input, { attemptId: `portable-${degenerate}`, maxEstimatedCostUsd: 1 }, {
      apiKey: 'synthetic-key', beforeSend: async started => { events.push('started'); assert.equal(started.requestDigest, prepared.requestDigest); },
      fetcher: async (url, init) => {
        if (String(url) === metadataUrl) return Response.json(current);
        posts++; events.push('post');
        assert.equal(init?.body, prepared.body);
        assert.deepEqual(JSON.parse(String(init?.body)).reasoning, { enabled: false });
        return Response.json(response);
      },
    });
    assert.equal(posts, 1); assert.deepEqual(events, ['started', 'post']);
    assert.equal(result.status, degenerate ? 'invalid-output' : 'valid');
    if (degenerate) { assert.equal(result.error?.code, 'invalid-output'); assert.equal(result.analysis, null); }
    assert.equal(result.billingState, 'known'); assert.equal(result.usage.costUsd, 0.001);
  }
});
