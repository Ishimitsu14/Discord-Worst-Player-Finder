import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { AnalysisError, validateAnalysisBundle } from '../src/match-analysis/index.js';
import { prepareMatchFacts } from '../src/match-facts/index.js';
import { canonical, sha } from '../src/match-analysis/values.js';
import { dictionary, match } from './helpers.js';

test('импорт аналитика не требует окружения, файлов пакета и сети', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    globalThis.fetch = () => { throw new Error('network forbidden'); };
    const { AnalysisError } = await import('./dist/src/match-analysis/index.js');
    if (new AnalysisError('invalid-input').message !== 'invalid-input') process.exit(1);
  `], { env: { ...process.env, OPENROUTER_API_KEY: '' }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(new AnalysisError('invalid-input').code, 'invalid-input');
});

test('граница пакета принимает обе стороны, неизвестные роли, анонимность и нули без мутации', () => {
  for (const side of ['radiant', 'dire'] as const) for (const win of [true, false]) {
    const bundle = prepareMatchFacts({ matchId: 101, side, data: match(101, win) }, { dictionary });
    const before = canonical(bundle);
    assert.equal(validateAnalysisBundle(bundle), bundle);
    assert.equal(canonical(bundle), before);
    assert.equal(sha(bundle.context), bundle.manifest.contextDigest);
  }
});

test('повреждённые части, чужая идентичность и неизвестные поля/форматы отклоняются', () => {
  const bundle = prepareMatchFacts({ matchId: 101, side: 'radiant', data: match() }, { dictionary });
  for (const mutate of [
    (b: typeof bundle) => { b.context.matchId++; },
    (b: typeof bundle) => { b.context.side = 'dire'; },
    (b: typeof bundle) => { b.context.allies[0].playerSlot = 1; },
    (b: typeof bundle) => { b.context.allies.pop(); },
    (b: typeof bundle) => { b.facts.matchId++; },
    (b: typeof bundle) => { b.facts.derived = {}; },
    (b: typeof bundle) => { b.evidence[0].value = -1; },
    (b: typeof bundle) => { b.manifest.dataDigest = 'changed'; },
    (b: typeof bundle) => { Object.assign(b.context.allies[0], { personaname: 'private' }); },
    (b: typeof bundle) => { Object.assign(b.context, { version: 99 }); },
  ]) { const changed = structuredClone(bundle); mutate(changed); assert.throws(() => validateAnalysisBundle(changed), AnalysisError); }
  const cyclic = structuredClone(bundle); Object.assign(cyclic.facts, { cyclic });
  assert.throws(() => validateAnalysisBundle(cyclic), AnalysisError);
});
