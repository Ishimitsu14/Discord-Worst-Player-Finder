const obj = <T extends Record<string, unknown>>(properties: T) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
const claim = { $ref: '#/$defs/claim' };
const nullableClaim = { anyOf: [claim, { type: 'null' }] };
const slot = { type: 'integer', enum: [0, 1, 2, 3, 4, 128, 129, 130, 131, 132] };
const limitations = { type: 'array', maxItems: 8, items: text(300) };
const claims = { type: 'array', maxItems: 3, items: claim };

export const responseSchema = {
  ...obj({
    version: { const: 1 }, format: { const: 'match-analysis-v1' }, status: { enum: ['selected', 'insufficient-evidence'] },
    confidence: { enum: ['low', 'medium', 'high'] },
    playerAssessments: { type: 'array', minItems: 5, maxItems: 5, items: obj({
      playerSlot: slot, position: { type: ['integer', 'null'], enum: [null, 1, 2, 3, 4, 5] },
      positionSource: { enum: ['opendota-estimate', 'manual', 'unknown'] }, resources: nullableClaim,
      contributions: claims, concerns: claims, counterargument: nullableClaim, limitations,
    }) },
    comparison: nullableClaim,
    selectedPlayers: { type: 'array', maxItems: 2, items: obj({ playerSlot: slot, reasons: { ...claims, minItems: 2 }, roast: text(600) }) },
    closestAlternative: { anyOf: [obj({ playerSlot: slot, reason: claim }), { type: 'null' }] }, limitations,
  }),
  $defs: { claim: obj({ claim: text(600), evidenceIds: { type: 'array', minItems: 1, maxItems: 12, uniqueItems: true, items: { type: 'string', pattern: '^e[1-9][0-9]*$' } } }) },
};

export const portableResponseSchema = structuredClone(responseSchema);
for (const field of [
  portableResponseSchema.$defs.claim.properties.claim,
  portableResponseSchema.properties.selectedPlayers.items.properties.roast,
  portableResponseSchema.properties.playerAssessments.items.properties.limitations.items,
  portableResponseSchema.properties.limitations.items,
]) delete (field as Record<string, unknown>).pattern;
