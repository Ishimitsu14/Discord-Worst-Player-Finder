import { Ajv } from 'ajv';
import { compactReferences, validateCompactBundle, validateCompactReferences } from '../match-facts/index.js';
import type { CompactFactsBundle } from '../match-facts/index.js';
import type { GeminiAnalysis, GeminiPresentation } from './gemini-types.js';
import { AnalysisError, type Raw } from './types.js';
import { canonical, ensure, finite, object } from './values.js';

const obj = (properties: Raw): Raw => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const text = (maxLength: number): Raw => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
const claimSchema = obj({ claim: text(240), evidenceIds: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: { type: 'string', pattern: '^e[1-9][0-9]*$' } } });
export const geminiResponseSchema: Raw = obj({
  version: { const: 1 }, format: { const: 'gemini-match-analysis-v1' }, selectedPlayerSlot: { enum: [0, 1, 2, 3, 4, 128, 129, 130, 131, 132] },
  nomination: text(100), facts: { type: 'array', minItems: 3, maxItems: 4, items: claimSchema },
  quoteId: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^e[1-9][0-9]*$' }] }, verdict: text(400), confidence: { enum: ['low', 'medium', 'high'] },
  limitations: { type: 'array', maxItems: 2, items: text(160) },
});
const validate = new Ajv().compile(geminiResponseSchema);
export const geminiResponseSchemaV2: Raw = obj({ ...geminiResponseSchema.properties as Raw,
  version: { const: 2 }, format: { const: 'gemini-match-analysis-v2' }, verdict: text(700),
  teamFacts: { type: 'array', minItems: 3, maxItems: 3, uniqueItems: true, items: claimSchema },
});
const validateV2 = new Ajv().compile(geminiResponseSchemaV2);
const identityFields = new Set(['player_slot', 'hero_id', 'hero_name', 'player_name', 'name_source', 'name_truncated', 'position', 'position_source']);
function availableGameValue(value: unknown): boolean {
  if (finite(value) || typeof value === 'boolean') return true;
  return object(value) && !('unavailable' in value) && Object.entries(value).some(([key, child]) => !identityFields.has(key) && availableGameValue(child));
}

export function validateGeminiAnalysis(input: unknown, inputBundle: CompactFactsBundle): GeminiAnalysis {
  let bundle: CompactFactsBundle;
  try { bundle = validateCompactBundle(inputBundle); } catch { throw new AnalysisError('integrity-error'); }
  ensure(object(input) && (input.format === 'gemini-match-analysis-v2' ? validateV2(input) : validate(input)), 'invalid-output'); canonical(input);
  const analysis = input as unknown as GeminiAnalysis;
  ensure(bundle.context.players.some(player => player.core.value.player_slot === analysis.selectedPlayerSlot), 'invalid-output');
  const references = compactReferences(bundle.context);
  for (const claim of [...analysis.facts, ...(analysis.version === 2 ? analysis.teamFacts : [])]) for (const id of claim.evidenceIds) {
    try { validateCompactReferences([id], bundle); } catch { throw new AnalysisError('unknown-fact-reference'); }
    const reference = references.get(id)!;
    ensure(reference.kind === 'game' && availableGameValue(reference.value), 'unknown-fact-reference');
  }
  if (analysis.quoteId !== null) {
    const reference = references.get(analysis.quoteId);
    ensure(reference?.kind === 'chat' && reference.slot === analysis.selectedPlayerSlot, 'unknown-fact-reference');
  }
  return analysis;
}

export function presentGeminiAnalysis(input: unknown, bundle: CompactFactsBundle): GeminiPresentation {
  const analysis = validateGeminiAnalysis(input, bundle), player = bundle.context.players.find(player => player.core.value.player_slot === analysis.selectedPlayerSlot)!.core.value;
  return { matchId: bundle.context.match_info.value.match_id, side: bundle.context.match_info.value.side, won: bundle.context.match_info.value.won,
    playerSlot: player.player_slot, playerName: player.player_name, heroName: player.hero_name, nomination: analysis.nomination,
    facts: structuredClone(analysis.facts), quote: analysis.quoteId === null ? null : structuredClone(bundle.context.chat.find(row => row.id === analysis.quoteId)!.value),
    verdict: analysis.verdict, confidence: analysis.confidence, limitations: [...analysis.limitations],
    ...(analysis.version === 2 ? { teamFacts: structuredClone(analysis.teamFacts) } : {}) };
}
