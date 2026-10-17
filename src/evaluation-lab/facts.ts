import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { prepareMatchFacts, verifyFactsBundle, checkCoverage, checkBriefSize } from '../match-facts/index.js';
import { normalize } from '../match-facts/normalize.js';
import { buildBrief } from '../match-facts/brief.js';
import { renderMatchBrief } from '../match-facts/summary.js';
import type { FactsBundle, FactsOptions, MatchFactsInput, RoleOverride } from '../match-facts/index.js';
import { validateCorpus } from './corpus.js';
import { atomicWrite, check, digest, json, newDirectory, now, object, parse, positiveInt, readJson, within } from './files.js';
import type { Side } from './types.js';

const dictionaryFile = fileURLToPath(new URL('../../../evaluation/dictionaries/dotaconstants-v1.json', import.meta.url));
const sourceDictionaryFile = fileURLToPath(new URL('../../evaluation/dictionaries/dotaconstants-v1.json', import.meta.url));
async function readDictionary(): Promise<unknown> {
  try { return await readJson(dictionaryFile); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return readJson(sourceDictionaryFile);
  }
}

export async function writeFactsArtifacts(path: string, bundle: FactsBundle, diagnostics: Record<string, unknown>, writer = atomicWrite): Promise<Record<string, unknown>> {
  const start = performance.now();
  const files: Record<string, string> = {
    'facts.json': JSON.stringify(bundle.facts), 'context.json': JSON.stringify(bundle.context),
    'evidence.json': JSON.stringify(bundle.evidence), 'summary.md': renderMatchBrief(bundle.context),
  };
  for (const [name, bytes] of Object.entries(files)) await writer(join(path, name), bytes);
  const saved = { ...diagnostics, timings: { ...object(diagnostics.timings), writeMs: performance.now() - start }, writeTimingScope: 'artifact serialization/write through summary; excludes diagnostics/manifest commit' };
  await writer(join(path, 'diagnostics.json'), json(saved));
  await writer(join(path, 'manifest.json'), JSON.stringify(bundle.manifest));
  return saved;
}

export async function prepareFacts(options: { root: string; matchId: number; side: Side; rolesFile?: string }): Promise<{ path: string; bundle: FactsBundle; diagnostics: Record<string, unknown> }> {
  check(positiveInt(options.matchId) && ['radiant', 'dire'].includes(options.side), 'Нужны match ID и сторона.');
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
  const factsOptions: FactsOptions = { dictionary: await readDictionary(), roleOverrides };
  timings.readAndCheckMs = performance.now() - start;
  start = performance.now();
  const bundle = prepareMatchFacts(input, factsOptions);
  timings.prepareMs = performance.now() - start;
  start = performance.now();
  const normalized = normalize(input, factsOptions);
  timings.normalizeMs = performance.now() - start;
  start = performance.now();
  buildBrief(normalized.facts, normalized.registry, normalized.dictionary);
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
    bundleId: bundle.manifest.bundleId, sizes, coverage, targetMet: checkBriefSize(bundle.context).targetMet, limitMet: true, timings,
    timingNotes: 'normalizeMs/buildBriefMs are a separate diagnostic repeat; prepareMs is the complete public call. No network or model latency measured.',
  };
  const saved = await writeFactsArtifacts(output.path, bundle, diagnostics);
  return { path: output.path, bundle, diagnostics: saved };
}
