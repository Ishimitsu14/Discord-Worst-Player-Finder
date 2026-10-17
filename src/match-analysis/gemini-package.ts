import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { geminiResponseSchema, geminiResponseSchemaV2 } from './gemini-analysis.js';
import { packageNames } from './package.js';
import { AnalysisError, type PackageFiles } from './types.js';
import type { GeminiProfile, GeminiPromptPackage } from './gemini-types.js';
import { canonical, digest, ensure, object, parse, sha, text } from './values.js';

export const geminiProfile: GeminiProfile = {
  version: 1, id: 'gemini-match-v1', contextFormat: 'gemini-compact-v1', responseFormat: 'gemini-match-analysis-v1', model: 'google/gemini-3.8-flash',
  temperature: 0.65, maxTokens: 2048, maxRequestBytes: 32768, reasoning: 'low', timeoutMs: 180000, tokenEstimation: 'utf8-bytes-div-2-v1',
  provider: { only: ['google-ai-studio'], require_parameters: true, allow_fallbacks: false }, calibration: 'experimental', calibrationReport: null,
};
export const geminiProfileV2: GeminiProfile = { ...geminiProfile, id: 'gemini-match-v2', responseFormat: 'gemini-match-analysis-v2' };
export function createGeminiPromptPackage(files: PackageFiles): GeminiPromptPackage {
  try {
    ensure(object(files) && Object.keys(files).length === packageNames.length && packageNames.every(name => typeof files[name] === 'string'), 'invalid-package');
    const copy = { ...files }, profile = parse(copy['profile.json'], 'invalid-package'), schema = parse(copy['response.schema.json'], 'invalid-package');
    const expectedProfile = object(profile) && profile.id === geminiProfileV2.id ? geminiProfileV2 : geminiProfile;
    const expectedSchema = expectedProfile === geminiProfileV2 ? geminiResponseSchemaV2 : geminiResponseSchema;
    ensure(text(copy['instruction.md']) && canonical(profile) === canonical(expectedProfile) && canonical(schema) === canonical(expectedSchema), 'invalid-package');
    ensure(canonical(parse(copy['examples.json'], 'invalid-package')) === canonical({ version: 1, entries: [] }), 'invalid-example');
    return { files: copy, digest: sha(packageNames.map(name => [name, digest(copy[name])])), profile: structuredClone(expectedProfile), schema: structuredClone(expectedSchema) };
  } catch (error) {
    if (error instanceof AnalysisError) throw error;
    throw new AnalysisError('invalid-package');
  }
}
export async function loadGeminiPromptPackage(directory: string): Promise<GeminiPromptPackage> {
  try {
    const files = Object.fromEntries(await Promise.all(packageNames.map(async name => {
      const bytes = await readFile(join(directory, name)), content = bytes.toString('utf8');
      ensure(Buffer.from(content, 'utf8').equals(bytes), 'invalid-package'); return [name, content];
    }))) as PackageFiles;
    return createGeminiPromptPackage(files);
  } catch (error) {
    if (error instanceof AnalysisError) throw error;
    throw new AnalysisError('invalid-package');
  }
}
