import { Ajv } from 'ajv';
import { validateExampleAnalysis } from './analysis.js';
import { portableResponseSchema, responseSchema } from './response-schema.js';
import { AnalysisError, type Example, type PackageFiles, type Profile, type PromptPackage } from './types.js';
import { digest, ensure, object, parse, sha, text } from './values.js';

export const packageNames = ['instruction.md', 'response.schema.json', 'profile.json', 'examples.json'] as const;
const string = { type: 'string', minLength: 1, maxLength: 200, pattern: '^\\S+$' };
const validateProfile = new Ajv().compile({
  type: 'object', additionalProperties: false,
  required: ['version', 'id', 'contextFormat', 'responseFormat', 'model', 'temperature', 'maxTokens', 'maxRequestBytes', 'reasoning', 'tokenEstimation', 'provider', 'calibration', 'calibrationReport'],
  properties: {
    version: { const: 1 }, id: string, contextFormat: { const: 'match-brief-v1' }, responseFormat: { const: 'match-analysis-v1' }, model: { const: 'xiaomi/mimo-v2.6-pro' },
    temperature: { type: 'number', minimum: 0, maximum: 2 }, maxTokens: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    maxRequestBytes: { type: 'integer', minimum: 1, maximum: 262144 }, reasoning: { enum: ['upstream-default', 'disabled'] }, tokenEstimation: { const: 'utf8-bytes-div-2-v1' },
    provider: { type: 'object', additionalProperties: false, required: ['only', 'require_parameters', 'allow_fallbacks'], properties: {
      only: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: '^[a-z0-9-]+(?:/[a-z0-9._-]+)*$' } },
      require_parameters: { const: true }, allow_fallbacks: { type: 'boolean' },
    } },
    calibration: { enum: ['experimental', 'candidate'] }, calibrationReport: { anyOf: [{ type: 'null' }, {
      type: 'object', additionalProperties: false, required: ['path', 'digest'], properties: { path: string, digest: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
    }] },
  },
});

export function createPromptPackage(files: PackageFiles, calibrationEvidence: string | null = null): PromptPackage {
  try {
    ensure(object(files) && Object.keys(files).length === packageNames.length && packageNames.every(name => typeof files[name] === 'string'), 'invalid-package');
    const copy = { ...files };
    ensure(text(copy['instruction.md']), 'invalid-package');
    const profile = parse(copy['profile.json'], 'invalid-package');
    const schema = parse(copy['response.schema.json'], 'invalid-package');
    const examples = parse(copy['examples.json'], 'invalid-package');
    ensure(validateProfile(profile) && object(schema) && [sha(responseSchema), sha(portableResponseSchema)].includes(sha(schema)), 'invalid-package');
    const settings = profile as Profile;
    if (settings.calibration === 'experimental') ensure(settings.calibrationReport === null && calibrationEvidence === null, 'invalid-package');
    else {
      ensure(settings.calibrationReport && typeof calibrationEvidence === 'string' && digest(calibrationEvidence) === settings.calibrationReport.digest, 'invalid-package');
      const report = parse(calibrationEvidence, 'invalid-package');
      ensure(object(report) && report.version === 1 && report.stage === 'candidate' && text(report.reviewsRevision) && object(report.recommendation) && report.recommendation.conclusion === 'candidate', 'invalid-package');
    }
    ensure(object(examples) && Object.keys(examples).length === 2 && examples.version === 1 && Array.isArray(examples.entries), 'invalid-package');
    for (const item of examples.entries) {
      ensure(object(item) && Object.keys(item).length === 3 && object(item.provenance), 'invalid-example');
      const source = item.provenance;
      const keys = ['matchId', 'side', 'snapshotDigest', 'contextDigest', 'split', 'labelRevision', 'reviewRevision'];
      ensure(Object.keys(source).length === keys.length && keys.every(key => Object.hasOwn(source, key)), 'invalid-example');
      ensure(source.split === 'development' && text(source.labelRevision) && text(source.reviewRevision) && /^[a-f0-9]{64}$/.test(String(source.snapshotDigest)), 'invalid-example');
      validateExampleAnalysis(item.analysis, item.context);
      const example = item as unknown as Example;
      ensure(source.matchId === example.context.matchId && source.side === example.context.side && source.contextDigest === sha(example.context), 'invalid-example');
    }
    return { files: copy, digest: sha(packageNames.map(name => [name, digest(copy[name])])), profile: settings, schema, examples: examples.entries as Example[], calibrationEvidence };
  } catch (error) {
    if (error instanceof AnalysisError && ['invalid-package', 'invalid-example'].includes(error.code)) throw error;
    throw new AnalysisError('invalid-package');
  }
}
