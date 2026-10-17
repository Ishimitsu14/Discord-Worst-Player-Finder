import { validateAnalysisBundle } from './input.js';
import { createPromptPackage } from './package.js';
import type { AnalysisIdentity, FactsBundle, PreparedAnalysis, PromptPackage } from './types.js';
import { canonical, digest, ensure, object, sha } from './values.js';

export function analysisIdentity(prepared: PreparedAnalysis): AnalysisIdentity {
  const { matchId, side, bundleId, contextDigest, packageId, packageDigest, calibration, responseFormat, requestDigest } = prepared;
  return { matchId, side, bundleId, contextDigest, packageId, packageDigest, calibration, responseFormat, requestDigest };
}

export function prepareAnalysis(input: FactsBundle, inputPackage: PromptPackage): PreparedAnalysis {
  const bundle = validateAnalysisBundle(input);
  ensure(object(inputPackage), 'invalid-package');
  const prompt = createPromptPackage(inputPackage.files, inputPackage.calibrationEvidence);
  ensure(canonical(prompt) === canonical(inputPackage), 'invalid-package');
  ensure(prompt.examples.every(example => example.provenance.matchId !== bundle.context.matchId), 'invalid-example');
  const { profile } = prompt;
  const context = JSON.stringify(bundle.context);
  const body = JSON.stringify({
    model: profile.model, stream: false, temperature: profile.temperature, max_tokens: profile.maxTokens, provider: profile.provider,
    response_format: { type: 'json_schema', json_schema: { name: 'match_analysis_v1', strict: true, schema: prompt.schema } },
    messages: [
      { role: 'system', content: `Пакет инструкции: ${profile.id}; SHA-256 ${prompt.digest}.\n\n${prompt.files['instruction.md']}` },
      ...prompt.examples.flatMap(example => [{ role: 'user', content: JSON.stringify(example.context) }, { role: 'assistant', content: JSON.stringify(example.analysis) }]),
      { role: 'user', content: context },
    ],
  });
  const requestBytes = Buffer.byteLength(body, 'utf8');
  ensure(requestBytes <= profile.maxRequestBytes, 'request-too-large', { bytes: requestBytes, limit: profile.maxRequestBytes });
  return {
    version: 1, matchId: bundle.context.matchId, side: bundle.context.side, bundleId: bundle.manifest.bundleId,
    contextDigest: sha(bundle.context), packageId: profile.id, packageDigest: prompt.digest, calibration: profile.calibration,
    responseFormat: profile.responseFormat, requestDigest: digest(body), prompt, body,
    contextBytes: Buffer.byteLength(context, 'utf8'), requestBytes, estimatedInputTokens: Math.ceil(requestBytes / 2), tokenEstimation: profile.tokenEstimation,
  };
}

export function verifyPreparedAnalysis(prepared: PreparedAnalysis, bundle: FactsBundle): PreparedAnalysis {
  const expected = prepareAnalysis(bundle, prepared.prompt);
  ensure(canonical(prepared) === canonical(expected), 'integrity-error');
  return expected;
}
