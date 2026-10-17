import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Ajv } from 'ajv';
import { buildContext, validateAnalysis, validateDictionary, validateProfile, variantsFor, verifyEvidence } from './context.js';
import { canonicalSlots, validPosition } from './context-v2.js';
import { entryKey, loadSnapshot, validateCorpus, validateLabels, validSide } from './corpus.js';
import { atomicWrite, check, digest, json, newDirectory, now, object, parse, positiveInt, revision, version, within } from './files.js';
import type { Context, Entry, Examples, Experiment, Plan, Raw, RequestEntry, Variant } from './types.js';

export async function prepare(root: string, experimentFile: string): Promise<{ path: string; plan: Plan }> {
  const experimentBytes = await readFile(experimentFile);
  const input = version(parse(experimentBytes));
  check(typeof input.corpus === 'string' && typeof input.labels === 'string' && typeof input.prompt === 'string' && Array.isArray(input.matches) && input.matches.length > 0 && positiveInt(input.repeats) && typeof input.holdoutUntouched === 'boolean', 'Некорректный эксперимент.');
  const experiment = input as unknown as Experiment;
  const corpusBytes = await readFile(resolve(experiment.corpus));
  const corpus = validateCorpus(parse(corpusBytes));
  const snapshots = new Map<string, Raw>();
  for (const entry of corpus.entries) snapshots.set(entryKey(entry), await loadSnapshot(root, entry));
  const labelsBytes = await readFile(resolve(experiment.labels));
  const labels = validateLabels(parse(labelsBytes), corpus, snapshots);
  if (labels.previousRevision !== null) {
    const previous = version(parse(await readFile(within(root, `labels/${labels.previousRevision}.json`))));
    check(previous.revision !== labels.revision, 'Предыдущая и текущая ревизии совпадают.');
    check(Array.isArray(previous.entries), 'Некорректная предыдущая ревизия.');
    for (const label of labels.entries) {
      const old = previous.entries.map(object).find(item => item.matchId === label.matchId && item.side === label.side);
      check(!old?.modelOutputSeen || label.modelOutputSeen, 'Нельзя скрывать просмотр предыдущего ответа модели.');
    }
  }
  await revision(root, 'labels', labels, labelsBytes.toString());
  await revision(root, 'corpora', corpus, corpusBytes.toString());
  const packageFiles: Record<string, Buffer> = {};
  for (const name of ['instruction.md', 'examples.json', 'response.schema.json', 'profile.json']) packageFiles[name] = await readFile(resolve(experiment.prompt, name));
  const profile = validateProfile(parse(packageFiles['profile.json']));
  if (experiment.roleOverrides !== undefined) {
    check(profile.contextVersion === 2 && Array.isArray(experiment.roleOverrides), 'Ручные роли требуют профиля v2.');
    const seen = new Set<string>();
    for (const input of experiment.roleOverrides) {
      const role = object(input);
      const key = `${role.matchId}/${role.playerSlot}`;
      check(positiveInt(role.matchId) && canonicalSlots.includes(Number(role.playerSlot)) && Number.isInteger(role.playerSlot) && validPosition(role.position) && experiment.matches.some(target => target.matchId === role.matchId) && !seen.has(key), 'Некорректное или повторное назначение роли.');
      seen.add(key);
    }
  }
  packageFiles['dictionary.json'] = await readFile(resolve(experiment.prompt, profile.dictionary));
  const dictionary = validateDictionary(parse(packageFiles['dictionary.json']));
  const schema = object(parse(packageFiles['response.schema.json']));
  new Ajv().compile(schema);
  const examples = version(parse(packageFiles['examples.json']));
  check(Array.isArray(examples.entries), 'Некорректные примеры.');
  const safeExamples: { context: Context; analysis: unknown }[] = [];
  for (const example of examples.entries as Examples['entries']) {
    const entry = corpus.entries.find(entry => entry.matchId === example.matchId && entry.side === example.context?.side && entry.digest === example.snapshotDigest);
    check(entry && entry.split === 'development', 'Пример должен происходить из известного development снимка.');
    const label = labels.entries.find(label => entryKey(label) === entryKey(entry));
    check(label && label.status !== 'unlabeled', 'Пример требует ручной разметки.');
    check(!experiment.matches.some(target => target.matchId === entry.matchId), 'Пример взят из целевого матча.');
    check(variantsFor(profile).includes(example.context.variant), 'Неизвестный контекст примера.');
    const expected = buildContext(snapshots.get(entryKey(entry)), entry, example.context.variant, profile, dictionary);
    check(json(expected) === json(example.context), 'Контекст примера не соответствует безопасному преобразованию снимка.');
    validateAnalysis(example.analysis, expected, schema);
    safeExamples.push({ context: expected, analysis: example.analysis });
  }
  const packageDigest = digest(json(Object.fromEntries(Object.entries(packageFiles).map(([name, bytes]) => [name, digest(bytes)]))));
  const artifacts: Record<string, Buffer | string> = {
    'experiment.json': experimentBytes, 'corpus.json': corpusBytes, 'labels.json': labelsBytes,
    ...Object.fromEntries(Object.entries(packageFiles).map(([name, bytes]) => [`package/${name}`, bytes])),
  };
  for (const entry of corpus.entries) artifacts[`snapshots/${entry.digest}.json`] = await readFile(within(root, entry.snapshot));
  const requests: RequestEntry[] = [];
  const used = new Set<string>();
  for (const target of experiment.matches) {
    check(positiveInt(target.matchId) && validSide(target.side), 'Некорректный целевой матч.');
    const key = entryKey(target);
    check(!used.has(key), 'Целевой матч и сторона повторяются.');
    used.add(key);
    const entry = corpus.entries.find(entry => entryKey(entry) === key);
    check(entry, 'Целевой матч отсутствует в корпусе.');
    check(entry.split !== 'holdout' || (!entry.usedForTuning && experiment.holdoutUntouched), 'Нужны неиспользованный holdout и явное подтверждение отсутствия подгонки.');
    const raw = snapshots.get(key)!;
    artifacts[`snapshots/${entry.digest}.json`] = await readFile(within(root, entry.snapshot));
    for (let repeat = 0; repeat < experiment.repeats; repeat++) {
      const variants: Variant[] = repeat % 2 === 0 ? variantsFor(profile) : variantsFor(profile).reverse();
      for (const variant of variants) {
        const context = buildContext(raw, entry, variant, profile, dictionary, experiment.roleOverrides);
        verifyEvidence(context, raw);
        const contextPath = `contexts/${entry.matchId}-${entry.side}-${variant}.json`;
        artifacts[contextPath] = json(context);
        const body = JSON.stringify({
          model: profile.model, stream: false, temperature: profile.temperature, max_tokens: profile.maxTokens,
          provider: profile.provider,
          response_format: { type: 'json_schema', json_schema: { name: profile.analysisVersion === 2 ? 'analysis_v2' : 'analysis_v1', strict: true, schema } },
          messages: [
            { role: 'system', content: packageFiles['instruction.md'].toString('utf8') },
            ...safeExamples.flatMap(example => [{ role: 'user', content: JSON.stringify(example.context) }, { role: 'assistant', content: JSON.stringify(example.analysis) }]),
            { role: 'user', content: JSON.stringify(context) },
          ],
        });
        const bytes = Buffer.byteLength(body);
        check(bytes <= profile.maxRequestBytes, 'context-too-large: запрос превышает предел профиля; создайте новый профиль.', 'context-too-large');
        const index = requests.length;
        const request = `requests/${index}.json`;
        artifacts[request] = body;
        requests.push({ index, matchId: entry.matchId, side: entry.side, split: entry.split, snapshotDigest: entry.digest, variant, repeat, request, context: contextPath, requestDigest: digest(body), bytes, estimatedInputTokens: Math.ceil(bytes / 2) });
      }
    }
  }
  const directory = await newDirectory(root, 'plans');
  const plan: Plan = {
    version: 1, planId: directory.name, createdAt: now(), packageDigest, corpusRevision: corpus.revision, labelsRevision: labels.revision,
    holdoutUntouched: experiment.holdoutUntouched, requests, tokenEstimation: 'utf8-bytes-div-2-v1',
    artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, bytes]) => [name, digest(bytes)])),
  };
  for (const [name, bytes] of Object.entries(artifacts)) await atomicWrite(within(directory.path, name), bytes);
  await atomicWrite(join(directory.path, 'plan.json'), json(plan));
  return { path: directory.path, plan };
}

export async function loadPlan(path: string): Promise<Plan> {
  const plan = version(parse(await readFile(join(path, 'plan.json')))) as unknown as Plan;
  check(typeof plan.planId === 'string' && typeof plan.packageDigest === 'string' && Array.isArray(plan.requests) && plan.requests.length > 0, 'Некорректный план.');
  for (const [name, hash] of Object.entries(object(plan.artifacts))) {
    check(digest(await readFile(within(path, name))) === hash, 'Изменён артефакт плана.', 'digest-mismatch');
  }
  for (const request of plan.requests) {
    check(plan.artifacts[request.request] === request.requestDigest && plan.artifacts[request.context] && plan.artifacts[`snapshots/${request.snapshotDigest}.json`], 'Нет обязательных артефактов плана.');
  }
  return plan;
}
