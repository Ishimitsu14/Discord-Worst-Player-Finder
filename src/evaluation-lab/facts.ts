import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { prepareMatchFacts, verifyFactsBundle, checkCoverage, checkBriefSize, prepareCompactMatchFacts, verifyCompactFactsBundle, checkCompactSize, renderCompactContext } from '../match-facts/index.js';
import { normalize } from '../match-facts/normalize.js';
import { buildBrief } from '../match-facts/brief.js';
import { buildBriefV2 } from '../match-facts/summaries.js';
import { renderMatchBrief } from '../match-facts/summary.js';
import type { CompactFactsBundle, FactsBundle, FactsBundleV2, FactsOptions, FactsOptionsV2, MatchFactsInput, RoleOverride } from '../match-facts/index.js';
import { validateCorpus } from './corpus.js';
import { atomicWrite, check, digest, json, newDirectory, now, object, parse, positiveInt, readJson, within } from './files.js';
import type { Side } from './types.js';

async function readDictionary(name = 'dotaconstants-v1.json'): Promise<unknown> {
  const dictionaryFile = fileURLToPath(new URL(`../../../evaluation/dictionaries/${name}`, import.meta.url));
  const sourceDictionaryFile = fileURLToPath(new URL(`../../evaluation/dictionaries/${name}`, import.meta.url));
  try { return await readJson(dictionaryFile); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return readJson(sourceDictionaryFile);
  }
}

export async function writeFactsArtifacts(path: string, bundle: FactsBundle | FactsBundleV2 | CompactFactsBundle, diagnostics: Record<string, unknown>, writer = atomicWrite): Promise<Record<string, unknown>> {
  if (bundle.context.format === 'gemini-compact-v1') checkCompactSize(bundle.context); else checkBriefSize(bundle.context);
  const start = performance.now();
  const files: Record<string, string> = {
    'facts.json': JSON.stringify(bundle.facts), 'context.json': JSON.stringify(bundle.context),
    'evidence.json': JSON.stringify(bundle.evidence), 'summary.md': bundle.context.format === 'gemini-compact-v1' ? renderCompactContext(bundle.context) : renderMatchBrief(bundle.context),
  };
  for (const [name, bytes] of Object.entries(files)) await writer(join(path, name), bytes);
  const saved = { ...diagnostics, timings: { ...object(diagnostics.timings), writeMs: performance.now() - start }, writeTimingScope: 'artifact serialization/write through summary; excludes diagnostics/manifest commit' };
  await writer(join(path, 'diagnostics.json'), json(saved));
  await writer(join(path, 'manifest.json'), JSON.stringify(bundle.manifest));
  return saved;
}

