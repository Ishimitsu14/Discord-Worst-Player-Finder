import { validateCompactBundle } from '../match-facts/index.js';
import type { CompactFactsBundle } from '../match-facts/index.js';
import { AnalysisError } from './types.js';
import type { GeminiIdentity, GeminiPromptPackage, PreparedGeminiAnalysis } from './gemini-types.js';
import { createGeminiPromptPackage } from './gemini-package.js';
import { canonical, digest, ensure, object, sha } from './values.js';

export function geminiIdentity(prepared: PreparedGeminiAnalysis): GeminiIdentity {
  const { matchId, side, bundleId, contextDigest, packageId, packageDigest, calibration, responseFormat, requestDigest } = prepared;
  return { matchId, side, bundleId, contextDigest, packageId, packageDigest, calibration, responseFormat, requestDigest };
}
export function prepareGeminiAnalysis(input: CompactFactsBundle, inputPackage: GeminiPromptPackage): PreparedGeminiAnalysis {
  let bundle: CompactFactsBundle;
  try { bundle = validateCompactBundle(input); } catch (error) {
    if (object(error) && error.code === 'context-too-large') throw new AnalysisError('context-too-large');
    throw new AnalysisError('integrity-error');
  }
  ensure(object(inputPackage), 'invalid-package');
  const prompt = createGeminiPromptPackage(inputPackage.files);
  ensure(canonical(prompt) === canonical(inputPackage), 'invalid-package');
  const { profile } = prompt, context = JSON.stringify(bundle.context);
  const body = JSON.stringify({ model: profile.model, stream: true, stream_options: { include_usage: true }, temperature: profile.temperature, max_tokens: profile.maxTokens,
    provider: profile.provider, reasoning: { effort: profile.reasoning, exclude: true },
    response_format: { type: 'json_schema', json_schema: { name: profile.responseFormat.replaceAll('-', '_'), strict: true, schema: prompt.schema } },
    messages: [{ role: 'system', content: `Пакет инструкции: ${profile.id}; SHA-256 ${prompt.digest}.\n\n${prompt.files['instruction.md']}` }, { role: 'user', content: context }],
  });
  const requestBytes = Buffer.byteLength(body, 'utf8'); ensure(requestBytes <= profile.maxRequestBytes, 'request-too-large', { bytes: requestBytes, limit: profile.maxRequestBytes });
  return { version: 1, matchId: bundle.manifest.matchId, side: bundle.manifest.side, bundleId: bundle.manifest.bundleId, contextDigest: sha(bundle.context), packageId: profile.id,
    packageDigest: prompt.digest, calibration: 'experimental', responseFormat: profile.responseFormat, requestDigest: digest(body), prompt, body,
    contextBytes: Buffer.byteLength(context, 'utf8'), requestBytes, estimatedInputTokens: Math.ceil(requestBytes / 2), tokenEstimation: profile.tokenEstimation };
}
export function verifyPreparedGeminiAnalysis(prepared: PreparedGeminiAnalysis, bundle: CompactFactsBundle): PreparedGeminiAnalysis {
  const expected = prepareGeminiAnalysis(bundle, prepared.prompt); ensure(canonical(expected) === canonical(prepared), 'integrity-error'); return expected;
}
