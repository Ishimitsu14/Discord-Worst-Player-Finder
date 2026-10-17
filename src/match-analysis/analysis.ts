import { Ajv } from 'ajv';
import { validateFactReferences } from '../match-facts/index.js';
import { briefReferences, validateAnalysisBundle, validateBrief } from './input.js';
import { responseSchema } from './response-schema.js';
import { AnalysisError, type Brief, type Claim, type ClaimAddress, type FactsBundle, type MatchAnalysis } from './types.js';
import { ensure } from './values.js';

const validate = new Ajv().compile(responseSchema);

export function analysisClaims(analysis: MatchAnalysis): { address: ClaimAddress; fact: Claim }[] {
  const claims: ReturnType<typeof analysisClaims> = [];
  const add = (section: ClaimAddress['section'], playerSlot: number | null, values: (Claim | null)[]): void => {
    values.forEach((fact, index) => { if (fact) claims.push({ address: { section, playerSlot, index }, fact }); });
  };
  for (const player of analysis.playerAssessments) {
    add('resources', player.playerSlot, [player.resources]);
    add('contributions', player.playerSlot, player.contributions);
    add('concerns', player.playerSlot, player.concerns);
    add('counterargument', player.playerSlot, [player.counterargument]);
  }
  for (const player of analysis.selectedPlayers) add('reasons', player.playerSlot, player.reasons);
  add('comparison', null, [analysis.comparison]);
  if (analysis.closestAlternative) add('alternative', analysis.closestAlternative.playerSlot, [analysis.closestAlternative.reason]);
  return claims;
}

export function validateAnalysisForBrief(input: unknown, context: Brief): MatchAnalysis {
  ensure(validate(input), 'invalid-output');
  const analysis = input as unknown as MatchAnalysis;
  const allies = context.allies;
  const selected = analysis.selectedPlayers;
  const allowed = (slot: number): boolean => allies.some(player => player.playerSlot === slot);
  ensure(new Set(analysis.playerAssessments.map(player => player.playerSlot)).size === 5, 'invalid-output');
  for (const assessment of analysis.playerAssessments) {
    const player = allies.find(player => player.playerSlot === assessment.playerSlot);
    ensure(player, 'invalid-output');
    const position = 'id' in player.role.position ? player.role.position.value : null;
    ensure(assessment.position === position && assessment.positionSource === player.role.source, 'invalid-output');
    ensure(assessment.resources !== null && assessment.counterargument !== null && assessment.contributions.length > 0 && assessment.concerns.length > 0 || assessment.limitations.length > 0, 'invalid-output');
  }
  ensure(new Set(selected.map(player => player.playerSlot)).size === selected.length && selected.every(player => allowed(player.playerSlot)), 'invalid-output');
  if (analysis.status === 'selected') {
    ensure(selected.length > 0 && analysis.comparison !== null, 'invalid-output');
    if (selected.length === 1) ensure(analysis.closestAlternative && allowed(analysis.closestAlternative.playerSlot) && analysis.closestAlternative.playerSlot !== selected[0].playerSlot, 'invalid-output');
    else ensure(analysis.closestAlternative === null, 'invalid-output');
  } else ensure(selected.length === 0 && analysis.comparison === null && analysis.closestAlternative === null && analysis.confidence === 'low' && analysis.limitations.length > 0, 'invalid-output');
  const references = briefReferences(context);
  ensure(analysisClaims(analysis).every(({ fact }) => fact.evidenceIds.every(id => references.has(id))), 'unknown-fact-reference');
  return analysis;
}

export function validateMatchAnalysis(input: unknown, bundle: FactsBundle): MatchAnalysis {
  validateAnalysisBundle(bundle);
  const analysis = validateAnalysisForBrief(input, bundle.context);
  try { validateFactReferences(analysisClaims(analysis).flatMap(({ fact }) => fact.evidenceIds), bundle); }
  catch { throw new AnalysisError('unknown-fact-reference'); }
  return analysis;
}

export function validateExampleAnalysis(input: unknown, context: unknown): MatchAnalysis {
  return validateAnalysisForBrief(input, validateBrief(context));
}