interface PrepareFactsOptions { root: string; matchId: number; side: Side; rolesFile?: string; briefFormat?: 'match-brief-v1' | 'match-brief-v2' }
type PrepareCompactOptions = Omit<PrepareFactsOptions, 'briefFormat'> & { briefFormat: 'gemini-compact-v1' };
interface PreparedFacts<T> { path: string; bundle: T; diagnostics: Record<string, unknown> }
export function prepareFacts(options: PrepareCompactOptions): Promise<PreparedFacts<CompactFactsBundle>>;
export function prepareFacts(options: PrepareFactsOptions & { briefFormat: 'match-brief-v2' }): Promise<PreparedFacts<FactsBundleV2>>;
export function prepareFacts(options: PrepareFactsOptions & { briefFormat?: 'match-brief-v1' }): Promise<PreparedFacts<FactsBundle>>;
export function prepareFacts(options: PrepareFactsOptions): Promise<PreparedFacts<FactsBundle | FactsBundleV2>>;
export function prepareFacts(options: PrepareFactsOptions | PrepareCompactOptions): Promise<PreparedFacts<FactsBundle | FactsBundleV2 | CompactFactsBundle>>;
export async function prepareFacts(options: PrepareFactsOptions | PrepareCompactOptions): Promise<PreparedFacts<FactsBundle | FactsBundleV2 | CompactFactsBundle>> {
  check(positiveInt(options.matchId) && ['radiant', 'dire'].includes(options.side), 'Нужны match ID и сторона.');
  check(options.briefFormat === undefined || ['match-brief-v1', 'match-brief-v2', 'gemini-compact-v1'].includes(options.briefFormat), 'Неизвестный формат отчёта.', 'invalid-input');
  const timings: Record<string, number> = {};
  let start = performance.now();
  const corpus = validateCorpus(await readJson(join(options.root, 'corpus.json')));
  const entry = corpus.entries.find(entry => entry.matchId === options.matchId && entry.side === options.side);
  check(entry, 'Снимок матча и стороны отсутствует в локальном корпусе.', 'snapshot-not-found');
  const bytes = await readFile(within(options.root, entry.snapshot));
  check(digest(bytes) === entry.digest, 'Контрольная сумма снимка нарушена.', 'digest-mismatch');
  const input: MatchFactsInput = { matchId: entry.matchId, side: entry.side, data: parse(bytes) };
  let roleOverrides: RoleOverride[] = [];
  if (options.rolesFile) {
    const roles = object(await readJson(resolve(options.rolesFile)));
    check(roles.version === 1 && roles.matchId === entry.matchId && Array.isArray(roles.entries), 'Файл ролей имеет неверный формат или match ID.', 'invalid-role-override');
    roleOverrides = roles.entries as RoleOverride[];
  }
  const dictionary = await readDictionary();
  if (options.briefFormat === 'gemini-compact-v1') {
    const compactOptions = { dictionary, roleOverrides, heroMetricsDictionary: await readDictionary('hero-metrics-v1.json') };
    timings.readAndCheckMs = performance.now() - start;
    start = performance.now(); const bundle = prepareCompactMatchFacts(input, compactOptions); timings.prepareMs = performance.now() - start;
    start = performance.now(); verifyCompactFactsBundle(bundle, input, compactOptions); timings.verifyMs = performance.now() - start;
    const size = checkCompactSize(bundle.context), output = await newDirectory(options.root, 'facts');
    const diagnostics = { version: 1, createdAt: now(), matchId: entry.matchId, side: entry.side, snapshotChecksum: entry.digest, snapshotSource: entry.source, retrievedAt: entry.retrievedAt,
      bundleId: bundle.manifest.bundleId, briefFormat: bundle.context.format, briefProfile: bundle.manifest.profile, factsProfile: bundle.facts.format,
      sizes: { facts: Buffer.byteLength(JSON.stringify(bundle.facts)), brief: size.bytes, core: size.coreBytes, evidence: Buffer.byteLength(JSON.stringify(bundle.evidence)) },
      coverage: bundle.context.coverage, targetBytes: 4096, limitBytes: 16384, targetMet: size.targetMet, limitMet: true, timings, timingNotes: 'Offline only; no network or model latency measured.' };
    return { path: output.path, bundle, diagnostics: await writeFactsArtifacts(output.path, bundle, diagnostics) };
  }
  const factsOptions: FactsOptions | FactsOptionsV2 = { dictionary, roleOverrides, briefFormat: options.briefFormat ?? 'match-brief-v1' };
  timings.readAndCheckMs = performance.now() - start;
  start = performance.now();
  const bundle = prepareMatchFacts(input, factsOptions);
  timings.prepareMs = performance.now() - start;
  start = performance.now();
  const normalized = normalize(input, factsOptions);
  timings.normalizeMs = performance.now() - start;
  start = performance.now();
  const diagnosticBrief = factsOptions.briefFormat === 'match-brief-v2'
    ? buildBriefV2(normalized.facts, normalized.registry, normalized.dictionary)
    : buildBrief(normalized.facts, normalized.registry, normalized.dictionary);
  check(diagnosticBrief.format === bundle.context.format, 'Несогласованный формат диагностического повтора.');
  timings.buildBriefMs = performance.now() - start;
  start = performance.now();
  verifyFactsBundle(bundle, input, factsOptions);
  const coverage = checkCoverage(bundle, input, factsOptions);
  timings.verifyMs = performance.now() - start;
  start = performance.now();
  const sizes = { facts: Buffer.byteLength(JSON.stringify(bundle.facts)), brief: checkBriefSize(bundle.context).bytes, evidence: Buffer.byteLength(JSON.stringify(bundle.evidence)) };
  timings.serializeMs = performance.now() - start;
  const output = await newDirectory(options.root, 'facts');
  const diagnostics = { version: 1, createdAt: now(), matchId: entry.matchId, side: entry.side, snapshotChecksum: entry.digest, snapshotSource: entry.source, retrievedAt: entry.retrievedAt,
    bundleId: bundle.manifest.bundleId, briefFormat: bundle.context.format, briefProfile: bundle.manifest.briefProfile, factsProfile: bundle.manifest.factsProfile,
    diagnosticBriefFormat: diagnosticBrief.format, sizes, coverage, targetMet: checkBriefSize(bundle.context).targetMet, limitMet: true, timings,
    timingNotes: 'normalizeMs/buildBriefMs are a separate diagnostic repeat; prepareMs is the complete public call. No network or model latency measured.',
  };
  const saved = await writeFactsArtifacts(output.path, bundle, diagnostics);
  return { path: output.path, bundle, diagnostics: saved };
}
