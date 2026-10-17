import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPromptPackage, prepareAnalysis } from '../../dist/src/match-analysis/index.js';

const directory = process.argv[2];
if (!directory) throw new Error('Pass the directory containing facts.json, context.json, evidence.json and manifest.json');
const bundle = Object.fromEntries(await Promise.all(['facts', 'context', 'evidence', 'manifest'].map(async name => [name, JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8'))])));
const prompt = await loadPromptPackage(process.argv[3] ?? 'analysis/prompts/v1');
const prepared = prepareAnalysis(bundle, prompt);
console.log(JSON.stringify({ matchId: prepared.matchId, side: prepared.side, contextBytes: prepared.contextBytes, requestBytes: prepared.requestBytes, requestDigest: prepared.requestDigest, calibration: prepared.calibration }));
